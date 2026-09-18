import { describe, expect, it } from '@rstest/core';
import { NodeType } from '../../src/constants';
import type { ElementInfo } from '../../src/extractor';
import {
  collectTreeOnlyBrowserSnapshot,
  serializeTreeOnlyBrowserSnapshot,
} from '../../src/extractor/tree-only-collector';
import { isZeroAreaRect } from '../../src/tree-only/types';
import type { ElementTreeNode } from '../../src/types';

let idCounter = 0;

function makeInfo(
  partial: Partial<ElementInfo> & {
    nodeType: NodeType;
  },
): ElementInfo {
  idCounter += 1;
  return {
    id: `id-${idCounter}`,
    indexId: idCounter,
    nodeHashId: `hash-${idCounter}`,
    attributes: {
      nodeType: partial.nodeType,
      ...(partial.attributes ?? {}),
    },
    nodeType: partial.nodeType,
    content: partial.content ?? '',
    rect: partial.rect ?? { left: 10, top: 10, width: 50, height: 20 },
    center: [35, 20],
    isVisible: partial.isVisible ?? true,
  };
}

function leaf(info: ElementInfo): ElementTreeNode<ElementInfo> {
  return { node: info, children: [] };
}

const viewport = { id: 'main', width: 1280, height: 720 };

describe('tree-only browser collector', () => {
  it('collects visible roles, names, states, text, and geometry with snapshot-scoped refs', () => {
    const tree: ElementTreeNode<ElementInfo> = {
      node: makeInfo({ nodeType: NodeType.CONTAINER }),
      children: [
        leaf(
          makeInfo({
            nodeType: NodeType.BUTTON,
            content: 'Submit',
            attributes: { htmlTagName: '<button>' },
            rect: { left: 10, top: 20, width: 100, height: 30 },
          }),
        ),
        leaf(
          makeInfo({
            nodeType: NodeType.A,
            content: 'Docs',
            attributes: { htmlTagName: '<a>', href: '/docs' },
            rect: { left: 10, top: 60, width: 80, height: 20 },
          }),
        ),
        leaf(
          makeInfo({
            nodeType: NodeType.FORM_ITEM,
            attributes: {
              htmlTagName: '<input>',
              type: 'checkbox',
              checked: '',
              disabled: '',
            },
            rect: { left: 10, top: 90, width: 16, height: 16 },
          }),
        ),
        leaf(
          makeInfo({
            nodeType: NodeType.TEXT,
            content: 'Hello world',
            rect: { left: 10, top: 120, width: 200, height: 20 },
          }),
        ),
        leaf(
          makeInfo({
            nodeType: NodeType.IMG,
            attributes: { alt: 'logo' },
            rect: { left: 10, top: 150, width: 40, height: 40 },
          }),
        ),
      ],
    };

    const result = collectTreeOnlyBrowserSnapshot(tree, {
      snapshotId: 'snap-roles',
      viewport,
      capturedAt: 1700000000000,
    });

    expect(result.snapshot.base.snapshotId).toBe('snap-roles');
    expect(result.snapshot.base.platform).toBe('browser');
    expect(result.snapshot.base.status).toBe('success-nonempty');
    expect(result.snapshot.base.delivery.truncated).toBe(false);
    expect(result.snapshot.nodes.map((node) => node.ref)).toEqual([
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
      'r6',
    ]);
    expect(result.snapshot.nodes.map((node) => node.role)).toEqual([
      'generic',
      'button',
      'link',
      'checkbox',
      'text',
      'img',
    ]);
    expect(result.snapshot.nodes[1].name).toBe('Submit');
    expect(result.snapshot.nodes[2]).toMatchObject({
      role: 'link',
      name: 'Docs',
    });
    expect(result.snapshot.nodes[3].state).toMatchObject({
      checked: true,
      disabled: true,
      inputType: 'checkbox',
    });
    expect(result.snapshot.nodes[4].text).toBe('Hello world');
    expect(result.snapshot.nodes[5].name).toBe('logo');
    expect(result.snapshot.nodes[1].bounds).toEqual({
      left: 10,
      top: 20,
      width: 100,
      height: 30,
    });
    expect(result.resolver.resolve('r1')?.role).toBe('generic');
    expect(result.resolver.resolve('invented')).toBeNull();
    expect(result.backend.get('r2')?.id).toMatch(/^id-/);

    // Backend handles never leak into the serializable snapshot.
    const serialized = serializeTreeOnlyBrowserSnapshot(result.snapshot);
    expect(serialized).toContain('[r2] button');
    expect(serialized).not.toContain('hash-');
    expect(serialized).not.toContain('id-2');
  });

  it('excludes off-screen nodes while keeping the visible accessible name', () => {
    const tree: ElementTreeNode<ElementInfo> = {
      node: null,
      children: [
        leaf(
          makeInfo({
            nodeType: NodeType.BUTTON,
            content: 'Save',
            attributes: {
              htmlTagName: '<button>',
              'aria-label': 'Save document',
            },
            rect: { left: 10, top: 10, width: 50, height: 20 },
          }),
        ),
        leaf(
          makeInfo({
            nodeType: NodeType.BUTTON,
            content: 'Far away',
            rect: { left: 2000, top: 10, width: 50, height: 20 },
          }),
        ),
        leaf(
          makeInfo({
            nodeType: NodeType.TEXT,
            content: 'Below the fold',
            rect: { left: 10, top: 2000, width: 100, height: 20 },
          }),
        ),
      ],
    };

    const result = collectTreeOnlyBrowserSnapshot(tree, {
      snapshotId: 'snap-viewport',
      viewport,
    });

    expect(result.snapshot.base.status).toBe('success-nonempty');
    expect(result.snapshot.nodes).toHaveLength(1);
    expect(result.snapshot.nodes[0].name).toBe('Save document');
    const serialized = serializeTreeOnlyBrowserSnapshot(result.snapshot);
    expect(serialized).not.toContain('Far away');
    expect(serialized).not.toContain('Below the fold');
  });

  it('distinguishes empty, partial, and failed capture without relabeling', () => {
    const empty = collectTreeOnlyBrowserSnapshot(
      { node: null, children: [] },
      { snapshotId: 'snap-empty', viewport },
    );
    expect(empty.snapshot.base.status).toBe('success-empty');
    expect(empty.snapshot.nodes).toEqual([]);

    const partialEmpty = collectTreeOnlyBrowserSnapshot(
      { node: null, children: [] },
      {
        snapshotId: 'snap-partial-empty',
        viewport,
        coverageGaps: [
          { region: 'frame[id="ads"]', reason: 'inaccessible-frame' },
        ],
      },
    );
    expect(partialEmpty.snapshot.base.status).toBe('partial');
    expect(partialEmpty.snapshot.base.coverageGaps).toHaveLength(1);

    const failed = collectTreeOnlyBrowserSnapshot(null, {
      snapshotId: 'snap-failed',
      viewport,
      captureError: 'page closed during evaluate',
    });
    expect(failed.snapshot.base.status).toBe('failed');
    expect(failed.snapshot.nodes).toEqual([]);

    const partialWithNodes = collectTreeOnlyBrowserSnapshot(
      {
        node: null,
        children: [
          leaf(makeInfo({ nodeType: NodeType.TEXT, content: 'kept' })),
        ],
      },
      {
        snapshotId: 'snap-partial-nodes',
        viewport,
        captureError: 'child frame unreadable',
      },
    );
    expect(partialWithNodes.snapshot.base.status).toBe('partial');
    expect(partialWithNodes.snapshot.nodes).toHaveLength(1);
    expect(partialWithNodes.snapshot.base.coverageGaps).toEqual([
      { region: 'document', reason: 'child frame unreadable' },
    ]);
  });

  it('discloses oversized delivery with omitted handles instead of truncating silently', () => {
    const children = Array.from({ length: 5 }, (_, index) =>
      leaf(
        makeInfo({
          nodeType: NodeType.TEXT,
          content: `row ${index + 1}`,
          rect: { left: 10, top: 10 + index * 30, width: 100, height: 20 },
        }),
      ),
    );
    const result = collectTreeOnlyBrowserSnapshot(
      { node: null, children },
      { snapshotId: 'snap-over', viewport, maxNodes: 2 },
    );

    expect(result.snapshot.base.delivery.truncated).toBe(true);
    expect(result.snapshot.base.delivery.omittedSections).toEqual([
      'nodes[r3-r5]',
    ]);
    expect(result.snapshot.nodes).toHaveLength(2);
    expect(result.retainedNodes).toHaveLength(5);
    // Withheld nodes stay resolvable for bounded same-snapshot expansion.
    expect(result.resolver.resolve('r5')?.text).toBe('row 5');
    const serialized = serializeTreeOnlyBrowserSnapshot(result.snapshot);
    expect(serialized).toContain('nodes[r3-r5]');
    expect(serialized).toContain('snap-over');
  });

  it('flags Choice-budget overflow on oversized delivery for T08 expansion', () => {
    const children = Array.from({ length: 260 }, (_, index) =>
      leaf(
        makeInfo({
          nodeType: NodeType.TEXT,
          content: `row ${index + 1}`,
          rect: { left: 10, top: 10, width: 100, height: 20 },
        }),
      ),
    );
    const result = collectTreeOnlyBrowserSnapshot(
      { node: null, children },
      { snapshotId: 'snap-huge', viewport, maxNodes: 10 },
    );
    expect(result.snapshot.base.delivery.truncated).toBe(true);
    expect(result.snapshot.base.delivery.omittedSections).toEqual([
      'nodes[r11-r260]',
      'choice-budget(254-concrete-max)',
    ]);
  });

  it('preserves unavailable geometry as null and keeps zero-area distinct', () => {
    const tree: ElementTreeNode<ElementInfo> = {
      node: null,
      children: [
        leaf(
          makeInfo({
            nodeType: NodeType.TEXT,
            content: 'malformed',
            rect: { left: Number.NaN, top: 0, width: 10, height: 10 },
          }),
        ),
        leaf(
          makeInfo({
            nodeType: NodeType.TEXT,
            content: 'zero area',
            rect: { left: 10, top: 10, width: 0, height: 20 },
          }),
        ),
        leaf(
          makeInfo({
            nodeType: NodeType.TEXT,
            content: 'zero area off-screen',
            rect: { left: 5000, top: 10, width: 0, height: 20 },
          }),
        ),
      ],
    };
    const result = collectTreeOnlyBrowserSnapshot(tree, {
      snapshotId: 'snap-geometry',
      viewport,
    });
    expect(result.snapshot.nodes).toHaveLength(2);
    expect(result.snapshot.nodes[0].bounds).toBeNull();
    expect(result.snapshot.nodes[0].text).toBe('malformed');
    expect(result.snapshot.nodes[1].bounds).toEqual({
      left: 10,
      top: 10,
      width: 0,
      height: 20,
    });
    expect(isZeroAreaRect(result.snapshot.nodes[1].bounds!)).toBe(true);
  });

  it('never treats ARIA text as executable references', () => {
    const tree: ElementTreeNode<ElementInfo> = {
      node: null,
      children: [
        leaf(
          makeInfo({
            nodeType: NodeType.BUTTON,
            content: '- button "Hi" [ref=e12]',
            rect: { left: 10, top: 10, width: 60, height: 20 },
          }),
        ),
        leaf(
          makeInfo({
            nodeType: NodeType.TEXT,
            content: '[ref=e99]',
            rect: { left: 10, top: 40, width: 60, height: 20 },
          }),
        ),
      ],
    };
    const result = collectTreeOnlyBrowserSnapshot(tree, {
      snapshotId: 'snap-aria',
      viewport,
    });
    expect(result.resolver.refs()).toEqual(['r1', 'r2']);
    expect(result.resolver.resolve('e12')).toBeNull();
    expect(result.resolver.resolve('e99')).toBeNull();
  });

  it('records frame and shadow boundaries with clipped geometry', () => {
    const tree: ElementTreeNode<ElementInfo> = {
      node: null,
      children: [
        leaf(
          makeInfo({
            nodeType: NodeType.BUTTON,
            content: 'Clipped',
            rect: { left: 1200, top: 100, width: 200, height: 50 },
          }),
        ),
      ],
    };
    const result = collectTreeOnlyBrowserSnapshot(tree, {
      snapshotId: 'snap-frame',
      viewport,
      frameId: 'frame-1',
      shadowBoundary: true,
    });
    expect(result.snapshot.nodes[0].frameId).toBe('frame-1');
    expect(result.snapshot.nodes[0].shadowBoundary).toBe(true);
    expect(result.snapshot.nodes[0].bounds).toEqual({
      left: 1200,
      top: 100,
      width: 200,
      height: 50,
    });
    expect(result.snapshot.nodes[0].clippedBounds).toEqual({
      left: 1200,
      top: 100,
      width: 80,
      height: 50,
    });
  });

  it('drops browser internals such as CSS classes from model evidence', () => {
    const tree: ElementTreeNode<ElementInfo> = {
      node: null,
      children: [
        leaf(
          makeInfo({
            nodeType: NodeType.BUTTON,
            content: 'Styled',
            attributes: {
              htmlTagName: '<button>',
              class: '.btn.primary',
              style: 'color: red;',
            },
            rect: { left: 10, top: 10, width: 60, height: 20 },
          }),
        ),
      ],
    };
    const result = collectTreeOnlyBrowserSnapshot(tree, {
      snapshotId: 'snap-clean',
      viewport,
    });
    const serialized = serializeTreeOnlyBrowserSnapshot(result.snapshot);
    expect(serialized).not.toContain('.btn');
    expect(serialized).not.toContain('color: red');
  });

  it('applies in-page accessibility overrides for names, roles, and state', () => {
    const amenity = makeInfo({
      nodeType: NodeType.BUTTON,
      attributes: {
        htmlTagName: '<button>',
        role: 'checkbox',
        'aria-checked': 'false',
        value: 'on',
      },
      rect: { left: 10, top: 10, width: 16, height: 16 },
    });
    const linkAsText = makeInfo({
      nodeType: NodeType.TEXT,
      content: 'Login',
      attributes: { htmlTagName: '<a>', href: '/login' },
      rect: { left: 10, top: 40, width: 38, height: 20 },
    });
    const tree: ElementTreeNode<ElementInfo> = {
      node: null,
      children: [leaf(amenity), leaf(linkAsText)],
    };

    const result = collectTreeOnlyBrowserSnapshot(tree, {
      snapshotId: 'snap-a11y',
      viewport,
      accessibility: {
        [amenity.id]: {
          role: 'checkbox',
          name: 'WiFi',
          state: { checked: false, disabled: false },
        },
        [linkAsText.id]: { role: 'link', name: 'Login', state: {} },
      },
    });

    expect(result.snapshot.nodes[0]).toMatchObject({
      role: 'checkbox',
      name: 'WiFi',
      state: { checked: false, disabled: false },
    });
    expect(result.snapshot.nodes[1]).toMatchObject({
      role: 'link',
      name: 'Login',
    });
  });

  it('never mistakes ARIA false or checkbox values for names or checked state', () => {
    const amenity = makeInfo({
      nodeType: NodeType.BUTTON,
      attributes: {
        htmlTagName: '<button>',
        role: 'checkbox',
        'aria-checked': 'false',
        value: 'on',
      },
    });
    const disabled = makeInfo({
      nodeType: NodeType.BUTTON,
      content: 'Maybe',
      attributes: { htmlTagName: '<button>', 'aria-disabled': 'false' },
    });
    const result = collectTreeOnlyBrowserSnapshot(
      { node: null, children: [leaf(amenity), leaf(disabled)] },
      {
        snapshotId: 'snap-state',
        viewport,
        accessibility: { [amenity.id]: { role: 'checkbox' } },
      },
    );

    // Without DOM label evidence the submission value "on" is no name.
    expect(result.snapshot.nodes[0].name).toBeUndefined();
    expect(result.snapshot.nodes[0].state).toMatchObject({ checked: false });
    expect(result.snapshot.nodes[0].state?.checked).not.toBe(true);
    expect(result.snapshot.nodes[1].state).toMatchObject({ disabled: false });
  });

  it('collapses nested interactive duplicates at identical geometry and label', () => {
    const rect = { left: 10, top: 10, width: 200, height: 36 };
    const outer = makeInfo({
      nodeType: NodeType.A,
      content: 'View Details',
      attributes: { htmlTagName: '<a>', href: '/homestay/2' },
      rect,
    });
    const inner = makeInfo({
      nodeType: NodeType.BUTTON,
      content: 'View Details',
      attributes: { htmlTagName: '<button>' },
      rect,
    });
    const nested: ElementTreeNode<ElementInfo> = {
      node: outer,
      children: [{ node: inner, children: [] }],
    };
    const result = collectTreeOnlyBrowserSnapshot(
      { node: null, children: [nested] },
      { snapshotId: 'snap-dedupe', viewport },
    );

    expect(result.snapshot.nodes).toHaveLength(1);
    expect(result.snapshot.nodes[0]).toMatchObject({
      role: 'link',
      name: 'View Details',
    });

    const favorite = makeInfo({
      nodeType: NodeType.BUTTON,
      content: 'Save',
      attributes: { htmlTagName: '<button>' },
      rect,
    });
    const distinct = collectTreeOnlyBrowserSnapshot(
      {
        node: null,
        children: [
          { node: outer, children: [{ node: favorite, children: [] }] },
        ],
      },
      { snapshotId: 'snap-dedupe-distinct', viewport },
    );
    expect(distinct.snapshot.nodes).toHaveLength(2);
    expect(distinct.snapshot.nodes.map((node) => node.role)).toEqual([
      'link',
      'button',
    ]);
  });

  it('keeps extractor roles when an override promises an unsupported role', () => {
    const trigger = makeInfo({
      nodeType: NodeType.BUTTON,
      content: 'All Stays',
      attributes: {
        htmlTagName: '<button>',
        role: 'combobox',
        'aria-expanded': 'false',
      },
    });
    const toggle = makeInfo({
      nodeType: NodeType.BUTTON,
      content: 'WiFi',
      attributes: { htmlTagName: '<button>', role: 'switch' },
    });
    const result = collectTreeOnlyBrowserSnapshot(
      { node: null, children: [leaf(trigger), leaf(toggle)] },
      {
        snapshotId: 'snap-roles',
        viewport,
        accessibility: {
          [trigger.id]: { role: 'combobox', name: 'All Stays' },
          [toggle.id]: { role: 'switch', name: 'WiFi' },
        },
      },
    );

    expect(result.snapshot.nodes[0]).toMatchObject({
      role: 'button',
      name: 'All Stays',
      state: { expanded: false },
    });
    expect(result.snapshot.nodes[1]).toMatchObject({
      role: 'switch',
      name: 'WiFi',
    });
  });

  it('maps reset and image submit controls to buttons', () => {
    const result = collectTreeOnlyBrowserSnapshot(
      {
        node: null,
        children: [
          leaf(
            makeInfo({
              nodeType: NodeType.FORM_ITEM,
              attributes: {
                htmlTagName: '<input>',
                type: 'reset',
                value: 'Clear',
              },
            }),
          ),
          leaf(
            makeInfo({
              nodeType: NodeType.FORM_ITEM,
              attributes: {
                htmlTagName: '<input>',
                type: 'image',
                alt: 'Search',
              },
            }),
          ),
        ],
      },
      { snapshotId: 'snap-input-types', viewport },
    );
    expect(result.snapshot.nodes.map((node) => node.role)).toEqual([
      'button',
      'button',
    ]);
  });

  it('rejects invalid viewport and budget options', () => {
    expect(() =>
      collectTreeOnlyBrowserSnapshot(
        { node: null, children: [] },
        { snapshotId: 'snap-bad', viewport: { id: '', width: 0, height: 0 } },
      ),
    ).toThrow();
    expect(() =>
      collectTreeOnlyBrowserSnapshot(
        { node: null, children: [] },
        { snapshotId: 'snap-bad-budget', viewport, maxNodes: 0 },
      ),
    ).toThrow();
  });
});
