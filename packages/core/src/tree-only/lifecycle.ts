import {
  TREE_ONLY_MAX_RECOVERIES,
  TreeOnlyOperationError,
  assertSupportedInputMode,
  consumeTreeOnlyRecovery,
  createTreeOnlyRecoveryBudget,
  isPermanentTreeOnlyError,
} from './types';
import type { TreeOnlyErrorCategory, TreeOnlyOperationContext } from './types';

/**
 * T04 operation lifecycle and shared recovery for tree-only Jev evaluation.
 *
 * One top-level operation gets one initial attempt plus at most two shared
 * recoveries. Capture, selection, parsing, and transport share the same
 * budget object instead of multiplying retries: nested stages receive the
 * same {@link TreeOnlyOperationState} and every recovery is claimed through
 * {@link claimTreeOnlyRecovery}. Successful steps and normal wait polls never
 * consume the recovery budget; they use their own bounds.
 *
 * Snapshots are operation-local. Recapture releases the previous snapshot so
 * old references reject instead of rebinding, and completion/cancellation
 * releases everything. Durable Jev decision/target replay is disabled: the
 * tree-only path never reads a persisted decision cache, and the legacy
 * visual `TaskCache` path is left untouched.
 */

export type TreeOnlyClock = () => number;

export type TreeOnlySnapshotReleaseReason =
  | 'completed'
  | 'cancelled'
  | 'navigation'
  | 'expired'
  | 'replaced'
  | 'explicit';

export interface TreeOnlySnapshotRegistration {
  snapshotId: string;
  released: boolean;
  releaseReason?: TreeOnlySnapshotReleaseReason;
}

export interface TreeOnlyOperationState {
  readonly context: TreeOnlyOperationContext;
  readonly startedAt: number;
  readonly clock: TreeOnlyClock;
  budget: ReturnType<typeof createTreeOnlyRecoveryBudget>;
  retryCount: number;
  retryReasons: string[];
  dispatched: boolean;
  uncertainDeliveryObserved: boolean;
  successSteps: number;
  waitPolls: number;
  completed: boolean;
  snapshots: Map<string, TreeOnlySnapshotRegistration>;
  currentSnapshotId?: string;
}

export interface CreateTreeOnlyOperationStateOptions {
  clock?: TreeOnlyClock;
  startedAt?: number;
  initialSnapshotId?: string;
}

function defaultClock(): number {
  return Date.now();
}

/**
 * Create mutable per-operation lifecycle state. Validates the operation
 * identity and mode without resolving provider configuration (T02/T03 own
 * those stages); the returned state carries the shared recovery budget.
 */
export function createTreeOnlyOperationState(
  context: TreeOnlyOperationContext,
  options?: CreateTreeOnlyOperationStateOptions,
): TreeOnlyOperationState {
  if (!context || !context.operationId) {
    throw new Error('createTreeOnlyOperationState: operationId is required');
  }
  assertSupportedInputMode(context.effectiveMode);
  if (
    context.deadlineMs !== undefined &&
    (!Number.isFinite(context.deadlineMs) || context.deadlineMs < 0)
  ) {
    throw new Error(
      'createTreeOnlyOperationState: deadlineMs must be a non-negative finite number',
    );
  }
  const clock = options?.clock ?? defaultClock;
  const startedAt = options?.startedAt ?? clock();
  const state: TreeOnlyOperationState = {
    context,
    startedAt,
    clock,
    budget: createTreeOnlyRecoveryBudget(context.operationId),
    retryCount: 0,
    retryReasons: [],
    dispatched: false,
    uncertainDeliveryObserved: false,
    successSteps: 0,
    waitPolls: 0,
    completed: false,
    snapshots: new Map(),
    currentSnapshotId: undefined,
  };
  if (options?.initialSnapshotId) {
    attachTreeOnlySnapshot(state, options.initialSnapshotId);
  }
  throwIfTreeOnlyCancelled(context);
  throwIfTreeOnlyDeadlineExceeded(state);
  return state;
}

/** Throw `cancelled` when the operation signal already aborted. */
export function throwIfTreeOnlyCancelled(
  context: Pick<TreeOnlyOperationContext, 'abortSignal' | 'operationId'>,
): void {
  if (context.abortSignal?.aborted) {
    const reason =
      typeof context.abortSignal.reason === 'string' &&
      context.abortSignal.reason
        ? `: ${context.abortSignal.reason}`
        : '';
    throw new TreeOnlyOperationError(
      `operation cancelled${reason}`,
      'cancelled',
      {
        operationId: context.operationId,
      },
    );
  }
}

/** Remaining milliseconds before the operation deadline, if any. */
export function getTreeOnlyDeadlineRemaining(
  state: TreeOnlyOperationState,
  now?: number,
): number | undefined {
  const deadlineMs = state.context.deadlineMs;
  if (deadlineMs === undefined) {
    return undefined;
  }
  const current = now ?? state.clock();
  return state.startedAt + deadlineMs - current;
}

/**
 * Throw `deadline` when the operation deadline already passed. Recovery never
 * extends the deadline: callers check this before every retry.
 */
export function throwIfTreeOnlyDeadlineExceeded(
  state: TreeOnlyOperationState,
  now?: number,
): void {
  const remaining = getTreeOnlyDeadlineRemaining(state, now);
  if (remaining !== undefined && remaining < 0) {
    throw new TreeOnlyOperationError(
      `operation deadline exceeded after ${state.context.deadlineMs}ms`,
      'deadline',
      { operationId: state.context.operationId },
    );
  }
}

function toTreeOnlyErrorCategory(error: unknown): TreeOnlyErrorCategory {
  if (error instanceof TreeOnlyOperationError) {
    return error.category;
  }
  return 'service-failure';
}

/**
 * Whether a failure category may consume the shared recovery budget.
 * Permanent categories (invalid config, unsupported capability/input,
 * obstruction below threshold, cancellation, deadline, exhausted budget,
 * malformed/missing evidence) fail immediately. Uncertain delivery after
 * physical dispatch never retries the dispatch: the outcome must be observed
 * and recorded instead of blindly redispatching.
 */
export function shouldRetryTreeOnlyFailure(
  state: TreeOnlyOperationState,
  category: TreeOnlyErrorCategory,
): boolean {
  if (isPermanentTreeOnlyError(category)) {
    return false;
  }
  if (category === 'uncertain-delivery' && state.dispatched) {
    return false;
  }
  if (category === 'uncertain-delivery' && state.uncertainDeliveryObserved) {
    return false;
  }
  return state.budget.remaining > 0;
}

export interface ClaimTreeOnlyRecoveryDetails {
  reason: string;
  category: TreeOnlyErrorCategory;
  now?: number;
}

/**
 * Claim one shared recovery for a transient failure. Checks cancellation and
 * deadline first, then permanence and the no-redispatch guard, then the
 * budget. Permanent, cancelled, deadline, no-redispatch, and exhausted cases
 * throw without consuming the budget so nested stages cannot multiply retries.
 */
export function claimTreeOnlyRecovery(
  state: TreeOnlyOperationState,
  details: ClaimTreeOnlyRecoveryDetails,
): void {
  throwIfTreeOnlyCancelled(state.context);
  throwIfTreeOnlyDeadlineExceeded(state, details.now);
  const { category, reason } = details;
  if (isPermanentTreeOnlyError(category)) {
    throw new TreeOnlyOperationError(
      `permanent tree-only failure (${category}): ${reason}`,
      category,
      { operationId: state.context.operationId },
    );
  }
  if (
    category === 'uncertain-delivery' &&
    (state.dispatched || state.uncertainDeliveryObserved)
  ) {
    throw new TreeOnlyOperationError(
      `uncertain input delivery; refusing automatic redispatch: ${reason}`,
      'uncertain-delivery',
      { operationId: state.context.operationId },
    );
  }
  const next = consumeTreeOnlyRecovery(state.budget);
  if (!next) {
    throw new TreeOnlyOperationError(
      `tree-only recovery budget exhausted after ${TREE_ONLY_MAX_RECOVERIES} recoveries: ${reason}`,
      'budget-exhausted',
      { operationId: state.context.operationId },
    );
  }
  state.budget = next;
  state.retryCount += 1;
  state.retryReasons.push(reason);
}

/** Register a snapshot and make it current, releasing the previous one. */
export function attachTreeOnlySnapshot(
  state: TreeOnlyOperationState,
  snapshotId: string,
): void {
  if (!snapshotId) {
    throw new Error('attachTreeOnlySnapshot: snapshotId is required');
  }
  const previous = state.currentSnapshotId;
  if (previous !== undefined && previous !== snapshotId) {
    releaseTreeOnlySnapshot(state, previous, 'replaced');
  }
  const existing = state.snapshots.get(snapshotId);
  if (existing && !existing.released) {
    state.currentSnapshotId = snapshotId;
    return;
  }
  state.snapshots.set(snapshotId, { snapshotId, released: false });
  state.currentSnapshotId = snapshotId;
}

/** Release one snapshot; references scoped to it reject afterwards. */
export function releaseTreeOnlySnapshot(
  state: TreeOnlyOperationState,
  snapshotId: string,
  reason: TreeOnlySnapshotReleaseReason,
): void {
  const registration = state.snapshots.get(snapshotId);
  if (!registration) {
    state.snapshots.set(snapshotId, {
      snapshotId,
      released: true,
      releaseReason: reason,
    });
    return;
  }
  registration.released = true;
  registration.releaseReason = reason;
}

/** Release every retained snapshot, e.g. on completion or cancellation. */
export function releaseAllTreeOnlySnapshots(
  state: TreeOnlyOperationState,
  reason: TreeOnlySnapshotReleaseReason,
): void {
  for (const registration of state.snapshots.values()) {
    registration.released = true;
    registration.releaseReason = reason;
  }
}

/**
 * Whether a snapshot identity is still usable. Only the current unreleased
 * snapshot resolves; recaptured, navigated, expired, completed, or cancelled
 * snapshots reject even when the caller still holds their old reference.
 */
export function isTreeOnlySnapshotUsable(
  state: TreeOnlyOperationState,
  snapshotId: string,
): boolean {
  const registration = state.snapshots.get(snapshotId);
  if (!registration || registration.released) {
    return false;
  }
  if (
    state.currentSnapshotId !== undefined &&
    snapshotId !== state.currentSnapshotId
  ) {
    return false;
  }
  return true;
}

export interface TreeOnlySnapshotResolver {
  readonly snapshotId: string;
  resolve(ref: string): unknown | null;
}

/**
 * Resolve a snapshot-scoped reference through the owning operation. Returns
 * `null` for released/superseded snapshots, cross-snapshot resolvers, and
 * unknown refs instead of rebinding to a same-name replacement node.
 */
export function resolveTreeOnlySnapshotRef(
  state: TreeOnlyOperationState,
  snapshotId: string,
  ref: string,
  resolver: TreeOnlySnapshotResolver,
): unknown | null {
  if (!isTreeOnlySnapshotUsable(state, snapshotId)) {
    return null;
  }
  if (resolver.snapshotId !== snapshotId) {
    return null;
  }
  return resolver.resolve(ref);
}

/** Record that physical input was dispatched; guards later redispatch. */
export function recordTreeOnlyDispatch(state: TreeOnlyOperationState): void {
  throwIfTreeOnlyCancelled(state.context);
  throwIfTreeOnlyDeadlineExceeded(state);
  if (state.uncertainDeliveryObserved) {
    throw new TreeOnlyOperationError(
      'uncertain input delivery; refusing automatic redispatch',
      'uncertain-delivery',
      { operationId: state.context.operationId },
    );
  }
  state.dispatched = true;
}

/**
 * Record that dispatched input has an unknown outcome. The caller must
 * observe and record the result; automatic redispatch stays forbidden until
 * a fresh operation with fresh validation runs.
 */
export function recordTreeOnlyUncertainDelivery(
  state: TreeOnlyOperationState,
): void {
  state.uncertainDeliveryObserved = true;
}

/** Throw when a new dispatch is not allowed after uncertain delivery. */
export function assertTreeOnlyCanDispatch(state: TreeOnlyOperationState): void {
  if (state.uncertainDeliveryObserved) {
    throw new TreeOnlyOperationError(
      'uncertain input delivery; refusing automatic redispatch',
      'uncertain-delivery',
      { operationId: state.context.operationId },
    );
  }
}

/**
 * Durable Jev decision/target replay is disabled for the first release.
 * The tree-only path always recomputes from fresh evidence; this helper
 * makes the miss explicit so no caller can mistake "no cache" for a failure.
 */
export const TREE_ONLY_DURABLE_REPLAY_ENABLED = false as const;

/** Always returns `undefined`: durable replay is disabled, not a miss. */
export function matchTreeOnlyDurableDecision(): undefined {
  return undefined;
}

export interface TreeOnlyCacheKeyParts {
  effectiveMode: 'visual' | 'tree-only';
  platform: 'browser' | 'android';
  provider: string;
  model: string;
  protocolVersion: string;
  snapshotSchemaVersion: string;
  operation: string;
  instruction: string;
  args?: string;
}

/** Identity fields that isolate a future tree-only cache entry. */
export const TREE_ONLY_CACHE_IDENTITY_FIELDS = [
  'effectiveMode',
  'platform',
  'provider',
  'model',
  'protocolVersion',
  'snapshotSchemaVersion',
  'operation',
  'instruction',
  'args',
] as const;

/**
 * Build the deterministic identity a future durable cache would use. The key
 * always carries the effective mode so tree-only entries can never collide
 * with legacy visual entries; visual `TaskCache` behavior is otherwise
 * untouched by the tree-only path.
 */
export function buildTreeOnlyCacheKey(parts: TreeOnlyCacheKeyParts): string {
  for (const field of TREE_ONLY_CACHE_IDENTITY_FIELDS) {
    if (field === 'args') {
      continue;
    }
    const value = parts[field];
    if (typeof value !== 'string' || !value) {
      throw new Error(
        `buildTreeOnlyCacheKey: ${field} is required and must be non-empty`,
      );
    }
  }
  return [
    `mode=${parts.effectiveMode}`,
    `platform=${parts.platform}`,
    `provider=${parts.provider}`,
    `model=${parts.model}`,
    `protocol=${parts.protocolVersion}`,
    `snapshot=${parts.snapshotSchemaVersion}`,
    `operation=${parts.operation}`,
    `instruction=${parts.instruction}`,
    `args=${parts.args ?? ''}`,
  ].join('|');
}

/**
 * Record a successful step without consuming the shared recovery budget.
 * Bounded multistep loops (aiAct, scrolling, expansion) own their step
 * limits separately; this counter only proves successes are not recoveries.
 */
export function recordTreeOnlySuccessStep(
  state: TreeOnlyOperationState,
): number {
  state.successSteps += 1;
  return state.successSteps;
}

/** Record a normal wait poll; polls use deadlines, not recovery budget. */
export function recordTreeOnlyWaitPoll(state: TreeOnlyOperationState): number {
  throwIfTreeOnlyCancelled(state.context);
  throwIfTreeOnlyDeadlineExceeded(state);
  state.waitPolls += 1;
  return state.waitPolls;
}

export interface TreeOnlyWaitPollTracker {
  readonly maxPolls: number;
  polls: number;
  next(): boolean;
}

/**
 * Bounded wait-poll tracker independent of the recovery budget. Returns
 * `false` once `maxPolls` polls ran; the caller then fails or observes
 * instead of consuming a recovery attempt.
 */
export function createTreeOnlyWaitPollTracker(
  maxPolls: number,
): TreeOnlyWaitPollTracker {
  if (!Number.isInteger(maxPolls) || maxPolls <= 0) {
    throw new Error(
      'createTreeOnlyWaitPollTracker: maxPolls must be a positive integer',
    );
  }
  const tracker: TreeOnlyWaitPollTracker = {
    maxPolls,
    polls: 0,
    next() {
      if (tracker.polls >= tracker.maxPolls) {
        return false;
      }
      tracker.polls += 1;
      return true;
    },
  };
  return tracker;
}

export interface TreeOnlyRunResult<T> {
  value: T;
  attempts: number;
  retries: number;
  retryReasons: readonly string[];
}

/**
 * Run `attempt` with initial-attempt-plus-two-recoveries semantics over the
 * shared state. Nested stages pass the same state so their recoveries share
 * the budget. Permanent failures, cancellations, deadline expiry, exhausted
 * budgets, and post-dispatch uncertain delivery throw without further retry.
 */
export async function runTreeOnlyWithRecovery<T>(
  state: TreeOnlyOperationState,
  attempt: (attemptIndex: number) => Promise<T>,
): Promise<TreeOnlyRunResult<T>> {
  let attemptIndex = 0;
  for (;;) {
    throwIfTreeOnlyCancelled(state.context);
    throwIfTreeOnlyDeadlineExceeded(state);
    try {
      const value = await attempt(attemptIndex);
      return {
        value,
        attempts: attemptIndex + 1,
        retries: state.retryCount,
        retryReasons: [...state.retryReasons],
      };
    } catch (error) {
      const category = toTreeOnlyErrorCategory(error);
      const reason = error instanceof Error ? error.message : String(error);
      if (!shouldRetryTreeOnlyFailure(state, category)) {
        if (
          category === 'uncertain-delivery' &&
          (state.dispatched || state.uncertainDeliveryObserved)
        ) {
          throw new TreeOnlyOperationError(
            `uncertain input delivery; refusing automatic redispatch: ${reason}`,
            'uncertain-delivery',
            { operationId: state.context.operationId },
          );
        }
        if (isPermanentTreeOnlyError(category)) {
          throw error;
        }
        if (state.budget.remaining <= 0) {
          throw new TreeOnlyOperationError(
            `tree-only recovery budget exhausted after ${TREE_ONLY_MAX_RECOVERIES} recoveries: ${reason}`,
            'budget-exhausted',
            { operationId: state.context.operationId },
          );
        }
        throw error;
      }
      claimTreeOnlyRecovery(state, { reason, category });
      attemptIndex += 1;
    }
  }
}

/**
 * Finish the operation and release retained snapshots. Successful completion
 * releases with `completed`; cancellation releases with `cancelled` so no
 * later operation can resolve the released references.
 */
export function finishTreeOnlyOperation(
  state: TreeOnlyOperationState,
  outcome: 'completed' | 'cancelled' = 'completed',
): void {
  state.completed = outcome === 'completed';
  releaseAllTreeOnlySnapshots(
    state,
    outcome === 'completed' ? 'completed' : 'cancelled',
  );
}
