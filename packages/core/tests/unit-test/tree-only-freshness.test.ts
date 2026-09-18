import {
  assertTreeOnlyTargetMeaningUnchanged,
  describeTreeOnlyTarget,
  treeOnlyTargetMeaningMatches,
} from '@/tree-only/freshness';
import { TreeOnlyOperationError } from '@/tree-only/types';
import { describe, expect, it } from '@rstest/core';

const node = {
  ref: 'r1',
  role: 'button',
  name: 'Save',
  state: { disabled: false, checked: false },
  bounds: { left: 0, top: 0, width: 10, height: 10 },
};

describe('tree-only target freshness', () => {
  it('accepts unchanged live meaning', () => {
    expect(() =>
      assertTreeOnlyTargetMeaningUnchanged(node, {
        role: 'button',
        name: 'Save',
        state: { disabled: false, checked: false },
      }),
    ).not.toThrow();
  });

  it('normalizes whitespace before comparing names and text', () => {
    expect(() =>
      assertTreeOnlyTargetMeaningUnchanged(
        { ...node, text: 'Save now' },
        { role: 'button', name: '  Save\n', text: 'Save   now' },
      ),
    ).not.toThrow();
  });

  it('rejects a changed name even when the reference still resolves', () => {
    let error: unknown;
    try {
      assertTreeOnlyTargetMeaningUnchanged(node, {
        role: 'button',
        name: 'Delete',
        state: { disabled: false, checked: false },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TreeOnlyOperationError);
    expect((error as TreeOnlyOperationError).category).toBe('stale-target');
    expect((error as Error).message).toContain('Save');
    expect((error as Error).message).toContain('Delete');
  });

  it('rejects a changed role, removed name, and changed text', () => {
    expect(() =>
      assertTreeOnlyTargetMeaningUnchanged(node, {
        role: 'link',
        name: 'Save',
      }),
    ).toThrow(/changed/);
    expect(() =>
      assertTreeOnlyTargetMeaningUnchanged(node, { role: 'button', name: '' }),
    ).toThrow(/changed/);
    expect(() =>
      assertTreeOnlyTargetMeaningUnchanged(
        { ...node, text: 'Save now' },
        {
          role: 'button',
          name: 'Save',
          text: 'Delete now',
        },
      ),
    ).toThrow(/changed/);
  });

  it('rejects changed truthy state but ignores state the live read cannot see', () => {
    expect(() =>
      assertTreeOnlyTargetMeaningUnchanged(node, {
        role: 'button',
        name: 'Save',
        state: { disabled: false, checked: true },
      }),
    ).toThrow(/checked/);
    expect(() =>
      assertTreeOnlyTargetMeaningUnchanged(
        { ...node, state: { disabled: false, inputType: 'text' } },
        { role: 'button', name: 'Save', state: { disabled: false } },
      ),
    ).not.toThrow();
  });

  it('does not infer a text change when the capture never recorded text', () => {
    expect(() =>
      assertTreeOnlyTargetMeaningUnchanged(node, {
        role: 'button',
        name: 'Save',
        text: 'Save',
      }),
    ).not.toThrow();
  });

  it('ignores captured value text for text-entry roles', () => {
    expect(() =>
      assertTreeOnlyTargetMeaningUnchanged(
        { ...node, role: 'textbox', name: 'Name', text: 'Alice' },
        { role: 'textbox', name: 'Name', text: '' },
      ),
    ).not.toThrow();
    expect(() =>
      assertTreeOnlyTargetMeaningUnchanged(
        { ...node, role: 'textbox', name: 'Name', text: 'Alice' },
        { role: 'textbox', name: 'Name', text: 'Bob' },
      ),
    ).not.toThrow();
  });

  it('rejects a missing live role for roles the live read always reports', () => {
    expect(() =>
      assertTreeOnlyTargetMeaningUnchanged(node, { name: 'Save' }),
    ).toThrow(/role button -> unrecognized/);
  });

  it('tolerates a missing live role for extraction-only roles like img', () => {
    expect(() =>
      assertTreeOnlyTargetMeaningUnchanged(
        { ...node, role: 'img', name: 'Logo' },
        { name: 'Logo' },
      ),
    ).not.toThrow();
  });

  it('matches targets by role and normalized name across captures', () => {
    expect(
      treeOnlyTargetMeaningMatches(node, {
        ref: 'r9',
        role: 'button',
        name: '  Save ',
        bounds: { left: 5, top: 5, width: 10, height: 10 },
      }),
    ).toBe(true);
    expect(
      treeOnlyTargetMeaningMatches(node, {
        ref: 'r1',
        role: 'button',
        name: 'Delete',
        bounds: { left: 0, top: 0, width: 10, height: 10 },
      }),
    ).toBe(false);
    expect(
      treeOnlyTargetMeaningMatches(node, {
        ref: 'r1',
        role: 'link',
        name: 'Save',
        bounds: { left: 0, top: 0, width: 10, height: 10 },
      }),
    ).toBe(false);
  });

  it('describes the selected target for errors and recovery notes', () => {
    expect(describeTreeOnlyTarget(node)).toBe('r1 button "Save"');
    expect(describeTreeOnlyTarget({ ...node, name: undefined })).toBe(
      'r1 button',
    );
  });
});
