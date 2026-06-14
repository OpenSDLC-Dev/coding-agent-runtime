# Baselines

Committed, human-accepted benchmark baselines: one JSON file per eval-config key, named
`<backend>-<benchmark>-<hash>.json`. A baseline is the resolve rate a given configuration is expected
to meet or beat; `node scripts/bench.mjs ... --compare` exits non-zero when a run drops below it.

Baselines are written **only** by an explicit `--accept`, never automatically, so each file reflects a
reviewed decision. The eval-config key deliberately excludes the runtime/harness version, so a newer
runtime is compared against the same baseline (cross-version regression).

See [../../../docs/benchmarks.md](../../../docs/benchmarks.md) for the full workflow.
