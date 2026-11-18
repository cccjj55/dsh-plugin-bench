/**
 * Contract + statistics tests. No dsh boot required.
 *
 *   node test/smoke.mjs            # helpers, rendering, fingerprint, one real run
 *   node test/smoke.mjs --dry      # skip the real run
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  deltaPct,
  fingerprint,
  loadBaseline,
  percentile,
  renderMarkdown,
  runOnce,
  slug,
  stamp,
  stdev,
  summarize,
  verdict,
} from '../lib/index.js'

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.error(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

// --- percentiles ------------------------------------------------------------
check('percentile empty', percentile([], 50), 0)
check('percentile single', percentile([5], 95), 5)
check('percentile median', percentile([0, 10], 50), 5)
check('percentile max', percentile([1, 2, 3, 4], 100), 4)
check('percentile unsorted', percentile([4, 1, 3, 2], 0), 1)

// --- summary ----------------------------------------------------------------
const quiet = summarize([100, 110, 120])
check('summary n', quiet.n, 3)
check('summary best', quiet.bestMs, 100)
check('summary median', quiet.medianMs, 110)
check('summary spread', quiet.spreadPct, 10)
check('summary worst', quiet.worstMs, 120)
check('summary stddev', quiet.stdevMs, 8.16)
check('summary cv', quiet.cvPct, 7.42)
check('summary timedOut default', quiet.timedOut, 0)

const jittery = summarize([100, 200, 300])
check('jittery spread', jittery.spreadPct, 100)
check('jittery cv', jittery.cvPct, 40.82)

let threw = false
try { summarize([]) } catch { threw = true }
check('summary rejects empty', threw, true)
check('stdev of one sample', stdev([42]), 0)

// --- noise verdict ----------------------------------------------------------
check('quiet sample quotable', verdict(quiet).quotable, true)
check('spread gate fires', verdict(jittery).spreadBad, true)
check('spread gate reason', verdict(jittery).reason.includes('one run was much faster'), true)

const steadyNoise = summarize([100, 104, 96, 102])   // low spread, moderate cv
check('cv gate evaluated', typeof verdict(steadyNoise, { cvLimitPct: 1 }).cvBad, 'boolean')
check('tight cv gate flags steady-ish sample', verdict(steadyNoise, { cvLimitPct: 0.1 }).quotable, false)

// --- deltas and baselines ---------------------------------------------------
check('delta faster', deltaPct(90, 100), -10)
check('delta slower', deltaPct(120, 100), 20)
check('delta guard', deltaPct(10, 0), null)

const dir = await mkdtemp(join(tmpdir(), 'bench-'))
await mkdir(join(dir, 'bench-results'), { recursive: true })
await writeFile(
  join(dir, 'bench-results', 'demo-2026-11-18T10-00-00Z.json'),
  JSON.stringify({ schema: 1, summary: { medianMs: 80, bestMs: 78 } }),
  'utf8',
)
const baseline = await loadBaseline(join(dir, 'bench-results'), 'demo')
check('baseline found', baseline?.medianMs, 80)
check('baseline ignores other labels', await loadBaseline(join(dir, 'bench-results'), 'other'), null)
check('baseline missing dir', await loadBaseline(join(dir, 'nope'), 'demo'), null)

// --- slugs and stamps -------------------------------------------------------
check('slug basic', slug('python bench/harness.py'), 'python-bench-harness-py')
check('slug empty', slug('***'), 'bench')
check('stamp is fs-safe', /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(stamp(new Date('2026-11-18T11:32:05Z'))), true)

// --- rendering --------------------------------------------------------------
const markdown = renderMarkdown({
  label: 'demo',
  command: 'echo hi',
  summary: quiet,
  env: { platform: 'test', cpu: 'fake', cores: 4, memoryGb: 16, node: 'v20', gitSha: 'abc1234' },
  spreadLimitPct: 20,
  cvLimitPct: 10,
})
check('table has best', markdown.includes('| best | 100 ms |'), true)
check('table has cv', markdown.includes('| cv (stdev vs mean) | 7.42% |'), true)
check('quiet sample quotable', markdown.includes('quotable'), true)
check('environment embedded', markdown.includes('abc1234'), true)
check('no delta row without baseline', markdown.includes('vs previous run'), false)

const withBaseline = renderMarkdown({
  label: 'demo', command: 'echo hi', summary: quiet,
  env: {}, spreadLimitPct: 20, cvLimitPct: 10, baseline: { medianMs: 80 },
})
check('delta row rendered', withBaseline.includes('| vs previous run | +37.5%'), true)
check('regression sentence', withBaseline.includes('slower than the previous run'), true)

const noisy = renderMarkdown({
  label: 'noisy', command: 'sleep 0.01', summary: jittery, env: {}, spreadLimitPct: 20, cvLimitPct: 10,
})
check('noisy sample is called out', noisy.includes('Not a measurement'), true)

// --- registry contract ------------------------------------------------------
let registered = null
apply({ tools: { register: (def) => { registered = def } } }, {})
check('registers one tool', registered?.name, 'bench')
check('command required', registered?.parameters?.command?.required, true)
check('envCommand optional', registered?.parameters?.envCommand?.required, undefined)
check('timeout described as recorded', registered?.parameters?.timeoutMs?.description.includes('recorded'), true)

// --- fingerprint ------------------------------------------------------------
const fp = await fingerprint({ extraProbe: 'echo probe-ok' })
check('fingerprint has cores', typeof fp.cores, 'number')
check('fingerprint probe content', fp.extra?.[0], 'probe-ok')

// --- real run ---------------------------------------------------------------
if (!process.argv.includes('--dry')) {
  const run = await runOnce('node -e "setTimeout(()=>{},50)"', { timeoutMs: 20_000 })
  console.log(`\nreal run: ${run.ms.toFixed(1)} ms, ${run.bytes} bytes, timedOut=${run.timedOut}`)
  check('real run returns ms', run.ms > 0, true)
  check('real run not timed out', run.timedOut, false)

  // a script file instead of `node -e "..."`: no shell quoting, works on cmd and bash
  const sleeper = join(dir, 'sleeper.mjs')
  await writeFile(sleeper, 'setTimeout(() => {}, 5000)', 'utf8')
  const killed = await runOnce(`node ${sleeper}`, { timeoutMs: 500 })   // temp path has no spaces
  check('timeout is recorded, not thrown', killed.timedOut, true)
  check('timeout still yields a duration', killed.ms >= 400, true)
}

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
