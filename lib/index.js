/**
 * dsh-plugin-bench — run a command N times, get a table you can trust.
 *
 * Why this exists: agents (and humans) report timings from a single run, on a
 * machine whose state nobody wrote down. This tool makes the opposite cheap:
 * it warms up, samples, reports spread, captures an environment fingerprint,
 * and refuses to pretend a noisy sample is a measurement.
 *
 * Design notes
 * ------------
 * * **Warmup runs are not timed.** First runs pay for cold caches, JIT, page
 *   faults; including them turns a benchmark into a random number generator.
 * * **Best-of is the headline, spread is the trust signal.** Reporting only the
 *   best hides instability; reporting only the mean hides a lucky fast path.
 *   Both go in the table, and spread > 20% is called out as not-a-measurement.
 * * **The environment goes into the artifact, not into someone's memory.**
 *   OS, CPU, cores, memory, node version, git sha, plus an optional extra probe
 *   (e.g. `nvidia-smi --query-gpu=name --format=csv,noheader`).
 * * **Artifacts land on disk** (`bench-results/<label>-<stamp>.{md,json}`) so a
 *   claim in a README can point at the file that produced it.
 */

/** Cordis plugin name. */
export const name = 'bench'

/** Required services: the tool registry. */
export const inject = ['tools']

const DEFAULTS = {
  repeats: 3,
  warmup: 1,
  timeoutMs: 300_000,
  outDir: 'bench-results',
  spreadLimitPct: 20,
}

function resolveConfig(config) {
  const cfg = config ?? {}
  return {
    repeats: Number.isFinite(cfg.repeats) && cfg.repeats > 0 ? Number(cfg.repeats) : DEFAULTS.repeats,
    warmup: Number.isFinite(cfg.warmup) && cfg.warmup >= 0 ? Number(cfg.warmup) : DEFAULTS.warmup,
    timeoutMs: Number.isFinite(cfg.timeoutMs) ? Number(cfg.timeoutMs) : DEFAULTS.timeoutMs,
    outDir: typeof cfg.outDir === 'string' && cfg.outDir ? cfg.outDir : DEFAULTS.outDir,
    spreadLimitPct: Number.isFinite(cfg.spreadLimitPct) ? Number(cfg.spreadLimitPct) : DEFAULTS.spreadLimitPct,
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

/**
 * Summarise wall-clock samples (milliseconds).
 * `spreadPct` = (median - best) / best -- how much you lose by not being lucky.
 */
export function summarize(samples) {
  if (!samples.length) throw new Error('summarize needs at least one sample')
  const ordered = [...samples].sort((a, b) => a - b)
  const best = ordered[0]
  const median = percentile(ordered, 50)
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  return {
    n: samples.length,
    bestMs: round(best),
    medianMs: round(median),
    meanMs: round(mean),
    p95Ms: round(percentile(ordered, 95)),
    worstMs: round(ordered[ordered.length - 1]),
    spreadPct: best > 0 ? round(((median - best) / best) * 100) : 0,
  }
}

function round(value) {
  return Math.round(value * 100) / 100
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

  const cpu = os.cpus()[0]?.model?.trim() ?? 'unknown'
  const fp = {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu,
    cores: os.cpus().length,
    memoryGb: round(os.totalmem() / 1024 ** 3),
    node: process.version,
    capturedAt: new Date().toISOString(),
  }

  try {
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: options.cwd ?? '.' })
    fp.gitSha = stdout.trim()
  } catch {
    // not a git repo: fine, just omit
  }

  if (options.extraProbe) {
    try {
      const cmd = process.platform === 'win32' ? 'cmd' : 'bash'
      const argv = process.platform === 'win32' ? ['/c', options.extraProbe] : ['-lc', options.extraProbe]
      const { stdout } = await run(cmd, argv, { cwd: options.cwd ?? '.', timeout: 20_000 })
      fp.extra = stdout.trim().split('\n').slice(0, 4)
    } catch (error) {
      fp.extra = [`probe failed: ${String(error?.message ?? error).slice(0, 120)}`]
    }
  }

  return fp
}

// ------------------------------------------------------------------- runner

/** Run one command (once) and return its wall time in ms. */
export async function runOnce(command, { cwd = '.', timeoutMs = DEFAULTS.timeoutMs } = {}) {
  const { spawn } = await import('node:child_process')
  const win = process.platform === 'win32'
  const file = win ? 'cmd' : 'bash'
  const argv = win ? ['/c', command] : ['-lc', command]

  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint()
    const child = spawn(file, argv, { cwd, windowsHide: true })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`command timed out after ${timeoutMs} ms`))
    }, timeoutMs)

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8')
    })
    child.stdout?.on('data', () => {}) // drain, do not store

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      if (code !== 0) {
        reject(new Error(`command exited ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`))
        return
      }
      resolve(ms)
    })
  })
}

// ------------------------------------------------------------------ rendering

export function renderMarkdown({ label, command, summary, env, spreadLimitPct }) {
  const noisy = summary.spreadPct > spreadLimitPct
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
    `| spread (median vs best) | ${summary.spreadPct}% |`,
    '',
    noisy
      ? `> **Not a measurement.** spread ${summary.spreadPct}% > ${spreadLimitPct}%: something else was running, ` +
        'or the workload is bimodal. Re-run on an idle machine before quoting these numbers.'
      : `> spread ${summary.spreadPct}% ≤ ${spreadLimitPct}% — quotable.`,
    '',
    '<details><summary>environment</summary>',
    '',
    '```json',
    JSON.stringify(env, null, 2),
    '```',
    '',
    '</details>',
    '',
  ]
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
 * @param config - optional defaults: repeats, warmup, timeoutMs, outDir, spreadLimitPct.
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config)

  ctx.tools.register({
    name: 'bench',
    description:
      'Run a shell command several times, warmup excluded, and report best/median/p95/worst plus spread. ' +
      'Captures an environment fingerprint (os, cpu, cores, memory, node, git sha, optional extra probe) ' +
      'and writes bench-results/<label>-<stamp>.{md,json}. Flags spread above a threshold as not a measurement. ' +
      'Use it before quoting any timing number.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'Shell command to benchmark (non-interactive; stdout is drained, not stored).',
      },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what is being measured, 5-10 words (shown in the UI).',
      },
      label: {
        type: 'string',
        description: 'Name used for the artifact files and the table heading. Defaults to a slug of the command.',
      },
      repeats: {
        type: 'number',
        description: `Timed runs (default ${cfg.repeats}). Three is usually enough to expose instability.`,
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
        description: `Kill a single run after this many milliseconds (default ${cfg.timeoutMs}).`,
      },
      envCommand: {
        type: 'string',
        description:
          'Optional extra probe whose stdout is stored in the fingerprint, e.g. ' +
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

      for (let i = 0; i < warmup; i += 1) {
        await runOnce(args.command, { cwd, timeoutMs })
      }

      const samples = []
      for (let i = 0; i < repeats; i += 1) {
        samples.push(await runOnce(args.command, { cwd, timeoutMs }))
      }

      const summary = summarize(samples)
      const env = await fingerprint({ cwd, extraProbe: args.envCommand })
      const markdown = renderMarkdown({
        label,
        command: args.command,
        summary,
        env,
        spreadLimitPct: cfg.spreadLimitPct,
      })

      const dir = join(cwd, outDir)
      await mkdir(dir, { recursive: true })
      const base = `${slug(label)}-${stamp()}`
      await writeFile(join(dir, `${base}.md`), markdown, 'utf8')
      await writeFile(
        join(dir, `${base}.json`),
        JSON.stringify({ label, command: args.command, summary, env, samples }, null, 2),
        'utf8',
      )

      return `${markdown}\nartifacts: ${join(outDir, base)}.{md,json}`
    },
  })
}
