import { defaultViewportSize } from '@/common/viewport';
import type { ElementTreeNode } from '@midscene/core';
import {
  TREE_ONLY_BROWSER_COLLECTOR,
  type TreeOnlyBrowserCollectResult,
  type TreeOnlyBrowserCollectViewport,
  collectTreeOnlyBrowserSnapshot,
} from '@midscene/shared/extractor';
import type { TreeOnlyCoverageGap } from '@midscene/shared/tree-only';

/**
 * T05 Playwright browser capture for tree-only operation.
 *
 * Collector selection: the owned Midscene DOM-derived extractor reached
 * through `WebPage.getElementsNodeTree()` (the same `webExtractNodeTree()`
 * evaluate path the visual mode uses for element evidence). This capture
 * never calls `locator.ariaSnapshot()`: the pinned Playwright's public
 * snapshot returns YAML text with no executable references and no
 * geometry, so ARIA text cannot serve as an executable target. It never
 * takes screenshots and never handles credentials; report-only
 * screenshots stay outside this path (T07/T10 own those boundaries).
 *
 * Supported scope: Playwright with Chromium first. The minimum version
 * follows the package's peer range; the verified version is the
 * Playwright actually exercised when this collector landed.
 */
export const TREE_ONLY_PLAYWRIGHT_MIN_VERSION = '1.45.0';
export const TREE_ONLY_PLAYWRIGHT_VERIFIED_VERSION = '1.58.1';
export const TREE_ONLY_SUPPORTED_BROWSERS = ['chromium'] as const;
export { TREE_ONLY_BROWSER_COLLECTOR };

/**
 * Minimal page surface this capture needs. It mirrors the `WebPage`
 * methods (`getElementsNodeTree`, `size`, `evaluateJavaScript`) without
 * importing Playwright, so unit tests can use mocks and other browser
 * integrations stay out of scope until validated.
 */
export interface TreeOnlySnapshotPageLike {
  getElementsNodeTree(): Promise<ElementTreeNode<any>>;
  size(): Promise<{ width: number; height: number }>;
  evaluateJavaScript?(script: string): Promise<unknown>;
}

export interface TreeOnlyBrowserCaptureOptions {
  /** Snapshot identity; generated when omitted. */
  snapshotId?: string;
  /** Wall-clock capture time in milliseconds. */
  capturedAt?: number;
  /**
   * Viewport identity carried on the snapshot for navigation detection.
   * Defaults to `main`. Snapshot identity (not this id) is the primary
   * freshness key; T09 revalidates geometry before input.
   */
  viewportId?: string;
  /** Owning frame applied to nodes in this batch (default `main`). */
  frameId?: string;
  /** Known coverage gaps from the caller, preserved verbatim. */
  coverageGaps?: TreeOnlyCoverageGap[];
  /** Delivery budget; see the shared collector default. */
  maxNodes?: number;
}

interface FrameProbeEntry {
  index?: number;
  src?: string;
  accessible?: boolean;
}

const FRAME_PROBE_SCRIPT = `Array.from(document.querySelectorAll('iframe')).map((frame, index) => {
  let accessible = false;
  try {
    accessible = !!frame.contentDocument;
  } catch (e) {
    accessible = false;
  }
  return { index, src: frame.getAttribute('src') || '', accessible };
})`;

function describeFrameProbeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Best-effort disclosure of inaccessible (usually cross-origin) frames.
 * Probe failures are ignored: unknown coverage remains unknown rather
 * than becoming a fabricated gap. The DOM extractor already merges
 * same-origin iframe content; only inaccessible frames surface here.
 */
export async function probeInaccessibleFrames(
  page: TreeOnlySnapshotPageLike,
): Promise<TreeOnlyCoverageGap[]> {
  if (typeof page.evaluateJavaScript !== 'function') return [];
  let raw: unknown;
  try {
    raw = await page.evaluateJavaScript(FRAME_PROBE_SCRIPT);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const gaps: TreeOnlyCoverageGap[] = [];
  for (const entry of raw as FrameProbeEntry[]) {
    if (!entry || entry.accessible !== false) continue;
    const src =
      typeof entry.src === 'string' && entry.src
        ? ` src=${JSON.stringify(entry.src)}`
        : '';
    gaps.push({
      region: `frame[index=${entry.index ?? '?'}${src}]`,
      reason: 'inaccessible-frame',
    });
  }
  return gaps;
}

/**
 * Capture one viewport-scoped browser snapshot. Off-screen content is
 * never exposed as candidates: additional content requires scrolling
 * and a fresh capture with a new snapshot identity.
 *
 * Outcomes follow the shared contract: a genuinely blank page is
 * `success-empty`; known gaps make it `partial` (which may carry zero
 * nodes); a thrown evaluate with no usable evidence is `failed` and
 * never relabeled as empty.
 */
export async function captureTreeOnlyBrowserSnapshot(
  page: TreeOnlySnapshotPageLike,
  options?: TreeOnlyBrowserCaptureOptions,
): Promise<TreeOnlyBrowserCollectResult> {
  let viewport: TreeOnlyBrowserCollectViewport;
  try {
    const size = await page.size();
    viewport = {
      id: options?.viewportId ?? 'main',
      width: size.width,
      height: size.height,
    };
  } catch {
    viewport = {
      id: options?.viewportId ?? 'main',
      width: defaultViewportSize.width,
      height: defaultViewportSize.height,
    };
  }

  const probed = await probeInaccessibleFrames(page);
  const seen = new Set<string>();
  const coverageGaps: TreeOnlyCoverageGap[] = [];
  for (const gap of [...(options?.coverageGaps ?? []), ...probed]) {
    if (seen.has(gap.region)) continue;
    seen.add(gap.region);
    coverageGaps.push(gap);
  }

  try {
    const tree = await page.getElementsNodeTree();
    if (!tree) {
      return collectTreeOnlyBrowserSnapshot(null, {
        snapshotId: options?.snapshotId,
        capturedAt: options?.capturedAt,
        viewport,
        frameId: options?.frameId,
        coverageGaps,
        captureError: 'empty capture result',
        maxNodes: options?.maxNodes,
      });
    }
    return collectTreeOnlyBrowserSnapshot(tree as any, {
      snapshotId: options?.snapshotId,
      capturedAt: options?.capturedAt,
      viewport,
      frameId: options?.frameId,
      coverageGaps,
      maxNodes: options?.maxNodes,
    });
  } catch (error) {
    return collectTreeOnlyBrowserSnapshot(null, {
      snapshotId: options?.snapshotId,
      capturedAt: options?.capturedAt,
      viewport,
      frameId: options?.frameId,
      coverageGaps,
      captureError: describeFrameProbeError(error),
      maxNodes: options?.maxNodes,
    });
  }
}
