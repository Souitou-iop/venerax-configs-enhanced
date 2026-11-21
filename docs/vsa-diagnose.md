# VSA Diagnose MVP

VSA Diagnose reads an existing VSA `schema_version: 2` JSON report. It compares the report with a compatible baseline, records a sanitized history snapshot, and writes a machine-readable JSON result and a Markdown summary.

It does not run comic source JavaScript. The existing VSA report remains the source of truth for source states, stages, error codes and evidence.

## Local use

Compare two reports directly:

```bash
python scripts/source_assurance.py --diagnose \
  --report path/to/current-vsa.json \
  --against path/to/baseline-vsa.json \
  --output work/vsa/diagnose
```

Use a local history directory and save the current sanitized snapshot:

```bash
python scripts/source_assurance.py --diagnose \
  --report path/to/current-vsa.json \
  --history-dir work/vsa/history/snapshots \
  --run-id local-run-001 \
  --prune-history-days 90 \
  --output work/vsa/diagnose
```

The command writes `diagnose.json` and `diagnose.md`. A valid VSA report with source-level FAIL results still produces a diagnosis and exits with `0`. Invalid input or an incompatible schema exits with `1`. History or filesystem errors exit with `2`.

## Events and comparison

The result can report `FIRST_OBSERVATION`, `NEW_FAILURE`, `PERSISTENT_FAILURE`, `RECOVERED`, `INTERMITTENT`, `ENVIRONMENT_BLOCKED`, `INFRASTRUCTURE_ERROR`, `NOT_COMPARABLE`, `STATE_CHANGED` and `NO_CHANGE`.

The baseline must match the current report's mode, strict flag, runtime build, configuration hash and execution platform family (OS + CPU architecture). GitHub runner kernel and glibc revisions are ignored so routine image rotation does not discard history; the raw platform change is still reported as `platform_changed`. A normal repository `source_commit` change does not block comparison. A changed `runner_build_id` is recorded as a clue while the report remains comparable. Runtime, configuration, mode or environment-family changes produce `NOT_COMPARABLE` with a reason.

Each event carries observed facts, a bounded hypothesis, confidence and up to three next checks. A hypothesis never replaces the original VSA state or evidence.

## Daily Actions flow

The scheduled and manual Source Assurance workflow keeps the strict VSA result. It uploads the raw VSA report even when the live command returns a nonzero status. A read-only Diagnose job then creates the daily Markdown summary and a sanitized snapshot. A separate archive job runs only for scheduled or manual trusted runs and writes snapshots to the `vsa-history` branch with `contents: write`.

The Live job that executes community JavaScript has `contents: read` and receives no history write credential. Pull request runs do not write the history branch. The archive stores snapshots for 90 days and uses the VSA run ID as an idempotency key.

## Stored data

History files use `diagnose_history_schema_version: 1`. They contain source keys, states, verification levels, stage and error codes, selected structured evidence, runtime and runner context, configuration hash, source SHA and report integrity data.

Cookie values, Authorization headers, tokens, signed URLs, complete response bodies, complete HTML, full stack traces and user data are excluded. Unknown or malformed history files are skipped and do not replace the previous baseline.

## Known limits

The first run has no baseline and produces `FIRST_OBSERVATION`. A real source failure can be classified only to the level supported by the stored evidence. Layer 1 health data is not used to prove Layer 2 success in this MVP. Runner cross-stage memory, DNS TOCTOU and other existing VSA boundaries remain unchanged.
