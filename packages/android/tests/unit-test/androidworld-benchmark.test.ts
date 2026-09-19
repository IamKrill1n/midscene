import { describe, expect, it } from '@rstest/core';
import {
  type AndroidWorldTaskResult,
  computePassAtK,
  filterTasks,
  isPass,
  parseArgs,
  summarizeByRound,
  tasksForRound,
} from '../../androidworld-benchmark/scoring';

function result(
  task: string,
  round: number,
  passed: boolean,
): AndroidWorldTaskResult {
  return { task, round, score: passed ? 1 : 0, passed };
}

describe('AndroidWorld benchmark scoring', () => {
  describe('isPass', () => {
    it('uses the validator threshold of 0.5', () => {
      expect(isPass(1)).toBe(true);
      expect(isPass(0.51)).toBe(true);
      expect(isPass(0.5)).toBe(false);
      expect(isPass(0)).toBe(false);
    });
  });

  describe('parseArgs', () => {
    it('returns defaults for an empty argv', () => {
      const options = parseArgs([]);
      expect(options.tasks).toEqual([]);
      expect(options.rounds).toBe(3);
      expect(options.suiteFamily).toBe('android_world');
      expect(options.resume).toBe(false);
      expect(options.taskTimeoutMs).toBe(600_000);
      expect(options.cycleLimit).toBe(120);
    });

    it('parses task lists, rounds, resume, and limits', () => {
      const options = parseArgs([
        '--tasks=ContactsAddContact, ClockStopWatchRunning',
        '--rounds=1',
        '--resume',
        '--task-timeout-ms=1000',
        '--cycle-limit=10',
        '--output=out-dir',
        '--suite=android_world',
      ]);
      expect(options.tasks).toEqual([
        'ContactsAddContact',
        'ClockStopWatchRunning',
      ]);
      expect(options.rounds).toBe(1);
      expect(options.resume).toBe(true);
      expect(options.taskTimeoutMs).toBe(1_000);
      expect(options.cycleLimit).toBe(10);
      expect(options.outputDir).toBe('out-dir');
    });

    it('rejects out-of-range rounds and unknown flags', () => {
      expect(() => parseArgs(['--rounds=4'])).toThrow();
      expect(() => parseArgs(['--bogus'])).toThrow();
    });
  });

  describe('filterTasks', () => {
    it('keeps the full suite when no selection is given', () => {
      expect(filterTasks(['A', 'B'], [])).toEqual(['A', 'B']);
    });

    it('restricts to the requested selection in suite order', () => {
      expect(filterTasks(['A', 'B', 'C'], ['C', 'A'])).toEqual(['A', 'C']);
    });
  });

  describe('tasksForRound', () => {
    it('runs everything in round 1 and retries only failures later', () => {
      const all = ['A', 'B', 'C'];
      expect(tasksForRound(all, [], 1)).toEqual(all);
      const afterRound1 = [result('A', 1, true), result('B', 1, false)];
      expect(tasksForRound(all, afterRound1, 2)).toEqual(['B', 'C']);
      const afterRound2 = [...afterRound1, result('B', 2, true)];
      expect(tasksForRound(all, afterRound2, 3)).toEqual(['C']);
    });
  });

  describe('summarizeByRound', () => {
    it('counts passes and failures per round', () => {
      const summary = summarizeByRound([
        result('A', 1, true),
        result('B', 1, false),
        result('B', 2, true),
      ]);
      expect(summary).toEqual([
        { round: 1, total: 2, passed: 1, failed: 1 },
        { round: 2, total: 1, passed: 1, failed: 0 },
      ]);
    });
  });

  describe('computePassAtK', () => {
    it('counts a task once any attempt within k rounds passes', () => {
      const summary = computePassAtK(
        [result('A', 1, true), result('B', 1, false), result('B', 2, true)],
        3,
      );
      expect(summary.total).toBe(3);
      expect(summary.passAt1).toBe(1);
      expect(summary.passAt2).toBe(2);
      expect(summary.passAt3).toBe(2);
      expect(summary.passAt1Rate).toBeCloseTo(1 / 3);
      expect(summary.passAt2Rate).toBeCloseTo(2 / 3);
    });

    it('returns zeros for an empty run', () => {
      const summary = computePassAtK([], 0);
      expect(summary.passAt1Rate).toBe(0);
      expect(summary.passAt3).toBe(0);
    });
  });
});
