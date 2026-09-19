/**
 * Pure scoring and CLI helpers for the AndroidWorld benchmark harness.
 *
 * This module has no device or model dependencies so it can be unit tested
 * without an emulator. The runner (`run.ts` in the same directory) imports
 * these helpers and adds the AndroidAgent wiring.
 */

export interface AndroidWorldTaskResult {
  /** AndroidWorld task name, e.g. `ContactsAddContact`. */
  task: string;
  /** 1-based benchmark round. Round 1 runs every task; later rounds retry failures. */
  round: number;
  /** Raw validator score returned by the bridge (`score_task`). */
  score: number;
  /** Whether the validator score counts as a pass. */
  passed: boolean;
  /** Native Midscene HTML report file for this attempt, when available. */
  reportFile?: string;
}

export interface RoundSummary {
  round: number;
  total: number;
  passed: number;
  failed: number;
}

export interface PassAtKSummary {
  /** Number of distinct tasks in the suite run. */
  total: number;
  passAt1: number;
  passAt1Rate: number;
  passAt2: number;
  passAt2Rate: number;
  passAt3: number;
  passAt3Rate: number;
}

export interface BenchmarkRunOptions {
  tasks: string[];
  rounds: number;
  suiteFamily: string;
  outputDir: string;
  resume: boolean;
  taskTimeoutMs: number;
  cycleLimit: number;
}

/** Validator scores above this threshold count as a pass. */
export const ANDROIDWORLD_PASS_THRESHOLD = 0.5;

export const DEFAULT_ROUNDS = 3;

export const DEFAULT_SUITE_FAMILY = 'android_world';

export const DEFAULT_CYCLE_LIMIT = 120;

export function isPass(score: number): boolean {
  return score > ANDROIDWORLD_PASS_THRESHOLD;
}

function splitTaskList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseArgs(argv: string[]): BenchmarkRunOptions {
  const options: BenchmarkRunOptions = {
    tasks: [],
    rounds: DEFAULT_ROUNDS,
    suiteFamily: DEFAULT_SUITE_FAMILY,
    outputDir: 'midscene_run/androidworld',
    resume: false,
    taskTimeoutMs: 600_000,
    cycleLimit: DEFAULT_CYCLE_LIMIT,
  };

  for (const arg of argv) {
    if (arg.startsWith('--tasks=')) {
      options.tasks = splitTaskList(arg.slice('--tasks='.length));
    } else if (arg.startsWith('--rounds=')) {
      const rounds = Number.parseInt(arg.slice('--rounds='.length), 10);
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) {
        throw new Error(
          `--rounds must be an integer between 1 and 3, got "${arg}".`,
        );
      }
      options.rounds = rounds;
    } else if (arg.startsWith('--suite=')) {
      options.suiteFamily = arg.slice('--suite='.length).trim();
    } else if (arg.startsWith('--output=')) {
      options.outputDir = arg.slice('--output='.length).trim();
    } else if (arg.startsWith('--task-timeout-ms=')) {
      const timeout = Number.parseInt(
        arg.slice('--task-timeout-ms='.length),
        10,
      );
      if (!Number.isInteger(timeout) || timeout <= 0) {
        throw new Error(
          `--task-timeout-ms must be a positive integer, got "${arg}".`,
        );
      }
      options.taskTimeoutMs = timeout;
    } else if (arg.startsWith('--cycle-limit=')) {
      const limit = Number.parseInt(arg.slice('--cycle-limit='.length), 10);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error(
          `--cycle-limit must be a positive integer, got "${arg}".`,
        );
      }
      options.cycleLimit = limit;
    } else if (arg === '--resume') {
      options.resume = true;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(
        'Usage: run.ts [--tasks=A,B] [--rounds=1-3] [--suite=android_world] [--output=dir] [--resume] [--task-timeout-ms=N] [--cycle-limit=N]',
      );
    } else {
      throw new Error(`Unknown argument "${arg}".`);
    }
  }

  if (options.suiteFamily.length === 0) {
    throw new Error('--suite must not be empty.');
  }
  if (options.outputDir.length === 0) {
    throw new Error('--output must not be empty.');
  }

  return options;
}

/**
 * Restrict the suite task list to an explicit selection.
 * An empty selection means "run the whole suite".
 */
export function filterTasks(allTasks: string[], only: string[]): string[] {
  if (only.length === 0) {
    return [...allTasks];
  }
  const wanted = new Set(only);
  return allTasks.filter((task) => wanted.has(task));
}

/**
 * Decide which tasks run in a given round. Round 1 runs everything;
 * later rounds retry only tasks without a passing attempt so far.
 */
export function tasksForRound(
  allTasks: string[],
  results: AndroidWorldTaskResult[],
  round: number,
): string[] {
  if (round <= 1) {
    return [...allTasks];
  }
  const passed = new Set(
    results.filter((result) => result.passed).map((result) => result.task),
  );
  return allTasks.filter((task) => !passed.has(task));
}

export function summarizeByRound(
  results: AndroidWorldTaskResult[],
): RoundSummary[] {
  const byRound = new Map<number, RoundSummary>();
  for (const result of results) {
    const summary = byRound.get(result.round) ?? {
      round: result.round,
      total: 0,
      passed: 0,
      failed: 0,
    };
    summary.total += 1;
    if (result.passed) {
      summary.passed += 1;
    } else {
      summary.failed += 1;
    }
    byRound.set(result.round, summary);
  }
  return [...byRound.values()].sort((a, b) => a.round - b.round);
}

function passedWithinRounds(
  results: AndroidWorldTaskResult[],
  maxRound: number,
): Set<string> {
  const passed = new Set<string>();
  for (const result of results) {
    if (result.round <= maxRound && result.passed) {
      passed.add(result.task);
    }
  }
  return passed;
}

function rate(passed: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  return passed / total;
}

/**
 * Compute Pass@k over distinct tasks: a task counts for Pass@k when any
 * attempt in rounds 1..k passed. Mirrors the official report rounds.
 */
export function computePassAtK(
  results: AndroidWorldTaskResult[],
  total: number,
): PassAtKSummary {
  const passAt1 = passedWithinRounds(results, 1).size;
  const passAt2 = passedWithinRounds(results, 2).size;
  const passAt3 = passedWithinRounds(results, 3).size;
  return {
    total,
    passAt1,
    passAt1Rate: rate(passAt1, total),
    passAt2,
    passAt2Rate: rate(passAt2, total),
    passAt3,
    passAt3Rate: rate(passAt3, total),
  };
}
