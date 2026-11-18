/**
 * Contract + statistics tests. No dsh boot required.
 *
 *   node test/smoke.mjs             # helpers, rendering, and one real run
 *   node test/smoke.mjs --dry       # skip the real run
 */
import {
  apply,
  fingerprint,
  percentile,
  renderMarkdown,
  runOnce,
  slug,
  stamp,
  summarize,
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
const summary = summarize([100, 120, 110])
check('summary n', summary.n, 3)
check('summary best', summary.bestMs, 100)
check('summary median', summary.medianMs, 110)
check('summary spread', summary.spreadPct, 10)
check('summary worst', summary.worstMs, 120)

let threw = false
try { summarize([]) } catch { threw = true }
check('summary rejects empty', threw, true)

// --- slugs and stamps -------------------------------------------------------
check('slug basic', slug('python bench/harness.py'), 'python-bench-harness-py')
check('slug empty', slug('***'), 'bench')
check('stamp is fs-safe', /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(stamp(new Date('2026-11-18T11:32:05Z'))), true)

// --- rendering --------------------------------------------------------------
const markdown = renderMarkdown({
  label: 'demo',
  command: 'echo hi',
  summary: { n: 3, bestMs: 100, medianMs: 110, meanMs: 110, p95Ms: 118, worstMs: 120, spreadPct: 10 },
  env: { platform: 'test', cpu: 'fake', cores: 4, memoryGb: 16, node: 'v20', gitSha: 'abc1234' },
  spreadLimitPct: 20,
})
check('table has best', markdown.includes('| best | 100 ms |'), true)
check('quiet sample is quotable', markdown.includes('quotable'), true)
check('environment embedded', markdown.includes('abc1234'), true)

const noisy = renderMarkdown({
  label: 'noisy', command: 'sleep 0.01',
  summary: { n: 3, bestMs: 10, medianMs: 40, meanMs: 30, p95Ms: 50, worstMs: 50, spreadPct: 300 },
  env: {}, spreadLimitPct: 20,
})
check('noisy sample is called out', noisy.includes('Not a measurement'), true)

// --- registry contract ------------------------------------------------------
let registered = null
apply({ tools: { register: (def) => { registered = def } } }, {})
check('registers one tool', registered?.name, 'bench')
check('command required', registered?.parameters?.command?.required, true)
check('envCommand is optional', registered?.parameters?.envCommand?.required, undefined)

// --- fingerprint ------------------------------------------------------------
const fp = await fingerprint({ extraProbe: 'echo probe-ok' })
check('fingerprint has cores', typeof fp.cores, 'number')
check('fingerprint probe captured', Array.isArray(fp.extra), true)
check('fingerprint probe content', fp.extra?.[0], 'probe-ok')

// --- real run ---------------------------------------------------------------
if (!process.argv.includes('--dry')) {
  const ms = await runOnce('node -e "setTimeout(()=>{},50)"', { timeoutMs: 20_000 })
  console.log(`\nreal run: ${ms.toFixed(1)} ms`)
  check('real run is a number', ms > 0, true)
}

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
