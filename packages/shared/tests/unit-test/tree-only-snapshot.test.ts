import { describe, expect, it } from '@rstest/core';
import {
  TREE_ONLY_MAX_CHOICE_OPTIONS,
  TREE_ONLY_MAX_CONCRETE_CANDIDATES,
  TREE_ONLY_NO_MATCH_OPTION_ID,
  createTreeOnlyReferenceResolver,
  exceedsSingleChoiceBudget,
  isBoundsAvailable,
  isZeroAreaRect,
} from '../../src/tree-only/types';
import type { TreeOnlyAndroidNode } from '../../src/tree-only/types';

describe('tree-only snapshot contract', () => {
  it('keeps reference mappings private and snapshot-local', () => {
    const resolver = createTreeOnlyReferenceResolver('snap-1', [
      {
        ref: 'a',
        role: 'button',
        name: 'Submit',
        bounds: { left: 0, top: 0, width: 10, height: 10 },
      },
    ]);
    expect(resolver.resolve('a')?.ref).toBe('a');
    expect(resolver.resolve('stale-or-invented')).toBeNull();

    const other = createTreeOnlyReferenceResolver('snap-2', []);
    expect(other.resolve('a')).toBeNull();
    expect(other.snapshotId).not.toBe(resolver.snapshotId);
  });

  it('rejects empty snapshot identities', () => {
    expect(() => createTreeOnlyReferenceResolver('', [])).toThrow();
  });

  it('distinguishes unavailable geometry from zero-area geometry', () => {
    expect(isBoundsAvailable(null)).toBe(false);
    expect(isBoundsAvailable({ left: 0, top: 0, width: 0, height: 0 })).toBe(
      true,
    );
    expect(isZeroAreaRect({ left: 0, top: 0, width: 0, height: 5 })).toBe(true);
    expect(
      isBoundsAvailable({
        left: Number.NaN,
        top: 0,
        width: 5,
        height: 5,
      }),
    ).toBe(false);
  });

  it('preserves Android malformed bounds as unavailable, not origin taps', () => {
    const node: TreeOnlyAndroidNode = {
      ref: 'n1',
      type: 'android.widget.Button',
      attrs: { text: 'OK', bounds: '[0,0][0,0]-malformed' },
      bounds: null,
    };
    const resolver = createTreeOnlyReferenceResolver('snap-android-1', [node]);
    expect(resolver.resolve('n1')?.bounds).toBeNull();
    expect(resolver.resolve('n1')?.attrs.text).toBe('OK');
  });

  it('reserves one Choice option for no-match within the 255 maximum', () => {
    expect(TREE_ONLY_MAX_CHOICE_OPTIONS).toBe(255);
    expect(TREE_ONLY_NO_MATCH_OPTION_ID).toBe('no-match');
    expect(TREE_ONLY_MAX_CONCRETE_CANDIDATES).toBe(254);
    expect(exceedsSingleChoiceBudget(254)).toBe(false);
    expect(exceedsSingleChoiceBudget(255)).toBe(true);
  });
});
