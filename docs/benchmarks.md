# Benchmarks — operator guide

The repo ships a benchmark harness (`apps/bench`, the `@app/bench` package) that measures the
runtime's coding ability against standard benchmarks. This is the full operator reference; the
[README "Benchmarking" note](../README.md#benchmarking) is the short overview.

> ⚠️ **The harness is an external orchestrator, not part of the runtime.** It drives the runtime as a
> black box over the public HTTP/SSE contract and scores **out-of-band**. It never enters the hardened
> runtime container, never touches its security perimeter, and is not an extension. The runtime under
> test holds the model credentials; the harness needs none.

## Two benchmarks

| Benchmark    | `--benchmark` | Data            | Scoring                          | External setup |
| ------------ | ------------- | --------------- | -------------------------------- | -------------- |
| hello-bench  | `hello-bench` | in-repo toy tasks | local `check` (no Docker/network) | none           |
| SWE-bench    | `swe-bench`   | SWE-bench Lite (curated subset) | official `swebench` Docker harness | git, a dataset file, python + Docker + `swebench` |

`hello-bench` is the zero-setup smoke test (see the README). The rest of this guide is about
`swe-bench`.

## How a SWE-bench run flows

```
apps/bench/subsets/swebench-lite-curated.json   (committed: instance ids only)
  + the operator-downloaded dataset file         (--dataset / RUNTIME_SWEBENCH_DATASET: full records)
       └─ adapter.load(): select the curated subset → BenchInstance[]
  per instance (sequential):
       resetWorkspace → prepare(): shallow-fetch <repo> @ <base_commit> by SHA into the workspace
         → drive one turn (POST /sessions) → collect `git diff` (vs the pinned base) = model_patch
         → remove .git (so the next reset's repo-guard is clean)
  after the loop (batch, once):
       write predictions.json → python -m swebench.harness.run_evaluation
         → read <model>.<run_id>.json (resolved_ids/unresolved_ids/error_ids)
         → fold per-instance verdicts into the RunReport
```

Two properties make this honest and reproducible:

- **The repo commits only the curated id-list**, never the issue text or gold patches. The full
  records (problem statement, base commit, gold/test patches, `FAIL_TO_PASS`/`PASS_TO_PASS`) come from
  the dataset file you download. A curated id missing from your dataset fails the run loudly.
- **Scoring is the official harness, not a re-implementation.** We only produce the predictions file
  in the standard format (`instance_id` / `model_name_or_path` / `model_patch`); the `swebench`
  package decides resolved/unresolved exactly as the public leaderboard does.

## Prerequisites (you install these; none enter the container)

| Need              | Why                                            | Install                                                                 |
| ----------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| `git`             | clone each repo at its `base_commit`           | system git on `PATH`                                                    |
| a dataset file    | full SWE-bench Lite records                    | download once from HuggingFace (below)                                  |
| `python`          | run the scorer                                 | system python on `PATH`                                                 |
| `swebench`        | the authoritative Docker grader                | `pip install swebench`                                                  |
| Docker            | the grader runs each instance in a container   | Docker daemon, x86_64 (arm64 experimental)                             |

### Download the dataset file

The harness reads a local JSON array of records. Produce it once from HuggingFace, e.g.:

```python
from datasets import load_dataset
import json
ds = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")
json.dump(list(ds), open("swe-bench-lite.json", "w"))
```

Point the harness at it with `--dataset swe-bench-lite.json` (or `RUNTIME_SWEBENCH_DATASET`); the
adapter reads it to build the prompts. By default the grader scores against the **same file**
(`--dataset-name` defaults to your `--dataset`), so the agent and the grader see identical records,
including `FAIL_TO_PASS`/`test_patch` at scoring time. Override `--dataset-name` with a HuggingFace id
(e.g. `princeton-nlp/SWE-bench_Lite`) only if you want the grader to load from HF instead — make sure
it is the same revision as your local file, or the agent and grader will disagree on the records.

## Run it

Start the runtime, then point the harness at a **dedicated** workspace (its contents are wiped between
instances — never a repo checkout; a `.git` at its root is refused as a safety net):

```
node scripts/bench.mjs \
  --benchmark swe-bench \
  --base-url http://127.0.0.1:8080 \
  --workspace /path/to/RUNTIME_CWD \
  --dataset swe-bench-lite.json \
  --out report.json
```

| Flag             | Default                              | Meaning                                                        |
| ---------------- | ------------------------------------ | ------------------------------------------------------------- |
| `--dataset`      | `RUNTIME_SWEBENCH_DATASET`           | local dataset file (required for `swe-bench`)                  |
| `--subset`       | `apps/bench/subsets/swebench-lite-curated.json` | curated instance-id list                            |
| `--dataset-name` | same as `--dataset`                  | what the grader loads (`--dataset_name`); a local file or a HF id |
| `--split`        | (unset)                              | forwarded to the grader as `--split`                          |
| `--run-id`       | `swe-bench-<timestamp>`              | names the run + grader log dir (safe charset only)            |
| `--report-dir`   | `./.bench-reports`                   | the grader's working dir; `predictions.json`, its report, and its `logs/` land here |
| `--model-name`   | the `--model` value, else `coding-agent-runtime` | `model_name_or_path` in predictions + report filename (safe charset) |
| `--out`          | (none)                               | write the final `RunReport` JSON here                         |

## Reading the report

The harness prints `resolved/total (rate), turns, $cost` and (with `--out`) writes a versioned
`RunReport`. Per-instance `status` is one of `resolved` / `unresolved` / `errored` / `timeout`:

- `resolved` / `unresolved` come from the grader's `resolved_ids` / `unresolved_ids`.
- An **empty patch** (the agent changed nothing) counts as `unresolved` — SWE-bench scores a no-op
  against you, the same as a wrong fix.
- `errored` is a turn that did not complete, a grader error, or an instance missing from the report;
  `timeout` is an aborted turn. Both fold into the summary's `errored` bucket.

## Behind a slow or blocked Docker Hub / PyPI / HuggingFace

The grader's Docker images are the heavy part. The often-quoted ~120 GB is for a **full** 300-instance
run; the curated 5-instance subset only needs a base image plus a handful of env/instance images (tens
of GB). If your network to these registries is slow:

- **Docker images** — either configure a registry mirror (`registry-mirrors` in
  `/etc/docker/daemon.json`) to accelerate the prebuilt `swebench/*` images, or let the grader **build
  images locally** (the default when no prebuilt namespace is used), which avoids large image pulls and
  relies only on a base image plus package installs.
- **Python packages** — point `pip`/`conda` at a local package mirror; this makes the build-locally
  path reliable even when Docker Hub is not.
- **The dataset** — set `HF_ENDPOINT` to a HuggingFace mirror before `load_dataset`.

## Scope and roadmap

E1 ships the SWE-bench adapter + the offline Docker scorer. Deliberately deferred:

- The **hosted `sb-cli` scorer** (no local Docker) — planned, gated on one real submission to confirm
  its report exposes per-instance ids (the public client only documents aggregate counts).
- A **config-tuple baseline + regression tracking** (the next milestone) — committed baselines keyed by
  the run's config, a `compare` regression gate, and a generated `BENCHMARKS.md`.
- **Parallel multi-container sharding**, SWE-bench Verified, and Aider Polyglot.
