/**
 * Minimal AndroidWorld benchmark runner for Midscene on an emulator.
 *
 * Flow per task: bridge `init_task` -> fresh AndroidAgent `aiAct(goal)`
 * -> for information-retrieval tasks `aiAsk(goal)` -> bridge `submit_answer`
 * -> bridge `score_task` -> bridge `teardown_task` -> append JSONL.
 * Later rounds retry only tasks without a passing attempt.
 *
 * Run with tsx from this directory:
 *
 *   npx tsx run.ts --config=smoke.config.json
 *   npx tsx run.ts --tasks=ContactsAddContact --rounds=1 --resume
 *
 * Set `MIDSCENE_ANDROIDWORLD_PYTHON` when `android_world` is installed into
 * a virtualenv rather than the default `python3`.
 *
 * Prerequisites: emulator running (`adb devices` shows it), AndroidWorld
 * installed for the same Python (`python3 -c "import android_world"`),
 * and model credentials exported (see ../apps/site/docs/en/android-world-benchmark-guide.mdx).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AndroidWorldTaskResult,
  type BenchmarkRunOptions,
  computePassAtK,
  filterTasks,
  isPass,
  parseArgs,
  summarizeByRound,
  tasksForRound,
} from './scoring';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeScript = path.join(here, 'androidworld_bridge.py');

interface BridgeResponse {
  ok: boolean;
  error?: string;
  // Bridge payloads vary per method, so extra fields stay loosely typed.
  [key: string]: any;
}

class BridgeClient {
  private child: ChildProcess;
  private buffer = '';
  private pending: Array<{
    resolve: (value: BridgeResponse) => void;
    reject: (error: Error) => void;
  }> = [];
  private nextId = 1;

  constructor(pythonBin = 'python3') {
    this.child = spawn(pythonBin, [bridgeScript], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    // A dead bridge must not crash the runner through an unhandled EPIPE.
    this.child.stdin?.on('error', () => undefined);
    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const waiter = this.pending.shift();
        if (!waiter) {
          continue;
        }
        try {
          waiter.resolve(JSON.parse(trimmed) as BridgeResponse);
        } catch (error) {
          waiter.reject(error as Error);
        }
      }
    });
    this.child.on('error', (error) => {
      for (const waiter of this.pending.splice(0)) {
        waiter.reject(error);
      }
    });
  }

  call(
    method: string,
    // Bridge params vary per method, so they stay loosely typed.
    params: Record<string, any> = {},
  ): Promise<BridgeResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async close(): Promise<void> {
    try {
      await this.call('quit');
    } catch {
      // The bridge may already be gone; fall through to kill.
    }
    this.child.kill();
  }
}

interface LoadedConfig {
  options: BenchmarkRunOptions;
}

function loadOptions(argv: string[]): LoadedConfig {
  let base = parseArgs(argv.filter((arg) => !arg.startsWith('--config=')));
  const configArg = argv.find((arg) => arg.startsWith('--config='));
  if (configArg) {
    const configPath = path.resolve(configArg.slice('--config='.length));
    const raw = JSON.parse(
      fs.readFileSync(configPath, 'utf8'),
    ) as Partial<BenchmarkRunOptions>;
    base = {
      ...base,
      ...raw,
      tasks: base.tasks.length > 0 ? base.tasks : (raw.tasks ?? []),
    };
  }
  return { options: base };
}

function readCompletedKeys(outputDir: string): Set<string> {
  const resultsFile = path.join(outputDir, 'results.jsonl');
  const completed = new Set<string>();
  if (!fs.existsSync(resultsFile)) {
    return completed;
  }
  const lines = fs.readFileSync(resultsFile, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as AndroidWorldTaskResult;
      completed.add(`${entry.round}:${entry.task}`);
    } catch {
      // Ignore partial trailing lines from interrupted runs.
    }
  }
  return completed;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

async function runSingleTask(
  bridge: BridgeClient,
  task: string,
  round: number,
  options: BenchmarkRunOptions,
): Promise<AndroidWorldTaskResult> {
  const init = await bridge.call('init_task', { task });
  if (!init.ok) {
    throw new Error(
      `init_task failed for ${task}: ${init.error ?? 'unknown error'}`,
    );
  }
  const goal = String(init.goal ?? '');
  const needsAnswer = init.task_type === 'qa';

  // One Device per Agent: agentFromAdbDevice creates a fresh AndroidDevice
  // for this Agent, and agent.destroy() releases it. Never share a Device
  // across Agents or reuse it after destroy.
  const { agentFromAdbDevice } = await import('../src/agent');
  const agent = await agentFromAdbDevice(undefined, {
    replanningCycleLimit: options.cycleLimit,
  });
  try {
    // aiAct navigates and acts; it returns the last action output, not an
    // answer. Information-retrieval tasks therefore read the answer with
    // aiAsk and forward it through the bridge.
    await withTimeout(
      agent.aiAct(goal, { deepThink: true }),
      options.taskTimeoutMs,
      `aiAct(${task})`,
    );
    if (needsAnswer) {
      const answer = await withTimeout(
        agent.aiAsk(goal),
        options.taskTimeoutMs,
        `aiAsk(${task})`,
      );
      await bridge.call('submit_answer', { task, answer });
    }
  } finally {
    await agent.destroy();
  }

  const scored = await bridge.call('score_task', { task });
  if (!scored.ok) {
    throw new Error(
      `score_task failed for ${task}: ${scored.error ?? 'unknown error'}`,
    );
  }
  const score = Number(scored.score ?? 0);
  await bridge.call('teardown_task', { task });

  return { task, round, score, passed: isPass(score) };
}

async function main(): Promise<void> {
  let options: BenchmarkRunOptions;
  try {
    options = loadOptions(process.argv.slice(2)).options;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Usage:')) {
      console.log(message);
      process.exitCode = 0;
      return;
    }
    throw error;
  }
  fs.mkdirSync(options.outputDir, { recursive: true });
  const resultsFile = path.join(options.outputDir, 'results.jsonl');

  const bridge = new BridgeClient(
    process.env.MIDSCENE_ANDROIDWORLD_PYTHON ?? 'python3',
  );
  try {
    const hello = await bridge.call('hello');
    if (!hello.ok) {
      throw new Error(`Bridge hello failed: ${hello.error ?? 'unknown error'}`);
    }
    const listed = await bridge.call('list_tasks', {
      suite: options.suiteFamily,
    });
    if (!listed.ok || !Array.isArray(listed.tasks)) {
      throw new Error(
        `list_tasks failed: ${listed.error ?? 'unexpected response'}`,
      );
    }
    const suiteTasks = filterTasks(listed.tasks as string[], options.tasks);
    if (suiteTasks.length === 0) {
      throw new Error(
        'No tasks selected: check --tasks and the suite listing.',
      );
    }

    const results: AndroidWorldTaskResult[] = [];
    const completed = options.resume
      ? readCompletedKeys(options.outputDir)
      : new Set<string>();

    for (let round = 1; round <= options.rounds; round += 1) {
      const roundTasks = tasksForRound(suiteTasks, results, round).filter(
        (task) => !completed.has(`${round}:${task}`),
      );
      for (const task of roundTasks) {
        try {
          const result = await runSingleTask(bridge, task, round, options);
          results.push(result);
          completed.add(`${round}:${task}`);
          fs.appendFileSync(resultsFile, `${JSON.stringify(result)}\n`);
          console.log(
            `[round ${round}] ${task}: ${result.passed ? 'PASS' : 'FAIL'} (${result.score})`,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(`[round ${round}] ${task}: ERROR ${message}`);
        }
      }
    }

    const summary = computePassAtK(results, suiteTasks.length);
    fs.writeFileSync(
      path.join(options.outputDir, 'summary.json'),
      `${JSON.stringify({ options, summary, rounds: summarizeByRound(results) }, null, 2)}\n`,
    );
    console.log(
      `Pass@1 ${summary.passAt1}/${summary.total} (${(summary.passAt1Rate * 100).toFixed(2)}%), ` +
        `Pass@2 ${summary.passAt2}/${summary.total} (${(summary.passAt2Rate * 100).toFixed(2)}%), ` +
        `Pass@3 ${summary.passAt3}/${summary.total} (${(summary.passAt3Rate * 100).toFixed(2)}%)`,
    );
  } finally {
    await bridge.close();
  }
}

main().then(
  () => undefined,
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
