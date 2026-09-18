import { treeOnlySupportedActions } from '@/tree-only/runtime';
import type { TreeOnlyBrowserNode } from '@midscene/shared/tree-only';
import { describe, expect, it } from '@rstest/core';

const bounds = { left: 0, top: 0, width: 100, height: 30 };

function node(
  partial: Partial<TreeOnlyBrowserNode> & Pick<TreeOnlyBrowserNode, 'role'>,
): TreeOnlyBrowserNode {
  return {
    ref: 'r1',
    bounds,
    ...partial,
  };
}

describe('tree-only supported actions', () => {
  it('offers text entry for textbox-like roles only', () => {
    for (const role of ['textbox', 'searchbox', 'spinbutton']) {
      expect(treeOnlySupportedActions(node({ role }))).toEqual([
        'CLICK',
        'TYPE_TEXT',
      ]);
    }
    expect(
      treeOnlySupportedActions(
        node({ role: 'textbox', state: { readonly: true } }),
      ),
    ).toEqual([]);
  });

  it('offers clicks for switches and other clickable roles', () => {
    for (const role of [
      'button',
      'link',
      'checkbox',
      'radio',
      'switch',
      'tab',
      'menuitem',
      'option',
    ]) {
      expect(treeOnlySupportedActions(node({ role }))).toEqual(['CLICK']);
    }
  });

  it('never offers unsupported input types as text entry', () => {
    for (const inputType of ['file', 'range', 'color']) {
      expect(
        treeOnlySupportedActions(
          node({ role: 'textbox', state: { inputType } }),
        ),
      ).toEqual([]);
    }
    expect(
      treeOnlySupportedActions(
        node({ role: 'textbox', state: { inputType: 'date' } }),
      ),
    ).toEqual(['CLICK', 'TYPE_TEXT']);
  });

  it('excludes disabled, zero-area, and unmeasured nodes', () => {
    expect(
      treeOnlySupportedActions(
        node({ role: 'button', state: { disabled: true } }),
      ),
    ).toEqual([]);
    expect(
      treeOnlySupportedActions(node({ role: 'button', bounds: null })),
    ).toEqual([]);
    expect(
      treeOnlySupportedActions(
        node({
          role: 'button',
          bounds: { left: 0, top: 0, width: 0, height: 10 },
        }),
      ),
    ).toEqual([]);
    expect(treeOnlySupportedActions(node({ role: 'generic' }))).toEqual([]);
  });
});
