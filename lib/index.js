/**
 * dsh-plugin-bench — run a command N times, get numbers you can defend.
 *
 * Why this exists: agents (and humans) quote timings from a single run, on a
 * machine whose state nobody wrote down. This tool makes the opposite cheap.
 *
 * What it does
 * ------------
 * warmup (untimed) → N timed runs → best / median / mean / p95 / worst,
 * plus **two** noise measures (spread and coefficient of variation), a diff
 * against the previous run with the same label, an environment fingerprint,
 * and artifacts on disk (`bench-results/<label>-<stamp>.{md,json}`).
 *
 * Design notes
 * ------------
 * * **Warmup is untimed.** First runs pay for page faults, JIT and cold caches;
 *   including them turns a benchmark into a random number generator.
 * * **Two noise measures, because one lies.** `spread = (median-best)/best`
 *   catches "one lucky run"; `cv = std/mean` catches "everything is jittery".
 *   A sample passes only if both are below their limits.
 * * **A timeout is data, a crash is not.** A killed run is recorded with a flag
 *   and keeps the sample count honest; a non-zero exit aborts, because a failing
 *   command is not a slow command.
 * * **The environment goes into the artifact, not into memory.** OS, CPU, cores,
 *   memory, node, git sha, plus an optional probe (e.g. a GPU query).
 * * **Works with or without dsh.** Inside dsh it registers through `defineTool`
 *   (schema validation); standalone (`node demo.mjs`) it registers a plain
 *   definition, so the statistics stay testable without the runtime.
 */

/** Cordis plugin name. */
export const name = 'bench'

/** Required services: the tool registry. */
export const inject = ['tools']

/** Present only inside a dsh profile; absent when running standalone. */
let defineTool = null
try {
  ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch {
  defineTool = null
}

const DEFAULTS = {
  repeats: 3,
  warmup: 1,
  timeoutMs: 300_000,
  outDir: 'bench-results',
  spreadLimitPct: 20,
  cvLimitPct: 10,
}

function resolveConfig(config) {
  const cfg = config ?? {}
  const num = (value, fallback) => (Number.isFinite(value) ? Number(value) : fallback)
  return {
    repeats: num(cfg.repeats, DEFAULTS.repeats) > 0 ? num(cfg.repeats, DEFAULTS.repeats) : DEFAULTS.repeats,
    warmup: num(cfg.warmup, DEFAULTS.warmup) >= 0 ? num(cfg.warmup, DEFAULTS.warmup) : DEFAULTS.warmup,
    timeoutMs: num(cfg.timeoutMs, DEFAULTS.timeoutMs),
    outDir: typeof cfg.outDir === 'string' && cfg.outDir ? cfg.outDir : DEFAULTS.outDir,
    spreadLimitPct: num(cfg.spreadLimitPct, DEFAULTS.spreadLimitPct),
    cvLimitPct: num(cfg.cvLimitPct, DEFAULTS.cvLimitPct),
  }
}

// ---------------------------------------------------------------- statistics

/** Linear-interpolated percentile; `samples` need not be sorted. */
export function percentile(samples, p) {
  if (!samples.length) return 0
  if (!(p >= 0 && p <= 100)) throw new Error(`percentile out of range: ${p}`)
  const ordered = [...samples].sort((a, b) => a - b)
  if (ordered.length === 1) return ordered[0]
  const rank = ((ordered.length - 1) * p) / 100
  const lo = Math.floor(rank)
  const hi = Math.min(lo + 1, ordered.length - 1)
  const w = rank - lo
  return ordered[lo] * (1 - w) + ordered[hi] * w
}

/** Population standard deviation (the sample is the whole measurement). */
export function stdev(samples) {
  if (samples.length < 2) return 0
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  const variance = samples.reduce((acc, x) => acc + (x - mean) ** 2, 0) / samples.length
  return Math.sqrt(variance)
}

/**
 * Summarise wall-clock samples (milliseconds).
 * `spreadPct` answers "how much do I lose by not being lucky".
 * `cvPct` answers "how jittery is this whole measurement".
 */
export function summarize(samples, { timedOut = 0, bytes = 0 } = {}) {
  if (!samples.length) throw new Error('summarize needs at least one sample')
  const ordered = [...samples].sort((a, b) => a - b)
  const best = ordered[0]
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  const sd = stdev(samples)
  return {
    n: samples.length,
    bestMs: round(best),
    medianMs: round(percentile(ordered, 50)),
    meanMs: round(mean),
    p95Ms: round(percentile(ordered, 95)),
    worstMs: round(ordered[ordered.length - 1]),
    spreadPct: best > 0 ? round(((percentile(ordered, 50) - best) / best) * 100) : 0,
    cvPct: mean > 0 ? round((sd / mean) * 100) : 0,
    stdevMs: round(sd),
    timedOut,
    stdoutBytes: bytes,
  }
}

function round(value) {
  return Math.round(value * 100) / 100
}

/** Both noise gates must pass for a sample to be quotable. */
export function verdict(summary, { spreadLimitPct = DEFAULTS.spreadLimitPct, cvLimitPct = DEFAULTS.cvLimitPct } = {}) {
  const spreadBad = summary.spreadPct > spreadLimitPct
  const cvBad = summary.cvPct > cvLimitPct
  return {
    quotable: !spreadBad && !cvBad,
    spreadBad,
    cvBad,
    reason: spreadBad
      ? `spread ${summary.spreadPct}% > ${spreadLimitPct}%: one run was much faster than the rest`
      : cvBad
        ? `cv ${summary.cvPct}% > ${cvLimitPct}%: every run differs, the machine is not steady`
        : `spread ${summary.spreadPct}% and cv ${summary.cvPct}% are both within limits`,
  }
}

// -------------------------------------------------------------- environment

/**
 * Capture what a number is only meaningful inside of.
 * @param options.extraProbe - optional shell command whose stdout is captured
 *   (e.g. a GPU query). Failures are recorded, not thrown.
 */
export async function fingerprint(options = {}) {
  const os = await import('node:os')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)

  const fp = {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
    cores: os.cpus().length,
    memoryGb: round(os.totalmem() / 1024 ** 3),
    node: process.version,
    capturedAt: new Date().toISOString(),
  }

  try {
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: options.cwd ?? '.' })
    fp.gitSha = stdout.trim()
  } catch {
    // not a git repo: omit
  }

  if (options.extraProbe) {
    try {
      const win = process.platform === 'win32'
      const { stdout } = await run(win ? 'cmd' : 'bash', win ? ['/c', options.extraProbe] : ['-lc', options.extraProbe], {
        cwd: options.cwd ?? '.',
        timeout: 20_000,
      })
      fp.extra = stdout.trim().split('\n').slice(0, 4)
    } catch (error) {
      fp.extra = [`probe failed: ${String(error?.message ?? error).slice(0, 120)}`]
    }
  }

  return fp
}

// ------------------------------------------------------------------- runner

/**
 * Run one command and return its wall time.
 * @returns {{ms: number, bytes: number, timedOut: boolean}}
 */
export async function runOnce(command, { cwd = '.', timeoutMs = DEFAULTS.timeoutMs } = {}) {
  const { spawn } = await import('node:child_process')
  const win = process.platform === 'win32'
  const file = win ? 'cmd' : 'bash'
  const argv = win ? ['/c', command] : ['-lc', command]

  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint()
    const child = spawn(file, argv, { cwd, windowsHide: true })
    let stderr = ''
    let bytes = 0
    let timedOut = false

    const finish = (code) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      if (timedOut) {
        resolve({ ms, bytes, timedOut: true })
        return
      }
      if (code !== 0) {
        reject(new Error(`command exited ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`))
        return
      }
      resolve({ ms, bytes, timedOut: false })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8')
    })
    child.stdout?.on('data', (chunk) => {
      bytes += chunk.length // drain, but count: output volume changes timing
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code)
    })
  })
}

// ------------------------------------------------------------------ artifacts

/**
 * Find the most recent previous run with the same label, so a new measurement
 * can be reported as a delta instead of an isolated number.
 */
export async function loadBaseline(dir, labelSlug) {
  const { readdir, readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  const candidates = entries
    .filter((name) => name.startsWith(`${labelSlug}-`) && name.endsWith('.json'))
    .sort()
    .reverse()
  if (!candidates.length) return null
  try {
    const raw = await readFile(join(dir, candidates[0]), 'utf8')
    const parsed = JSON.parse(raw)
    const median = parsed?.summary?.medianMs
    if (!Number.isFinite(median) || median <= 0) return null
    return { file: candidates[0], medianMs: median, bestMs: parsed?.summary?.bestMs, capturedAt: parsed?.env?.capturedAt }
  } catch {
    return null
  }
}

export function deltaPct(current, previous) {
  if (!Number.isFinite(previous) || previous <= 0) return null
  return round(((current - previous) / previous) * 100)
}

// ------------------------------------------------------------------ rendering

export function renderMarkdown({ label, command, summary, env, spreadLimitPct, cvLimitPct, baseline }) {
  const v = verdict(summary, { spreadLimitPct, cvLimitPct })
  const delta = baseline ? deltaPct(summary.medianMs, baseline.medianMs) : null
  const sign = (value) => (value > 0 ? `+${value}` : `${value}`)

  const lines = [
    `### ${label}`,
    '',
    '```',
    command,
    '```',
    '',
    '| metric | value |',
    '| --- | --- |',
    `| runs | ${summary.n} |`,
    `| best | ${summary.bestMs} ms |`,
    `| median | ${summary.medianMs} ms |`,
    `| mean | ${summary.meanMs} ms |`,
    `| p95 | ${summary.p95Ms} ms |`,
    `| worst | ${summary.worstMs} ms |`,
    `| stdev | ${summary.stdevMs} ms |`,
    `| spread (median vs best) | ${summary.spreadPct}% |`,
    `| cv (stdev vs mean) | ${summary.cvPct}% |`,
  ]
  if (delta !== null) {
    lines.push(`| vs previous run | ${sign(delta)}% (${baseline.medianMs} ms → ${summary.medianMs} ms) |`)
  }
  if (summary.timedOut > 0) {
    lines.push(`| timed out runs | ${summary.timedOut} |`)
  }
  if (summary.stdoutBytes > 0) {
    lines.push(`| stdout volume | ${summary.stdoutBytes} bytes |`)
  }
  lines.push('')
  lines.push(
    v.quotable
      ? `> ${v.reason} — quotable.`
      : `> **Not a measurement.** ${v.reason}. Re-run on an idle machine before quoting these numbers.`,
  )
  if (delta !== null) {
    lines.push(
      '',
      delta <= -5
        ? `> ${sign(delta)}% faster than the previous run with the same label (noise floor: check spread above).`
        : delta >= 5
          ? `> ${sign(delta)}% slower than the previous run — a regression candidate, or the machine was busier.`
          : '> Within ±5% of the previous run: no detectable change.',
    )
  }
  lines.push(
    '',
    '<details><summary>environment</summary>',
    '',
    '```json',
    JSON.stringify(env, null, 2),
    '```',
    '',
    '</details>',
    '',
  )
  return lines.join('\n')
}

/** `2026-11-18T11-32-05Z` -- filesystem-safe, sortable. */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/:/g, '-').replace(/\..+$/, 'Z')
}

export function slug(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'bench'
  )
}

// --------------------------------------------------------------------- entry

/**
 * Cordis entry point.
 * @param ctx - mounting context; must expose `tools`.
 * @param config - optional defaults: repeats, warmup, timeoutMs, outDir, spreadLimitPct, cvLimitPct.
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config)

  const definition = {
    name: 'bench',
    description:
      'Run a shell command several times (warmup excluded) and report best/median/mean/p95/worst, ' +
      'spread and coefficient of variation, plus a diff against the previous run with the same label. ' +
      'Captures an environment fingerprint (os, cpu, cores, memory, node, git sha, optional probe) and writes ' +
      'bench-results/<label>-<stamp>.{md,json}. Reports "Not a measurement" when either noise gate fails.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'Shell command to benchmark (non-interactive; stdout is counted but not stored).',
      },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what is being measured, 5-10 words (shown in the UI).',
      },
      label: {
        type: 'string',
        description: 'Name used for artifact files and the table heading. Defaults to a slug of the command.',
      },
      repeats: {
        type: 'number',
        description: `Timed runs (default ${cfg.repeats}). Three exposes instability; five is better for a decision.`,
      },
      warmup: {
        type: 'number',
        description: `Untimed warmup runs (default ${cfg.warmup}).`,
      },
      workdir: {
        type: 'string',
        description: 'Working directory for the command and the artifacts.',
      },
      timeoutMs: {
        type: 'number',
        description: `Kill a single run after this many milliseconds (default ${cfg.timeoutMs}); a timed-out run is recorded, not fatal.`,
      },
      envCommand: {
        type: 'string',
        description:
          'Optional extra probe stored in the fingerprint, e.g. ' +
          '"nvidia-smi --query-gpu=name,memory.total --format=csv,noheader".',
      },
      outDir: {
        type: 'string',
        description: `Directory for artifacts, relative to workdir (default ${cfg.outDir}).`,
      },
    },
    async execute(args) {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const { resolve, join } = await import('node:path')

      const cwd = args.workdir ? resolve(args.workdir) : process.cwd()
      const label = args.label?.trim() || slug(args.command)
      const repeats = args.repeats ?? cfg.repeats
      const warmup = args.warmup ?? cfg.warmup
      const timeoutMs = args.timeoutMs ?? cfg.timeoutMs
      const outDir = args.outDir ?? cfg.outDir
      const dir = join(cwd, outDir)

      for (let i = 0; i < warmup; i += 1) {
        await runOnce(args.command, { cwd, timeoutMs })
      }

      const samples = []
      let timedOut = 0
      let bytes = 0
      for (let i = 0; i < repeats; i += 1) {
        const run = await runOnce(args.command, { cwd, timeoutMs })
        samples.push(run.ms)
        bytes += run.bytes
        if (run.timedOut) timedOut += 1
      }

      const summary = summarize(samples, { timedOut, bytes })
      const env = await fingerprint({ cwd, extraProbe: args.envCommand })
      const baseline = await loadBaseline(dir, slug(label))
      const markdown = renderMarkdown({
        label,
        command: args.command,
        summary,
        env,
        spreadLimitPct: cfg.spreadLimitPct,
        cvLimitPct: cfg.cvLimitPct,
        baseline,
      })

      await mkdir(dir, { recursive: true })
      const base = `${slug(label)}-${stamp()}`
      await writeFile(join(dir, `${base}.md`), markdown, 'utf8')
      await writeFile(
        join(dir, `${base}.json`),
        JSON.stringify({ schema: 1, label, command: args.command, summary, env, samples, baseline }, null, 2),
        'utf8',
      )

      return `${markdown}\nartifacts: ${join(outDir, base)}.{md,json}`
    },
  }

  ctx.tools.register(defineTool ? defineTool(definition) : definition)
}
