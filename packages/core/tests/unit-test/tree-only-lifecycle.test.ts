import {
  TREE_ONLY_CACHE_IDENTITY_FIELDS,
  TREE_ONLY_DURABLE_REPLAY_ENABLED,
  assertTreeOnlyCanDispatch,
  attachTreeOnlySnapshot,
  buildTreeOnlyCacheKey,
  claimTreeOnlyRecovery,
  createTreeOnlyOperationState,
  createTreeOnlyWaitPollTracker,
  finishTreeOnlyOperation,
  isTreeOnlySnapshotUsable,
  matchTreeOnlyDurableDecision,
  recordTreeOnlyDispatch,
  recordTreeOnlySuccessStep,
  recordTreeOnlyUncertainDelivery,
  recordTreeOnlyWaitPoll,
  releaseAllTreeOnlySnapshots,
  releaseTreeOnlySnapshot,
  resolveTreeOnlySnapshotRef,
  runTreeOnlyWithRecovery,
  shouldRetryTreeOnlyFailure,
} from '@/tree-only/lifecycle';
import {
  TREE_ONLY_MAX_RECOVERIES,
  TreeOnlyOperationError,
} from '@/tree-only/types';
import type { TreeOnlyOperationContext } from '@/tree-only/types';
import { describe, expect, it } from '@rstest/core';

function testContext(
  overrides?: Partial<TreeOnlyOperationContext>,
): TreeOnlyOperationContext {
  return {
    operationId: 'op-t04',
    kind: 'direct-action',
    instruction: 'Click Submit',
    effectiveMode: 'tree-only',
    modeSource: 'call',
    ...overrides,
  };
}

function transientError(message = 'transport blew up') {
  return new TreeOnlyOperationError(message, 'service-failure', {
    operationId: 'op-t04',
  });
}

describe('tree-only operation lifecycle and recovery', () => {
  it('succeeds on the initial attempt without consuming recoveries', async () => {
    const state = createTreeOnlyOperationState(testContext());
    const result = await runTreeOnlyWithRecovery(state, async () => 'ok');
    expect(result.value).toBe('ok');
    expect(result.attempts).toBe(1);
    expect(result.retries).toBe(0);
    expect(state.budget.remaining).toBe(TREE_ONLY_MAX_RECOVERIES);
  });

  it('allows the initial attempt plus two shared recoveries, then exhausts', async () => {
    const state = createTreeOnlyOperationState(testContext());
    let calls = 0;
    await expect(
      runTreeOnlyWithRecovery(state, async () => {
        calls += 1;
        throw transientError(`failure ${calls}`);
      }),
    ).rejects.toMatchObject({ category: 'budget-exhausted' });
    expect(calls).toBe(3);
    expect(state.retryCount).toBe(2);
    expect(state.retryReasons).toHaveLength(2);
    expect(state.budget.remaining).toBe(0);
  });

  it('shares one budget across nested capture/selection/transport stages', async () => {
    const state = createTreeOnlyOperationState(testContext());
    const nested = async () => {
      // Inner stage consumes the first recovery.
      claimTreeOnlyRecovery(state, {
        reason: 'capture retry',
        category: 'service-failure',
      });
      // Outer stage consumes the second recovery.
      claimTreeOnlyRecovery(state, {
        reason: 'transport retry',
        category: 'stale-target',
      });
      // A third nested recovery must fail: budgets do not multiply.
      expect(() =>
        claimTreeOnlyRecovery(state, {
          reason: 'parsing retry',
          category: 'service-failure',
        }),
      ).toThrow(/budget exhausted/);
    };
    await nested();
    expect(state.retryCount).toBe(2);
    await expect(
      runTreeOnlyWithRecovery(state, async () => {
        throw transientError('one more transient failure');
      }),
    ).rejects.toMatchObject({ category: 'budget-exhausted' });
  });

  it('fails permanent errors immediately without consuming budget', async () => {
    for (const category of [
      'unsupported-operation',
      'unsupported-input',
      'obstruction',
      'malformed',
      'missing',
    ] as const) {
      const state = createTreeOnlyOperationState(testContext());
      let calls = 0;
      const failure = new TreeOnlyOperationError(`${category} hit`, category, {
        operationId: 'op-t04',
      });
      await expect(
        runTreeOnlyWithRecovery(state, async () => {
          calls += 1;
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(calls).toBe(1);
      expect(state.retryCount).toBe(0);
      expect(state.budget.remaining).toBe(TREE_ONLY_MAX_RECOVERIES);
      expect(shouldRetryTreeOnlyFailure(state, category)).toBe(false);
    }
  });

  it('never redispatches after uncertain input delivery', async () => {
    const state = createTreeOnlyOperationState(testContext());
    recordTreeOnlyDispatch(state);
    recordTreeOnlyUncertainDelivery(state);
    expect(() => assertTreeOnlyCanDispatch(state)).toThrow(
      /refusing automatic redispatch/,
    );
    expect(() => recordTreeOnlyDispatch(state)).toThrow(
      /refusing automatic redispatch/,
    );
    let calls = 0;
    await expect(
      runTreeOnlyWithRecovery(state, async () => {
        calls += 1;
        throw new TreeOnlyOperationError(
          'delivery unknown',
          'uncertain-delivery',
          {
            operationId: 'op-t04',
          },
        );
      }),
    ).rejects.toMatchObject({ category: 'uncertain-delivery' });
    expect(calls).toBe(1);
    expect(state.retryCount).toBe(0);
  });

  it('enforces the deadline and never extends it for recovery', async () => {
    let now = 1_000;
    const state = createTreeOnlyOperationState(
      testContext({ deadlineMs: 50 }),
      { clock: () => now },
    );
    now += 100;
    let calls = 0;
    await expect(
      runTreeOnlyWithRecovery(state, async () => {
        calls += 1;
        throw transientError('late transient');
      }),
    ).rejects.toMatchObject({ category: 'deadline' });
    expect(calls).toBe(0);
    expect(state.retryCount).toBe(0);
  });

  it('fails fast when the abort signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort('user stopped it');
    expect(() =>
      createTreeOnlyOperationState(
        testContext({ abortSignal: controller.signal }),
      ),
    ).toThrow(/cancelled/);
    const running = createTreeOnlyOperationState(testContext());
    (running.context as { abortSignal?: AbortSignal }).abortSignal =
      controller.signal;
    await expect(
      runTreeOnlyWithRecovery(running, async () => 'never runs'),
    ).rejects.toMatchObject({ category: 'cancelled' });
  });

  it('releases snapshots on recapture and completion, rejecting old refs', () => {
    const state = createTreeOnlyOperationState(testContext());
    attachTreeOnlySnapshot(state, 'snap-1');
    const resolver = {
      snapshotId: 'snap-1',
      resolve: (ref: string) => (ref === 'a' ? { ref: 'a' } : null),
    };
    expect(resolveTreeOnlySnapshotRef(state, 'snap-1', 'a', resolver)).toEqual({
      ref: 'a',
    });
    attachTreeOnlySnapshot(state, 'snap-2');
    expect(isTreeOnlySnapshotUsable(state, 'snap-1')).toBe(false);
    expect(
      resolveTreeOnlySnapshotRef(state, 'snap-1', 'a', resolver),
    ).toBeNull();
    // Cross-snapshot resolver binding is rejected even with a live id.
    expect(
      resolveTreeOnlySnapshotRef(state, 'snap-2', 'a', resolver),
    ).toBeNull();
    releaseTreeOnlySnapshot(state, 'snap-2', 'navigation');
    expect(isTreeOnlySnapshotUsable(state, 'snap-2')).toBe(false);
    attachTreeOnlySnapshot(state, 'snap-3');
    finishTreeOnlyOperation(state, 'completed');
    expect(isTreeOnlySnapshotUsable(state, 'snap-3')).toBe(false);
    releaseAllTreeOnlySnapshots(state, 'cancelled');
  });

  it('disables durable Jev replay and isolates cache identity by mode', () => {
    expect(TREE_ONLY_DURABLE_REPLAY_ENABLED).toBe(false);
    expect(matchTreeOnlyDurableDecision()).toBeUndefined();
    expect(TREE_ONLY_CACHE_IDENTITY_FIELDS).toContain('effectiveMode');
    const base = {
      platform: 'browser',
      provider: 'typesafe',
      model: 'jev-1.13.0',
      protocolVersion: '1',
      snapshotSchemaVersion: '1',
      operation: 'locate',
      instruction: 'Click Submit',
    } as const;
    const treeKey = buildTreeOnlyCacheKey({
      ...base,
      effectiveMode: 'tree-only',
    });
    const visualKey = buildTreeOnlyCacheKey({
      ...base,
      effectiveMode: 'visual',
    });
    expect(treeKey).not.toBe(visualKey);
    expect(treeKey).toContain('mode=tree-only');
    expect(() =>
      buildTreeOnlyCacheKey({ ...base, effectiveMode: 'tree-only', model: '' }),
    ).toThrow(/model is required/);
  });

  it('keeps successful steps and wait polls outside the recovery budget', async () => {
    const state = createTreeOnlyOperationState(testContext());
    expect(recordTreeOnlySuccessStep(state)).toBe(1);
    expect(recordTreeOnlyWaitPoll(state)).toBe(1);
    const polls = createTreeOnlyWaitPollTracker(2);
    expect(polls.next()).toBe(true);
    expect(polls.next()).toBe(true);
    expect(polls.next()).toBe(false);
    expect(state.budget.remaining).toBe(TREE_ONLY_MAX_RECOVERIES);
    expect(state.retryCount).toBe(0);
    expect(() => createTreeOnlyWaitPollTracker(0)).toThrow(/maxPolls/);
    const result = await runTreeOnlyWithRecovery(state, async (attempt) => {
      if (attempt === 0) {
        throw transientError('first poll transient');
      }
      recordTreeOnlySuccessStep(state);
      return 'recovered';
    });
    expect(result.value).toBe('recovered');
    expect(result.retries).toBe(1);
    expect(state.successSteps).toBe(2);
  });
});
