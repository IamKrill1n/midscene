# AndroidWorld benchmark harness

Minimal, emulator-native runner that benchmarks Midscene against
[AndroidWorld](https://github.com/google-research/android_world) with the
official task objects and validators kept authoritative.

## Layout

- `run.ts` — Node runner. Per task it calls bridge `init_task`, drives the UI
  with a fresh `AndroidAgent` (`aiAct` with DeepThink), reads QA answers with
  `aiAsk` and forwards them via `submit_answer`, then scores with bridge
  `score_task` / `teardown_task`. Appends `results.jsonl` and writes
  `summary.json` (Pass@1/2/3).
- `androidworld_bridge.py` — stdio JSON-lines bridge to AndroidWorld:
  `hello`, `list_tasks`, `init_task`, `score_task`, `teardown_task`,
  `submit_answer`, `quit`. Imports `android_world` lazily.
- `scoring.ts` — pure helpers (arg parsing, round scheduling, Pass@k math)
  covered by `tests/unit-test/androidworld-benchmark.test.ts`.
- `smoke.config.json` — three-task smoke selection.
- `stability-patches.md` — patch map mirroring the official report tables.

## Run

```bash
# From this directory. Emulator must already be running; see the benchmark guide.
npx tsx run.ts --config=smoke.config.json
npx tsx run.ts --tasks=ContactsAddContact --rounds=1
npx tsx run.ts --tasks=ContactsAddContact,ClockStopWatchRunning --rounds=3 --resume
```

Options: `--tasks=A,B`, `--rounds=1-3`, `--suite=android_world`,
`--output=dir`, `--resume`, `--task-timeout-ms=N`, `--cycle-limit=N`,
`--config=path`. Round 1 runs every selected task; rounds 2-3 retry only
tasks without a passing attempt. A validator score above `0.5` counts as a
pass. When `android_world` is installed into a virtualenv, point the runner
at it with `MIDSCENE_ANDROIDWORLD_PYTHON=/path/to/venv/bin/python`.

## Full guide

`apps/site/docs/en/android-world-benchmark-guide.mdx` (and the `zh/`
counterpart) covers emulator setup, model configuration, patch application,
scoring, evidence, and troubleshooting.
