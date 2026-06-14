# History

Append-only run history: one JSONL file per eval-config key (`<key>.jsonl`). Each line records a run's
resolve rate plus the runtime/harness version that produced it -- the durable trail of how a config's
score moves over time. Written via `node scripts/bench.mjs ... --update-history`.

This data is for out-of-band analysis (plotting, trend tracking); the committed
[baselines](../baselines) are what gate regressions. See
[../../../docs/benchmarks.md](../../../docs/benchmarks.md).
