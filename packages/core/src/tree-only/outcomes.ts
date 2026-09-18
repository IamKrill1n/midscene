import {
  type TreeOnlyErrorCategory,
  TreeOnlyOperationError,
  isPermanentTreeOnlyError,
} from './types';

/**
 * T3 execution-outcome contract shared by the planner, the runner, and the
 * input executor.
 *
 * One interaction step ends in exactly one of these outcomes:
 *
 * - `pre-execution-failure`: the interaction never reached physical input
 *   (capture, planning, selection, freshness validation, or pre-dispatch
 *   setup failed). The shared recovery budget still decides whether a
 *   transient failure may replan; permanent categories fail immediately.
 * - `confirmed-execution`: physical input was dispatched and the executor
 *   reported completion. (Value verification for typed input belongs to the
 *   input executor; a returned call alone is not proof of entry.)
 * - `confirmed-incorrect-interaction`: physical input was dispatched and the
 *   executor reported a definitive failure. The step fails permanently;
 *   later goal completion cannot turn it into a pass.
 * - `uncertain-execution`: physical input may have been dispatched but the
 *   outcome is unknown. It is inspected from fresh evidence and never
 *   blindly repeated.
 */
export type TreeOnlyStepOutcome =
  | TreeOnlyPreExecutionFailure
  | TreeOnlyConfirmedExecution
  | TreeOnlyConfirmedIncorrectInteraction
  | TreeOnlyUncertainExecution;

export interface TreeOnlyPreExecutionFailure {
  kind: 'pre-execution-failure';
  category: TreeOnlyErrorCategory;
  reason: string;
}

export interface TreeOnlyConfirmedExecution {
  kind: 'confirmed-execution';
}

export interface TreeOnlyConfirmedIncorrectInteraction {
  kind: 'confirmed-incorrect-interaction';
  category: TreeOnlyErrorCategory;
  reason: string;
}

export interface TreeOnlyUncertainInspection {
  /** True when fresh evidence was captured; `detail` then describes it. */
  captured: boolean;
  detail?: string;
  error?: string;
}

export interface TreeOnlyUncertainExecution {
  kind: 'uncertain-execution';
  category: TreeOnlyErrorCategory;
  reason: string;
}

/** Normalize an arbitrary failure into the tree-only error categories. */
export function toTreeOnlyErrorCategory(error: unknown): TreeOnlyErrorCategory {
  if (error instanceof TreeOnlyOperationError) {
    return error.category;
  }
  return 'service-failure';
}

export interface ClassifyTreeOnlyStepOutcomeOptions {
  /** True once the pre-dispatch callback ran and physical input may exist. */
  dispatched: boolean;
}

/**
 * Classify a step result. `error` is the thrown failure, if any; the
 * no-error case (a completed attempt) is classified as confirmed
 * execution. Thrown failures are split by whether physical input may
 * already have been dispatched.
 */
export function classifyTreeOnlyStepOutcome(
  error: unknown,
  options: ClassifyTreeOnlyStepOutcomeOptions,
): TreeOnlyStepOutcome {
  if (error === undefined || error === null) {
    return { kind: 'confirmed-execution' };
  }
  const category = toTreeOnlyErrorCategory(error);
  const reason = error instanceof Error ? error.message : String(error);
  if (!options.dispatched) {
    return {
      kind: 'pre-execution-failure',
      category,
      reason,
    };
  }
  if (isPermanentTreeOnlyError(category)) {
    return { kind: 'confirmed-incorrect-interaction', category, reason };
  }
  return { kind: 'uncertain-execution', category, reason };
}
