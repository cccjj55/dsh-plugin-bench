# dsh-plugin-bench

**Benchmark with a fingerprint, not vibes.**

One tool call runs your command a few times, drops the warmup, and gives you
`best / median / p95 / worst` **plus two noise measures**, a **diff against the previous run**,
and the machine it ran on. If the sample is too noisy it says so and refuses to call it a measurement.

## Why

Agents — and people — quote timings from a single run, on a machine whose state nobody recorded.
Four consequences, all avoidable:

1. **Cold starts get published as steady state.** The first run pays for page faults, JIT, caches. Untimed warmup removes it.
2. **A lucky run becomes "the" number.** Reporting only the best hides instability; reporting only the mean hides a fast path.
3. **"Slightly faster" is claimed without a noise floor.** Without a previous run to compare against, a 5% change is indistinguishable from jitter.
4. **Nobody can reproduce it.** The environment is captured into the artifact, so a README number points at the file that produced it.

## Install

```bash
# 1) add the package (forwards to pnpm inside the profile directory)
dsh plugin --profile web add github:cccjj55/dsh-plugin-bench

# 2) enable the bundle: add the name to dsh.profile.bundles
#    in $DSH_HOME/profiles/web/package.json
```

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-plugin-bench"]
    }
  }
}
```

## What it looks like

Real output, second run in the same directory (so the delta row appears):

```
### demo

node -e "setTimeout(()=>{},30)"

| metric | value |
| --- | --- |
| runs | 5 |
| best | 75.23 ms |
| median | 77.16 ms |
| mean | 76.71 ms |
| p95 | 77.56 ms |
| worst | 77.59 ms |
| stdev | 0.9 ms |
| spread (median vs best) | 2.57% |
| cv (stdev vs mean) | 1.17% |
| vs previous run | +1.65% (75.91 ms → 77.16 ms) |

> spread 2.57% and cv 1.17% are both within limits — quotable.

> Within ±5% of the previous run: no detectable change.
```

Busy machine, same command — the verdict flips:

> **Not a measurement.** spread 340% > 20%: one run was much faster than the rest.
> Re-run on an idle machine before quoting these numbers.

Artifacts:

```
bench-results/demo-2026-11-18T03-41-12Z.md
bench-results/demo-2026-11-18T03-41-12Z.json   # raw samples + fingerprint + schema: 1
```

## Two noise gates

| gate | formula | catches |
| --- | --- | --- |
| `spread` | `(median − best) / best` | one lucky run inflating the headline |
| `cv` | `stdev / mean` | everything jittery, no single outlier |

A sample is quotable only if **both** are under their thresholds (defaults 20% / 10%).
One gate alone lies in a predictable way: a run with a single 10× outlier and a run where every
sample wobbles by 10% are different problems, and they need different fixes.

## Regression detection

Each run compares its median against the most recent artifact with the **same label**:

- `≤ −5%` → "faster than the previous run (check the noise floor)"
- `±5%` → "no detectable change" ← the sentence that stops people from claiming noise as a win
- `≥ +5%` → "regression candidate, or the machine was busier"

This is the feature that turns a one-off measurement into a workflow: run it before and after a change.

## Parameters

| parameter | type | required | meaning |
| --- | --- | --- | --- |
| `command` | string | yes | shell command to time (non-interactive; stdout is counted, not stored) |
| `description` | string | yes | 5–10 word description shown in the UI |
| `label` | string | no | artifact/table name; defaults to a slug of the command |
| `repeats` | number | no | timed runs (default 3) |
| `warmup` | number | no | untimed warmup runs (default 1) |
| `workdir` | string | no | working directory for the command and artifacts |
| `timeoutMs` | number | no | per-run kill timeout (default 300000); a timed-out run is **recorded**, not fatal |
| `envCommand` | string | no | extra probe stored in the fingerprint, e.g. `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader` |
| `outDir` | string | no | artifacts directory, relative to workdir (default `bench-results`) |

Profile defaults:

```yaml
# cordis.patch.yml
plugins:
  bench:
    repeats: 5
    warmup: 2
    spreadLimitPct: 15
    cvLimitPct: 8
```

## Design decisions

- **Warmup is untimed.** Including the first run is how a benchmark becomes a random number generator.
- **A timeout is data; a crash is not.** A killed run is recorded with `timedOut` and keeps `n` honest.
  A non-zero exit aborts the measurement — a failing command is not a slow command.
- **stdout is counted, not stored.** Output volume itself changes timing; storing it would blow up the result.
- **Works with or without dsh.** Inside dsh it registers through `defineTool` (schema validation);
  standalone it registers a plain definition, so the statistics remain testable with `node demo.mjs`.

## Limits

- Single-process wall clock. No per-phase attribution (use a profiler), no CPU pinning.
- Windows runs through `cmd /c`; **quote paths with spaces yourself** (`node "C:\my dir\x.js"`).
- A failing command aborts the run: this tool measures speed, not flakiness.

## Try it without dsh

```bash
node demo.mjs                                        # writes bench-results/
node demo.mjs --command "python bench/accuracy.py" --repeats 5
node test/smoke.mjs --dry                            # statistics + rendering contract
```

## Roadmap

- [x] noise verdict (spread + cv) and "not a measurement" banner
- [x] diff against the previous run with the same label (regression detection)
- [x] timeout recorded instead of fatal
- [ ] `::bench:phase` markers for coarse phase attribution
- [ ] `bench compare a.json b.json` CLI for CI use
- [ ] GitHub Actions example that posts the table on a PR

## License

MIT
