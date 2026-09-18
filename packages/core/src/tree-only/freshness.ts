import type { LocateResultElement } from '@/types';
import type { TreeOnlyBrowserNode } from '@midscene/shared/tree-only';
import { TreeOnlyOperationError } from './types';

/**
 * T3 pre-dispatch freshness contract.
 *
 * A snapshot reference that still resolves is not proof that the selected
 * control still means the same thing: the live element can keep its identity
 * while its role, accessible name, text, or state changes. Execution must
 * compare the meaning observed at validation time against the meaning the
 * planner and Jev selected from, and refuse a stale interaction before any
 * physical input.
 */
export interface TreeOnlyTargetObservation {
  role?: string;
  name?: string;
  text?: string;
  state?: Record<string, string | boolean>;
}

export interface TreeOnlyValidatedTarget {
  element: LocateResultElement;
  /** Live meaning read from the element at validation time. */
  observation: TreeOnlyTargetObservation;
}

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
}

/**
 * Text-entry roles whose captured `text` is the current field value, not
 * identity. Values legitimately change between selection and dispatch (for
 * example after a previous typing step), so they are compared by the input
 * executor's value verification, not by target freshness.
 */
const TREE_ONLY_VALUE_TEXT_ROLES = new Set([
  'textbox',
  'searchbox',
  'spinbutton',
]);

/**
 * Roles the live accessibility helpers always report. For these, a missing
 * live role is itself a meaning change (for example a button rewritten into
 * a plain container), so the comparison must not skip it. Extraction-only
 * roles such as `img`, `text`, and `generic` keep the lenient path because
 * the live read legitimately has no role for them.
 */
const TREE_ONLY_LIVE_OBSERVABLE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'combobox',
  'textbox',
  'searchbox',
  'spinbutton',
]);

function stateDifferences(
  selected: Record<string, string | boolean> | undefined,
  live: Record<string, string | boolean> | undefined,
): string[] {
  if (!selected || !live) return [];
  const differences: string[] = [];
  for (const [key, value] of Object.entries(selected)) {
    const liveValue = live[key];
    if (liveValue !== undefined && liveValue !== value) {
      differences.push(
        `state.${key} ${JSON.stringify(value)} -> ${JSON.stringify(liveValue)}`,
      );
    }
  }
  return differences;
}

/**
 * Fail with `stale-target` when the live observation no longer matches the
 * selected snapshot node. Fields the live read cannot provide (for example
 * extraction-only roles) are skipped rather than assumed unchanged, and
 * `text` is only compared when the capture recorded it, because a name and
 * the rendered text are often the same string.
 */
export function assertTreeOnlyTargetMeaningUnchanged(
  node: TreeOnlyBrowserNode,
  observation: TreeOnlyTargetObservation,
): void {
  const differences: string[] = [];
  if (TREE_ONLY_LIVE_OBSERVABLE_ROLES.has(node.role)) {
    if (observation.role !== node.role) {
      differences.push(
        `role ${node.role} -> ${observation.role ?? 'unrecognized'}`,
      );
    }
  } else if (observation.role !== undefined && observation.role !== node.role) {
    differences.push(`role ${node.role} -> ${observation.role}`);
  }
  const beforeName = normalizedText(node.name);
  const afterName = normalizedText(observation.name);
  if (beforeName !== afterName) {
    differences.push(
      `name ${JSON.stringify(beforeName ?? null)} -> ${JSON.stringify(afterName ?? null)}`,
    );
  }
  if (node.text !== undefined && !TREE_ONLY_VALUE_TEXT_ROLES.has(node.role)) {
    const beforeText = normalizedText(node.text);
    const afterText = normalizedText(observation.text);
    if (beforeText !== afterText) {
      differences.push(
        `text ${JSON.stringify(beforeText ?? null)} -> ${JSON.stringify(afterText ?? null)}`,
      );
    }
  }
  differences.push(...stateDifferences(node.state, observation.state));
  if (differences.length > 0) {
    throw new TreeOnlyOperationError(
      `Tree target ${describeTreeOnlyTarget(node)} changed after selection (${differences.join('; ')}); refusing to run a stale interaction`,
      'stale-target',
    );
  }
}

/**
 * Whether a freshly captured node still denotes the selected control by
 * role and accessible name. Inspection uses this instead of comparing
 * refs across snapshots: references are per-capture counters, so the same
 * `rN` in a later capture can denote a different element.
 */
export function treeOnlyTargetMeaningMatches(
  selected: TreeOnlyBrowserNode,
  candidate: TreeOnlyBrowserNode,
): boolean {
  return (
    candidate.role === selected.role &&
    normalizedText(candidate.name) === normalizedText(selected.name)
  );
}

/** Compact target identity for errors, recovery notes, and history. */
export function describeTreeOnlyTarget(node: {
  ref: string;
  role: string;
  name?: string;
}): string {
  return `${node.ref} ${node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ''}`;
}
