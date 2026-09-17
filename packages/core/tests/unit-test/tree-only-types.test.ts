import {
  TREE_ONLY_FILE_OWNERSHIP,
  TREE_ONLY_SHARED_INTERFACES,
} from '@/tree-only/ownership';
import {
  TREE_ONLY_MAX_RECOVERIES,
  TreeOnlyOperationError,
  assertSupportedInputMode,
  consumeTreeOnlyRecovery,
  createTreeOnlyRecoveryBudget,
  isPermanentTreeOnlyError,
  isTreeOnlyOperationSupported,
  validateJevAnswers,
} from '@/tree-only/types';
import type { JevAnswer, JevQuestion } from '@/tree-only/types';
import { describe, expect, it } from '@rstest/core';

const choiceQuestion: JevQuestion = {
  id: 'q-target',
  kind: 'choice',
  prompt: 'Which candidate matches "Submit"?',
  options: [
    { id: 'a', label: 'Submit button' },
    { id: 'no-match', label: 'No match' },
  ],
};

describe('tree-only operation contracts', () => {
  it('accepts visual and tree-only modes and rejects hybrid', () => {
    expect(() => assertSupportedInputMode('visual')).not.toThrow();
    expect(() => assertSupportedInputMode('tree-only')).not.toThrow();
    expect(() => assertSupportedInputMode('hybrid')).toThrow();
    expect(() => assertSupportedInputMode('unknown')).toThrow();
    expect(() => assertSupportedInputMode(null)).toThrow();
    expect(() => assertSupportedInputMode(undefined)).toThrow();
  });

  it('keeps capability declarations opt-in for legacy adapters', () => {
    expect(isTreeOnlyOperationSupported(undefined, 'locate')).toBe(false);
    expect(isTreeOnlyOperationSupported({}, 'insight')).toBe(false);
    expect(
      isTreeOnlyOperationSupported(
        { treeOnly: { locate: { protocolVersion: '1' } } },
        'locate',
      ),
    ).toBe(true);
    expect(
      isTreeOnlyOperationSupported(
        { treeOnly: { locate: { protocolVersion: '1' } } },
        'planning',
      ),
    ).toBe(false);
  });

  it('validates Jev question/answer IDs and types distinctly', () => {
    const valid: JevAnswer[] = [
      { questionId: 'q-target', kind: 'choice', optionId: 'a' },
    ];
    expect(() => validateJevAnswers([choiceQuestion], valid)).not.toThrow();

    expect(() =>
      validateJevAnswers(
        [choiceQuestion],
        [{ questionId: 'q-unknown', kind: 'choice', optionId: 'a' }],
      ),
    ).toThrow(/unknown question/);

    expect(() =>
      validateJevAnswers(
        [choiceQuestion],
        [{ questionId: 'q-target', kind: 'noul', probabilityYes: 0.9 }],
      ),
    ).toThrow(/does not match/);

    expect(() =>
      validateJevAnswers(
        [choiceQuestion],
        [{ questionId: 'q-target', kind: 'choice', optionId: 'invented' }],
      ),
    ).toThrow(/unknown option/);

    expect(() =>
      validateJevAnswers(
        [{ id: 'q-yn', kind: 'noul', statement: 'The form is submitted.' }],
        [{ questionId: 'q-yn', kind: 'noul', probabilityYes: 1.5 }],
      ),
    ).toThrow(/out-of-range probability/);
  });

  it('shares one recovery budget of two across the operation', () => {
    expect(TREE_ONLY_MAX_RECOVERIES).toBe(2);
    expect(() => createTreeOnlyRecoveryBudget('')).toThrow();
    let budget = createTreeOnlyRecoveryBudget('op-1');
    budget = consumeTreeOnlyRecovery(budget)!;
    expect(budget.remaining).toBe(1);
    budget = consumeTreeOnlyRecovery(budget)!;
    expect(budget.remaining).toBe(0);
    expect(consumeTreeOnlyRecovery(budget)).toBeNull();
  });

  it('fails permanent errors immediately and retries the transient rest', () => {
    for (const category of [
      'unsupported-operation',
      'unsupported-input',
      'obstruction',
      'cancelled',
      'deadline',
      'budget-exhausted',
      'malformed',
      'missing',
    ] as const) {
      expect(isPermanentTreeOnlyError(category)).toBe(true);
      expect(new TreeOnlyOperationError('x', category).retryable).toBe(false);
    }
    for (const category of [
      'service-failure',
      'stale-target',
      'uncertain-delivery',
      'uncertain',
      'no-match',
    ] as const) {
      expect(isPermanentTreeOnlyError(category)).toBe(false);
      expect(new TreeOnlyOperationError('x', category).retryable).toBe(true);
    }
  });

  it('maps every parallel workstream to an owner before edits', () => {
    expect(TREE_ONLY_SHARED_INTERFACES.length).toBeGreaterThan(0);
    for (const area of [
      'configuration',
      'transport',
      'lifecycle',
      'capture',
      'requestBoundary',
      'selection',
      'validation',
      'reporting',
      'android',
    ]) {
      expect(TREE_ONLY_FILE_OWNERSHIP[area]?.owner).toBeTruthy();
      expect(TREE_ONLY_FILE_OWNERSHIP[area]?.files.length).toBeGreaterThan(0);
    }
  });
});
