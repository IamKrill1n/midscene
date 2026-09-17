import { describe, expect, it } from '@rstest/core';
import {
  TREE_ONLY_BROWSER_COLLECTOR,
  TREE_ONLY_PLAYWRIGHT_MIN_VERSION,
  TREE_ONLY_SUPPORTED_BROWSERS,
  type TreeOnlySnapshotPageLike,
  captureTreeOnlyBrowserSnapshot,
  probeInaccessibleFrames,
} from '../../src/playwright/snapshot-collector';

function textLeaf(
  content: string,
  rect = { left: 10, top: 10, width: 50, height: 20 },
) {
  return {
    node: {
      id: `id-${content}`,
      indexId: 1,
      nodeHashId: `hash-${content}`,
      attributes: { nodeType: 'TEXT Node' },
      nodeType: 'TEXT Node',
      content,
      rect,
      center: [35, 20] as [number, number],
      isVisible: true,
    },
    children: [],
  };
}

function mockPage(
  overrides: Partial<TreeOnlySnapshotPageLike> = {},
): TreeOnlySnapshotPageLike & { scripts: string[] } {
  const scripts: string[] = [];
  return {
    scripts,
    getElementsNodeTree: async () => ({
      node: null,
      children: [textLeaf('hello')],
    }),
    size: async () => ({ width: 1280, height: 720 }),
    evaluateJavaScript: async (script: string) => {
      scripts.push(script);
      return [];
    },
    ...overrides,
  };
}

describe('playwright tree-only snapshot capture', () => {
  it('declares the Playwright/Chromium scope and DOM collector selection', () => {
    expect(TREE_ONLY_BROWSER_COLLECTOR).toBe('midscene-dom');
    expect(TREE_ONLY_PLAYWRIGHT_MIN_VERSION).toBe('1.45.0');
    expect([...TREE_ONLY_SUPPORTED_BROWSERS]).toEqual(['chromium']);
  });

  it('captures a viewport-scoped snapshot from the DOM extractor path', async () => {
    const page = mockPage();
    const result = await captureTreeOnlyBrowserSnapshot(page, {
      snapshotId: 'snap-web-1',
    });
    expect(result.snapshot.base.snapshotId).toBe('snap-web-1');
    expect(result.snapshot.base.platform).toBe('browser');
    expect(result.snapshot.base.status).toBe('success-nonempty');
    expect(result.snapshot.nodes.map((node) => node.ref)).toEqual(['r1']);
    expect(result.resolver.resolve('r1')?.text).toBe('hello');
    expect(result.snapshot.base.viewport).toEqual({
      id: 'main',
      width: 1280,
      height: 720,
    });
  });

  it('reports a blank page as success-empty, not failure', async () => {
    const page = mockPage({
      getElementsNodeTree: async () => ({ node: null, children: [] }),
    });
    const result = await captureTreeOnlyBrowserSnapshot(page, {
      snapshotId: 'snap-web-empty',
    });
    expect(result.snapshot.base.status).toBe('success-empty');
    expect(result.snapshot.nodes).toEqual([]);
  });

  it('reports evaluate failures as failed capture with no usable evidence', async () => {
    const page = mockPage({
      getElementsNodeTree: async () => {
        throw new Error('page closed during evaluate');
      },
    });
    const result = await captureTreeOnlyBrowserSnapshot(page, {
      snapshotId: 'snap-web-failed',
    });
    expect(result.snapshot.base.status).toBe('failed');
    expect(result.snapshot.nodes).toEqual([]);
  });

  it('discloses inaccessible frames as partial coverage gaps', async () => {
    const page = mockPage({
      evaluateJavaScript: async () => [
        { index: 0, src: 'https://ads.example/', accessible: false },
        { index: 1, src: '', accessible: true },
      ],
    });
    const result = await captureTreeOnlyBrowserSnapshot(page, {
      snapshotId: 'snap-web-partial',
    });
    expect(result.snapshot.base.status).toBe('partial');
    expect(result.snapshot.base.coverageGaps).toEqual([
      {
        region: 'frame[index=0 src="https://ads.example/"]',
        reason: 'inaccessible-frame',
      },
    ]);
    expect(result.snapshot.nodes).toHaveLength(1);
  });

  it('ignores frame-probe failures instead of fabricating gaps', async () => {
    const page = mockPage({
      evaluateJavaScript: async () => {
        throw new Error('probe denied');
      },
    });
    expect(await probeInaccessibleFrames(page)).toEqual([]);
    const result = await captureTreeOnlyBrowserSnapshot(page, {
      snapshotId: 'snap-web-probe-fails',
    });
    expect(result.snapshot.base.status).toBe('success-nonempty');
    expect(result.snapshot.base.coverageGaps).toEqual([]);
  });

  it('captures without a frame probe when the page lacks evaluate', async () => {
    const page = mockPage();
    (page as Partial<TreeOnlySnapshotPageLike>).evaluateJavaScript = undefined;
    const result = await captureTreeOnlyBrowserSnapshot(page, {
      snapshotId: 'snap-web-no-probe',
    });
    expect(result.snapshot.base.status).toBe('success-nonempty');
  });

  it('excludes off-screen nodes from model evidence', async () => {
    const page = mockPage({
      getElementsNodeTree: async () => ({
        node: null,
        children: [
          textLeaf('visible'),
          textLeaf('off-screen', {
            left: 5000,
            top: 10,
            width: 50,
            height: 20,
          }),
        ],
      }),
      size: async () => ({ width: 200, height: 100 }),
    });
    const result = await captureTreeOnlyBrowserSnapshot(page, {
      snapshotId: 'snap-web-viewport',
    });
    expect(result.snapshot.nodes.map((node) => node.text)).toEqual(['visible']);
  });

  it('applies the delivery budget with disclosed omitted sections', async () => {
    const page = mockPage({
      getElementsNodeTree: async () => ({
        node: null,
        children: [textLeaf('one'), textLeaf('two'), textLeaf('three')],
      }),
    });
    const result = await captureTreeOnlyBrowserSnapshot(page, {
      snapshotId: 'snap-web-budget',
      maxNodes: 2,
    });
    expect(result.snapshot.base.delivery.truncated).toBe(true);
    expect(result.snapshot.base.delivery.omittedSections).toEqual([
      'nodes[r3-r3]',
    ]);
    expect(result.resolver.resolve('r3')?.text).toBe('three');
  });

  it('never routes capture through ariaSnapshot or screenshots', async () => {
    const page = mockPage();
    await captureTreeOnlyBrowserSnapshot(page, { snapshotId: 'snap-web-pure' });
    await probeInaccessibleFrames(page);
    for (const script of page.scripts) {
      expect(script).not.toContain('ariaSnapshot');
      expect(script).not.toContain('screenshot');
    }
  });
});
