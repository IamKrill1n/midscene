import { defaultViewportSize } from '@/common/viewport';
import type { ElementTreeNode } from '@midscene/core';
import {
  TREE_ONLY_BROWSER_COLLECTOR,
  type TreeOnlyBrowserCollectResult,
  type TreeOnlyBrowserCollectViewport,
  collectTreeOnlyBrowserSnapshot,
  treeToList,
} from '@midscene/shared/extractor';
import type {
  TreeOnlyAccessibilityOverride,
  TreeOnlyCoverageGap,
} from '@midscene/shared/tree-only';

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
 * Reset the extractor's node identity cache before a capture. The cache
 * maps `ElementInfo.id` (node hash) to the live DOM node; it must be
 * empty so the accessibility pass below reads the nodes from *this*
 * extraction rather than stale entries. Best-effort: a page without
 * `evaluateJavaScript` simply keeps extractor-derived fields.
 */
const TREE_ONLY_RESET_NODE_CACHE_SCRIPT = `(() => {
  window.midsceneNodeHashCache = new Map();
  return true;
})()`;

/**
 * In-page accessible-name/role/state evidence, following the same
 * sources as the `vendor/jev-ultrafast` reference (`snapshot.js`):
 * aria-labelledby, aria-label, associated labels, input value for
 * button-like inputs, child text, title, placeholder for names; explicit
 * ARIA roles, tag/type mapping for roles; live DOM properties and ARIA
 * booleans for state. Runs after extraction, keyed by the extractor's
 * node hash, and returns only elements with a recognized role so
 * structural containers stay name-free.
 */
const TREE_ONLY_ACCESSIBILITY_HELPERS = `
  const supportedRoles = new Set([
    'button','link','checkbox','radio','switch','tab','menuitem',
    'menuitemradio','menuitemcheckbox','option','gridcell','combobox',
    'textbox','searchbox','spinbutton',
  ]);
  const textOf = (element) => {
    const text = element.innerText || element.textContent || '';
    return text.replace(/\\s+/g, ' ').trim();
  };
  const nameOf = (element, seen) => {
    if (!element || seen.has(element)) return '';
    seen.add(element);
    const labelledBy = (element.getAttribute('aria-labelledby') || '')
      .split(/\\s+/).filter(Boolean)
      .map((id) => nameOf(element.ownerDocument.getElementById(id), seen))
      .filter(Boolean).join(' ');
    if (labelledBy) return labelledBy;
    const ariaLabel = (element.getAttribute('aria-label') || '').trim();
    if (ariaLabel) return ariaLabel;
    const labels = element.labels ? Array.from(element.labels) : [];
    const labelled = labels.map((label) => nameOf(label, seen))
      .filter(Boolean).join(' ');
    if (labelled) return labelled;
    if (element.tagName === 'INPUT' &&
        ['button','submit','reset','image'].includes(element.type)) {
      const value = (element.getAttribute('value') || '').trim();
      if (value) return value;
    }
    if (element.tagName === 'IMG') {
      const alt = (element.getAttribute('alt') || '').trim();
      if (alt) return alt;
    }
    const text = textOf(element);
    if (text) return text;
    const title = (element.getAttribute('title') || '').trim();
    if (title) return title;
    const placeholder = (element.getAttribute('placeholder') || '').trim();
    if (placeholder) return placeholder;
    return '';
  };
  const roleOf = (element) => {
    const explicit = element.getAttribute('role');
    if (explicit && supportedRoles.has(explicit)) return explicit;
    const tag = element.tagName;
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'A' && element.hasAttribute('href')) return 'link';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA' || element.isContentEditable) return 'textbox';
    if (tag === 'INPUT') {
      const type = (element.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (['button','submit','reset','image'].includes(type)) return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      if (['text','email','url','tel','date','time','datetime-local','month','week']
        .includes(type)) return 'textbox';
    }
    return null;
  };
  const boolOf = (value) => value === 'true' ? true : value === 'false' ? false : undefined;
  const stateOf = (element) => {
    const state = {};
    if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') {
      state.disabled = true;
    }
    const ariaChecked = boolOf(element.getAttribute('aria-checked'));
    if ((element.type === 'checkbox' || element.type === 'radio') &&
        typeof element.checked === 'boolean') {
      state.checked = element.checked;
    } else if (ariaChecked !== undefined) {
      state.checked = ariaChecked;
    }
    if (element.readOnly === true || element.getAttribute('aria-readonly') === 'true') {
      state.readonly = true;
    }
    if (element.required === true || element.getAttribute('aria-required') === 'true') {
      state.required = true;
    }
    const ariaSelected = boolOf(element.getAttribute('aria-selected'));
    if (element.selected === true) state.selected = true;
    else if (ariaSelected !== undefined) state.selected = ariaSelected;
    const ariaExpanded = boolOf(element.getAttribute('aria-expanded'));
    if (ariaExpanded !== undefined) state.expanded = ariaExpanded;
    if (element.tagName === 'INPUT' && element.type) state.inputType = element.type;
    return state;
  };
`;

const TREE_ONLY_ACCESSIBILITY_SCRIPT_PREFIX = `(() => {
  const cache = window.midsceneNodeHashCache;
  if (!(cache instanceof Map)) return null;
${TREE_ONLY_ACCESSIBILITY_HELPERS}
  const ids = `;

/**
 * Install the shared in-page accessibility helpers on
 * `window.midsceneTreeOnlyAccessibility`. T3 live target validation reads
 * role, name, and state through these exact helpers, so the meaning
 * compared before dispatch is computed the same way as the meaning the
 * snapshot recorded.
 */
export const TREE_ONLY_LIVE_OBSERVATION_HELPERS_SCRIPT = `(() => {
  window.midsceneTreeOnlyAccessibility = (() => {
${TREE_ONLY_ACCESSIBILITY_HELPERS}
    return { textOf, nameOf, roleOf, stateOf };
  })();
  return true;
})()`;

function buildAccessibilityScript(ids: readonly string[]): string {
  return `${TREE_ONLY_ACCESSIBILITY_SCRIPT_PREFIX}${JSON.stringify([...ids])};
  const out = {};
  for (const id of ids) {
    const node = cache.get(id);
    if (!(node instanceof Element)) continue;
    const role = roleOf(node);
    if (!role) continue;
    const state = stateOf(node);
    out[id] = {
      role,
      name: nameOf(node, new Set()),
      state,
    };
  }
  return out;
})()`;
}

/**
 * Collect in-page accessibility overrides keyed by extractor node hash.
 * A missing cache, stale page, or malformed answer is not fatal: the
 * capture falls back to extractor-derived roles, names, and states.
 */
export async function collectTreeOnlyAccessibilityOverrides(
  page: TreeOnlySnapshotPageLike,
  ids: readonly string[],
): Promise<Record<string, TreeOnlyAccessibilityOverride> | undefined> {
  if (typeof page.evaluateJavaScript !== 'function' || ids.length === 0) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = await page.evaluateJavaScript(buildAccessibilityScript(ids));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, TreeOnlyAccessibilityOverride> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as {
      role?: unknown;
      name?: unknown;
      state?: unknown;
    };
    const override: TreeOnlyAccessibilityOverride = {};
    if (typeof entry.role === 'string' && entry.role)
      override.role = entry.role;
    if (typeof entry.name === 'string' && entry.name.trim()) {
      override.name = entry.name.trim();
    }
    if (entry.state && typeof entry.state === 'object') {
      const state: Record<string, string | boolean> = {};
      for (const [key, rawValue] of Object.entries(
        entry.state as Record<string, unknown>,
      )) {
        if (typeof rawValue === 'boolean' || typeof rawValue === 'string') {
          state[key] = rawValue;
        }
      }
      if (Object.keys(state).length > 0) override.state = state;
    }
    result[id] = override;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Capture one viewport-scoped browser snapshot. Off-screen content is
 * never exposed as candidates: additional content requires scrolling
 * and a fresh capture with a new snapshot identity.
 *
 * Outcomes follow the shared contract: a genuinely blank page is
 * `success-empty`; known gaps make it `partial` (which may carry zero
 * nodes); a thrown evaluate with no usable evidence is `failed` and is
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

  if (typeof page.evaluateJavaScript === 'function') {
    try {
      await page.evaluateJavaScript(TREE_ONLY_RESET_NODE_CACHE_SCRIPT);
    } catch {
      // Best-effort: without a clean cache the accessibility pass below
      // simply falls back to extractor-derived fields.
    }
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
    const ids = [
      ...new Set(
        treeToList(tree as ElementTreeNode<any>)
          .map((node) => node?.id)
          .filter((id): id is string => typeof id === 'string' && id !== ''),
      ),
    ];
    const accessibility = await collectTreeOnlyAccessibilityOverrides(
      page,
      ids,
    );
    return collectTreeOnlyBrowserSnapshot(tree as any, {
      snapshotId: options?.snapshotId,
      capturedAt: options?.capturedAt,
      viewport,
      frameId: options?.frameId,
      coverageGaps,
      maxNodes: options?.maxNodes,
      accessibility,
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
