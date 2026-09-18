import {
  classifyTreeOnlyStepOutcome,
  toTreeOnlyErrorCategory,
} from '@/tree-only/outcomes';
import { TreeOnlyOperationError } from '@/tree-only/types';
import { describe, expect, it } from '@rstest/core';

describe('tree-only execution outcome contract', () => {
  it('treats a clean attempt as confirmed execution', () => {
    const outcome = classifyTreeOnlyStepOutcome(undefined, {
      dispatched: true,
    });
    expect(outcome).toEqual({ kind: 'confirmed-execution' });
  });

  it('classifies a pre-dispatch failure as pre-execution regardless of category', () => {
    for (const category of [
      'stale-target',
      'unsupported-input',
      'malformed',
    ] as const) {
      const outcome = classifyTreeOnlyStepOutcome(
        new TreeOnlyOperationError(`${category} failure`, category),
        { dispatched: false },
      );
      expect(outcome).toMatchObject({
        kind: 'pre-execution-failure',
        category,
        reason: `${category} failure`,
      });
    }
  });

  it('classifies post-dispatch unknown failures as uncertain', () => {
    for (const error of [
      new Error('socket closed'),
      new TreeOnlyOperationError('no readback', 'uncertain'),
    ]) {
      const outcome = classifyTreeOnlyStepOutcome(error, { dispatched: true });
      expect(outcome).toMatchObject({
        kind: 'uncertain-execution',
        reason: error.message,
      });
    }
  });

  it('classifies post-dispatch permanent failures as confirmed incorrect interactions', () => {
    const outcome = classifyTreeOnlyStepOutcome(
      new TreeOnlyOperationError('element moved', 'obstruction'),
      { dispatched: true },
    );
    expect(outcome).toMatchObject({
      kind: 'confirmed-incorrect-interaction',
      category: 'obstruction',
      reason: 'element moved',
    });
  });

  it('defaults non-Error failures to service-failure evidence', () => {
    expect(toTreeOnlyErrorCategory('plain string failure')).toBe(
      'service-failure',
    );
    const outcome = classifyTreeOnlyStepOutcome('plain string failure', {
      dispatched: false,
    });
    expect(outcome).toMatchObject({
      kind: 'pre-execution-failure',
      category: 'service-failure',
      reason: 'plain string failure',
    });
  });
});
