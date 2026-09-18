import type {
  TreeOnlyCandidateNode,
  TreeOnlySnapshot,
  TreeOnlySnapshotStatus,
} from '@midscene/shared/tree-only';

/**
 * T01 shared operation contracts for tree-only Jev evaluation.
 *
 * Interface declarations only. Mode resolution (T02), transport (T03),
 * lifecycle/recovery (T04), capture (T05), validation (T09), and
 * reporting (T10) implement against these types. Capability
 * declarations are opt-in: legacy adapters without them keep working
 * in visual mode and are never treated as tree-only capable.
 */

/** Effective per-operation input mode. `hybrid` is rejected outright. */
export type TreeOnlyInputMode = 'visual' | 'tree-only';

export type TreeOnlyModeSource =
  | 'call'
  | 'agent'
  | 'yaml-step'
  | 'yaml-script'
  | 'default';

export function assertSupportedInputMode(
  mode: string | null | undefined,
): asserts mode is TreeOnlyInputMode {
  if (mode !== 'visual' && mode !== 'tree-only') {
    throw new Error(
      `unsupported input mode: ${String(mode)}; expected "visual" or "tree-only"`,
    );
  }
}

/** Live model operations that may require typed Jev evaluation. */
export type TreeOnlyLiveOperation =
  | 'planning'
  | 'locate'
  | 'insight'
  | 'order-sensitive-judge';

/** Top-level operation kinds carried on the operation context. */
export type TreeOnlyOperationKind =
  | 'locate'
  | 'direct-action'
  | 'query'
  | 'assert'
  | 'wait'
  | 'extract'
  | 'aiact';

/**
 * Per-operation context. A call override governs the whole operation
 * (planning turns, locating, retries) without mutating the agent
 * default; concurrent operations carry their own context.
 */
export interface TreeOnlyOperationContext {
  operationId: string;
  kind: TreeOnlyOperationKind;
  instruction: string;
  /** Resolved public AI context for this operation (call wins over agent). */
  actionContext?: string;
  /** Revised action/operation-local context for planner recovery (T3). */
  recoveryContext?: string;
  effectiveMode: TreeOnlyInputMode;
  modeSource: TreeOnlyModeSource;
  /** Operation deadline in milliseconds; recovery never extends it. */
  deadlineMs?: number;
  abortSignal?: AbortSignal;
  /** Identity of the snapshot this operation currently reasons over. */
  snapshotId?: string;
}

/** A selectable option in a Jev Choice question. */
export interface JevChoiceOption {
  id: string;
  label: string;
}

/** Choice question: select one supplied option (or no-match). */
export interface JevChoiceQuestion {
  id: string;
  kind: 'choice';
  prompt: string;
  options: readonly JevChoiceOption[];
}

/** Noul question: probability that the statement holds. */
export interface JevNoulQuestion {
  id: string;
  kind: 'noul';
  statement: string;
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;

/** Answer to a Choice question with its output distribution. */
export interface JevChoiceAnswer {
  questionId: string;
  kind: 'choice';
  optionId: string;
  distribution?: Record<string, number>;
  /** Distribution concentration; not proof of a correct action. */
  confidence?: number;
}

/** Answer to a Noul question; near 0.5 means ambiguity. */
export interface JevNoulAnswer {
  questionId: string;
  kind: 'noul';
  probabilityYes: number;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

/** Typed evaluation request: text state plus questions, never images. */
export interface JevEvaluationRequest {
  /** Serialized semantic tree, instruction, and history (text only). */
  state: string;
  model: string;
  questions: readonly JevQuestion[];
}

export interface JevUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Typed evaluation response with the provider-resolved model version. */
export interface JevEvaluationResponse {
  answers: readonly JevAnswer[];
  usage?: JevUsage;
  /** Actual model version reported by the response (aliases move). */
  model: string;
}

export type JevTransportErrorCategory =
  | 'missing'
  | 'malformed'
  | 'service-failure';

export class JevEvaluationError extends Error {
  readonly category: JevTransportErrorCategory;
  readonly questionId?: string;

  constructor(
    message: string,
    category: JevTransportErrorCategory,
    questionId?: string,
  ) {
    super(message);
    this.name = 'JevEvaluationError';
    this.category = category;
    this.questionId = questionId;
  }
}

/**
 * Validate that every answer matches a known question by ID and kind.
 * Throws {@link JevEvaluationError} with `missing` (unknown question
 * ID) or `malformed` (kind mismatch / bad value) categories.
 */
export function validateJevAnswers(
  questions: readonly JevQuestion[],
  answers: readonly JevAnswer[],
): void {
  const byId = new Map(questions.map((question) => [question.id, question]));
  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (!question) {
      throw new JevEvaluationError(
        `answer references unknown question "${answer.questionId}"`,
        'missing',
        answer.questionId,
      );
    }
    if (question.kind !== answer.kind) {
      throw new JevEvaluationError(
        `answer kind "${answer.kind}" does not match question kind ` +
          `"${question.kind}" for "${answer.questionId}"`,
        'malformed',
        answer.questionId,
      );
    }
    if (question.kind === 'choice' && answer.kind === 'choice') {
      const known = new Set(question.options.map((option) => option.id));
      if (!known.has(answer.optionId)) {
        throw new JevEvaluationError(
          `answer selects unknown option "${answer.optionId}"`,
          'malformed',
          answer.questionId,
        );
      }
    }
    if (
      question.kind === 'noul' &&
      answer.kind === 'noul' &&
      (!Number.isFinite(answer.probabilityYes) ||
        answer.probabilityYes < 0 ||
        answer.probabilityYes > 1)
    ) {
      throw new JevEvaluationError(
        `answer has out-of-range probability for "${answer.questionId}"`,
        'malformed',
        answer.questionId,
      );
    }
  }
}

/**
 * Per-operation tree-only capability. Each declared operation provides
 * its own state builder, typed protocol, and parser in later tasks;
 * an omitted operation means unsupported.
 */
export interface TreeOnlyOperationAdapter {
  /** Protocol version of the typed evaluation for this operation. */
  protocolVersion: string;
}

export interface TreeOnlyAdapterCapabilities {
  treeOnly?: Partial<Record<TreeOnlyLiveOperation, TreeOnlyOperationAdapter>>;
}

/**
 * Opt-in capability check. Adapters without declarations (all legacy
 * adapters) report unsupported without breaking visual behavior.
 */
export function isTreeOnlyOperationSupported(
  capabilities: TreeOnlyAdapterCapabilities | undefined,
  operation: TreeOnlyLiveOperation,
): boolean {
  return capabilities?.treeOnly?.[operation] !== undefined;
}

/** Where a model-consumed input string was copied from. */
export type TreeOnlyArgumentProvenanceKind =
  | 'instruction-span'
  | 'structured-arg'
  | 'visible-span'
  | 'test-data';

/**
 * Source-backed argument: Jev selects provenance, code copies the
 * value. Instructions requiring newly composed prose fail as
 * unsupported instead of generating text.
 */
export interface TreeOnlySourcedText {
  value: string;
  provenance: {
    kind: TreeOnlyArgumentProvenanceKind;
    /** Snapshot-scoped candidate ref for `visible-span` values. */
    ref?: string;
    /** Quoted source span for `instruction-span` values. */
    quote?: string;
  };
}

/** Classified outcome of a tree-only operation step. */
export type TreeOnlyOutcome = 'success' | 'failure' | 'uncertain' | 'no-match';

/** Error categories with distinct retry and reporting semantics. */
export type TreeOnlyErrorCategory =
  | 'missing'
  | 'malformed'
  | 'service-failure'
  | 'unsupported-operation'
  | 'unsupported-input'
  | 'stale-target'
  | 'obstruction'
  | 'uncertain-delivery'
  | 'cancelled'
  | 'deadline'
  | 'budget-exhausted'
  | 'no-match'
  | 'uncertain';

export class TreeOnlyOperationError extends Error {
  readonly category: TreeOnlyErrorCategory;
  readonly operationId?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    category: TreeOnlyErrorCategory,
    options?: { operationId?: string },
  ) {
    super(message);
    this.name = 'TreeOnlyOperationError';
    this.category = category;
    this.operationId = options?.operationId;
    this.retryable = !isPermanentTreeOnlyError(category);
  }
}

/**
 * Permanent failures fail immediately with no recovery attempt:
 * invalid configuration, unsupported capabilities/inputs, obstruction
 * below threshold, cancellation, or exhausted budgets. Transient
 * capture/service/stale-evidence failures may recover within budget.
 */
export function isPermanentTreeOnlyError(
  category: TreeOnlyErrorCategory,
): boolean {
  return (
    category === 'unsupported-operation' ||
    category === 'unsupported-input' ||
    category === 'obstruction' ||
    category === 'cancelled' ||
    category === 'deadline' ||
    category === 'budget-exhausted' ||
    category === 'malformed' ||
    category === 'missing'
  );
}

/**
 * Shared recovery budget: the initial attempt plus at most two
 * recovery attempts per top-level operation. Capture, selection,
 * parsing, and transport share one counter instead of multiplying
 * retries. Successful steps and normal wait polls are not recoveries.
 */
export const TREE_ONLY_MAX_RECOVERIES = 2;

export interface TreeOnlyRecoveryBudget {
  readonly operationId: string;
  readonly remaining: number;
  readonly consumed: number;
}

export function createTreeOnlyRecoveryBudget(
  operationId: string,
): TreeOnlyRecoveryBudget {
  if (!operationId) {
    throw new Error('createTreeOnlyRecoveryBudget: operationId is required');
  }
  return { operationId, remaining: TREE_ONLY_MAX_RECOVERIES, consumed: 0 };
}

/**
 * Consume one recovery attempt. Returns the updated budget, or `null`
 * when the budget is exhausted (caller must fail explicitly).
 */
export function consumeTreeOnlyRecovery(
  budget: TreeOnlyRecoveryBudget,
): TreeOnlyRecoveryBudget | null {
  if (budget.remaining <= 0) {
    return null;
  }
  return {
    operationId: budget.operationId,
    remaining: budget.remaining - 1,
    consumed: budget.consumed + 1,
  };
}

/**
 * Native event fields recorded per tree-only operation. Screenshots
 * may be attached for reporting but never enter model payloads;
 * credentials are always redacted.
 */
export interface TreeOnlyNativeEvent {
  operationId: string;
  effectiveMode: TreeOnlyInputMode;
  modeSource: TreeOnlyModeSource;
  provider: 'typesafe';
  modelRequested: string;
  /** Actual version reported by the evaluation response. */
  modelResolved?: string;
  snapshotId?: string;
  snapshotStatus?: TreeOnlySnapshotStatus;
  candidateCount?: number;
  omittedSections?: string[];
  questionIds: string[];
  selectedRef?: string;
  distributions?: Record<string, Record<string, number>>;
  /** Type of validation performed before physical input, if any. */
  validation?: string;
  retryReason?: string;
  retryCount: number;
  durationMs?: number;
  usage?: JevUsage;
  outcome: TreeOnlyOutcome;
  errorCategory?: TreeOnlyErrorCategory;
}

/** Convenience alias for snapshot payloads carried with events. */
export type TreeOnlyEventSnapshot = TreeOnlySnapshot;
export type { TreeOnlyCandidateNode };
