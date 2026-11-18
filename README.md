# dsh-plugin-bench

**Benchmark with a fingerprint, not vibes.**

One tool call runs your command a few times, drops the warmup, and gives you
`best / median / p95 / worst` **plus the spread** — and writes the machine it ran on next to the numbers.
If the spread is above a threshold, it says so and refuses to call the result a measurement.

## Why

Agents — and people — quote timings from a single run, on a machine whose state
nobody recorded. Three consequences, all avoidable:

1. **Cold-start numbers get published as steady-state numbers.** First run pays for page faults, JIT, shader
   compilation, filesystem cache. Untimed warmup removes that.
2. **A lucky run becomes "the" number.** Reporting only the best hides that the machine is noisy.
   Reporting only the mean hides a fast path. This tool shows both and computes the gap.
3. **Nobody can reproduce it.** The environment (OS, CPU, cores, memory, node, git sha, optional GPU probe)
   is captured into the artifact, so `README` numbers point at the file that produced them.

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

Real output from `node demo.mjs` on the author's laptop:

```
### demo

node -e "setTimeout(()=>{},30)"

| metric | value |
| --- | --- |
| runs | 5 |
| best | 66.76 ms |
| median | 70.88 ms |
| mean | 74.15 ms |
| p95 | 83.7 ms |
| worst | 85.08 ms |
| spread (median vs best) | 6.17% |

> spread 6.17% ≤ 20% — quotable.
```

…plus an `<details>` block with the environment (`win32 10.0.26200`, CPU model, 24 cores, 31.7 GB, node version,
git sha when inside a repo), and two artifacts:

```
bench-results/demo-2026-11-18T03-28-17Z.md
bench-results/demo-2026-11-18T03-28-17Z.json
```

When the machine is busy, the verdict flips:

> **Not a measurement.** spread 340% > 20%: something else was running, or the workload is bimodal.
> Re-run on an idle machine before quoting these numbers.

## Parameters

| parameter | type | required | meaning |
| --- | --- | --- | --- |
| `command` | string | yes | shell command to time (non-interactive; stdout is drained, not stored) |
| `description` | string | yes | 5–10 word description shown in the UI |
| `label` | string | no | artifact/table name; defaults to a slug of the command |
| `repeats` | number | no | timed runs (default 3) |
| `warmup` | number | no | untimed warmup runs (default 1) |
| `workdir` | string | no | working directory for the command and artifacts |
| `timeoutMs` | number | no | per-run kill timeout (default 300000) |
| `envCommand` | string | no | extra probe stored in the fingerprint, e.g. `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader` |
| `outDir` | string | no | artifacts directory, relative to workdir (default `bench-results`) |

Profile defaults can be set once:

```yaml
# cordis.patch.yml
plugins:
  bench:
    repeats: 5
    warmup: 2
    spreadLimitPct: 15
```

## Design decisions

- **Warmup is untimed.** Including the first run is how a benchmark becomes a random number generator.
- **Best and spread are reported together.** Best answers "what can this machine do"; spread answers "can I trust it".
  The 20% threshold is a default, not a law — set `spreadLimitPct` for tighter work.
- **Artifacts on disk, not chat scrollback.** `bench-results/*.md` is pastable into a README; `*.json` keeps the raw
  samples so someone else can recompute the summary instead of trusting it.
- **stdout is drained, not stored.** Benchmarks of noisy commands would otherwise blow up the result; capture output
  separately if you need it.

## Limits

- Single-process wall clock. No per-phase breakdown (use a profiler for that), no CPU pinning.
- Windows uses `cmd /c`, other platforms use `bash -lc` — different shells, same timing semantics.
- A run that exits nonzero aborts the whole measurement (a failing command is not a slow command).

## Try it without dsh

```bash
node demo.mjs
node demo.mjs --command "python bench/accuracy.py" --repeats 5
node test/smoke.mjs --dry    # statistics + rendering contract only
```

## Roadmap

- [ ] `--per-phase` markers (`::bench:phase`) for coarse phase attribution
- [ ] optional CPU affinity / nice on Linux
- [ ] baseline comparison against a stored artifact

## License

MIT
