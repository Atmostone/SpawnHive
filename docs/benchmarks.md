# Benchmark Case Store (pre-E-23)

A **file-first** store of reusable *task definitions* (with optional gold signals),
the mirror image of the result slots on `quality_records` (E-01). It lets us curate
benchmark suites now — without waiting for the full public benchmark (E-23) — and
aggregate results by suite × case × model.

> Scope: this is **layers 1 (format) + 2 (loader + linkage)** plus a thin
> **read-only catalogue API** (SPA-54, see below) that the experiment dataset
> picker browses. The registry table, case-store CRUD and public publication are
> still **E-23**. The same case files are what E-23 will index and publish, so
> there is no rework.

## Where cases live

```
backend/benchmarks/<suite>/*.yaml        # or *.yml / *.json
```

Git is the store and its history. One file = one case. Suites currently in the
store:

- `capability-isolation` — hand-authored capability cases (`exact_compute`,
  `fresh_data`, `private_data`, `local_state`).
- `toolathlon` — imported Toolathlon gym tasks (`external_eval` gold, real MCP
  tool environments).
- `toolathlon-open` — open-ended Toolathlon variants.

## Case format

```yaml
id: cap-compute-001                 # unique within the suite
suite: capability-isolation         # must equal the directory name
category: exact_compute             # free label (capability uses: fresh_data|private_data|exact_compute|local_state)
input:
  title: "Multiply 48271 by 92837"
  description: "Return only the exact product."
  context: []                       # reserved: RAG doc refs / attachments (used by E-23)
gold:                               # pluggable gold envelope — each key feeds one eval engine
  capability_spec:                  # E-13: tool(s) the task cannot be solved without
    required_tools: [bash]
    match: all                      # all (default) | any
  reference_answer: "4481..."       # E-03 / outcome correctness (optional)
  rubric: null                      # E-02 rubric ref or inline (optional)
  canonical_trajectory: null        # E-09 (optional)
environment:                        # optional — services/tools the case needs to run
  required_services: [toolathlon_pg]  # backing services the orchestrator must provision
  mcp_servers: [filesystem, terminal] # MCP servers to expose to the agent
repro:                              # optional pins (reproducibility; E-20 seam)
  template_id: null
  model_id: null
  seed: null
meta:
  source: "hand-authored"
  license: "CC0"
  public: false                     # E-23 publication gate
  valid_until: null                 # for categories whose answer expires (fresh_data, local_state)
```

Only `id`, `suite` and `input.title` are required. The `gold` keys are all optional
— a case supplies whatever signals its eval engine needs (the loader maps
`capability_spec` / `reference_answer` / `canonical_trajectory` onto the task; new
keys are added as new eval engines arrive, with no schema migration).

## Running a suite (CLI)

```bash
# list suites
docker compose exec api python -m app.cli.benchmark suites

# materialize a suite into runnable READY task instances (the orchestrator drains them).
# pin a template for determinism; --model overrides the agent model (run_config.model_id);
# --repeat creates K samples per case.
docker compose exec api python -m app.cli.benchmark load \
  --suite capability-isolation --template <template_uuid> [--model <model_uuid>] [--repeat 1]

# watch progress
docker compose exec api python -m app.cli.benchmark status --suite capability-isolation

# run the capability harness (E-13) on terminal instances
docker compose exec api python -m app.cli.benchmark evaluate --suite capability-isolation

# capability_score by model / category for the suite
docker compose exec api python -m app.cli.benchmark aggregate --suite capability-isolation
```

To **compare models**, load the same suite once per model (`--model A`, then
`--model B`) and read `aggregate` — the `by_model` breakdown is the comparison.
Also exposed over HTTP: `GET /api/quality/capability/aggregate?suite=<suite>`.

## Catalogue API (read-only)

`backend/app/api/benchmarks.py` (SPA-54) exposes the file store over HTTP so the
experiment dataset picker (`frontend/src/pages/Experiments.tsx`) can browse suites
and inspect each case's gold signals instead of blind-typing a suite name. Both
endpoints are workspace-scoped and read-only — case authoring stays file-based.

- `GET /api/benchmarks/suites` — list every suite with its case count:
  `[{ "name": "capability-isolation", "n_cases": 30 }, …]`.
- `GET /api/benchmarks/suites/{suite}` — inspect one suite. Returns
  `{ "suite", "n_cases", "cases": [...] }` where each case carries `id`, `title`,
  `category`, `family`, `required_services`, `mcp_servers` and a `gold` map of
  booleans (`reference_answer` / `rubric` / `canonical_trajectory` /
  `capability_spec` / `external_eval`) — which signals are present, **not** the
  gold values. Returns `404` for an unknown suite, `400` for a malformed case file.

## Linkage

Each materialized task carries `benchmark_case_id` / `benchmark_suite`; these are
denormalized onto its `quality_record` (so aggregation survives task deletion).
Migration `e6f7a8b9c0d1`.

## Notes & limits

- **Outcome correctness** for a run reuses the E-02 judge (a scored `reference`
  dimension when the rubric has one — objective and preferred — else the weighted
  score ≥ `capability_outcome_threshold`). For verifiable answers (exact compute,
  private RAG facts), wire a rubric with a `reference` dimension.
- **Expiring categories** (`fresh_data`, `local_state`) need periodic re-curation;
  use `meta.valid_until`.
- **`private_data`** cases need their RAG document ingested into the knowledge base
  before running, so the fact is retrievable but not in pretraining.
