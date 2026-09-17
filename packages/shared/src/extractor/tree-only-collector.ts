import { NodeType } from '../constants/index';
import type {
  TreeOnlyBounds,
  TreeOnlyBrowserNode,
  TreeOnlyBrowserSnapshot,
  TreeOnlyCoverageGap,
  TreeOnlyReferenceResolver,
  TreeOnlySnapshotStatus,
} from '../tree-only/types';
import {
  TREE_ONLY_MAX_CONCRETE_CANDIDATES,
  createTreeOnlyReferenceResolver,
  isBoundsAvailable,
} from '../tree-only/types';
import type { ElementTreeNode, Rect } from '../types';
import type { ElementInfo } from './index';

/**
 * T05 browser semantic collector.
 *
 * Selected collector: the owned Midscene DOM-derived extractor
 * (`webExtractNodeTree()` evaluated in the page, see
 * `packages/shared/src/extractor/web-extractor.ts`). It supplies element
 * ids, rects, visibility, and xpath-backed executable references through
 * the page's node cache.
 *
 * Rejected alternative: Playwright's public `locator.ariaSnapshot()`.
 * Verified against the pinned Playwright 1.58.1 (`^1.45.0` in
 * `packages/web-integration/package.json`): it returns YAML text such as
 * `- button "Hi"` with no executable references and no geometry. ARIA
 * text must never be treated as an executable reference, so this
 * collector only mints its own snapshot-scoped `rN` references and never
 * parses `[ref=...]` markers out of accessible-name text.
 *
 * Supported scope: Playwright with Chromium first. Other browser
 * integrations are not initial acceptance requirements.
 */
export const TREE_ONLY_BROWSER_COLLECTOR = 'midscene-dom' as const;

/**
 * Schema version of the browser snapshot shape produced here. Carried for
 * cache identity (`snapshotSchemaVersion` in T04's cache key): bump when
 * the collected node fields change meaning.
 */
export const TREE_ONLY_BROWSER_SNAPSHOT_SCHEMA_VERSION = '1' as const;

/**
 * Default delivery budget: at most this many candidate nodes are exposed
 * in `snapshot.nodes`. The full collection stays retained in the result
 * (and in the private resolver) so T08's bounded expansion can serve
 * `omittedSections` handles from the same snapshot. Scrolling still
 * requires a fresh capture with a new snapshot identity.
 */
export const TREE_ONLY_BROWSER_DEFAULT_MAX_NODES = 1000;

export interface TreeOnlyBrowserCollectViewport {
  /** Document/window identity used to detect navigation changes. */
  id: string;
  width: number;
  height: number;
}

export interface TreeOnlyBrowserCollectOptions {
  /** Snapshot identity; generated when omitted (tests pass explicit ids). */
  snapshotId?: string;
  /** Wall-clock capture time in milliseconds; defaults to `Date.now()`. */
  capturedAt?: number;
  viewport: TreeOnlyBrowserCollectViewport;
  /** Owning frame applied to every node in this batch (default `main`). */
  frameId?: string;
  /**
   * True when this batch comes from inside an exposed shadow root. The
   * flag is recorded per node so downstream validation keeps the shadow
   * boundary visible.
   */
  shadowBoundary?: boolean;
  /** Regions the collector could not capture (inaccessible frames, ...). */
  coverageGaps?: TreeOnlyCoverageGap[];
  /**
   * Collector-side failure message (evaluate threw, empty result, ...).
   * With usable nodes it degrades the outcome to `partial`; with no
   * usable nodes and no gaps the outcome is `failed`.
   */
  captureError?: string;
  /** Delivery budget; defaults to {@link TREE_ONLY_BROWSER_DEFAULT_MAX_NODES}. */
  maxNodes?: number;
}

export interface TreeOnlyBackendRef {
  /** Private element identity for T09 re-resolution (never serialized). */
  id: string;
  indexId: number;
  nodeHashId: string;
  xpaths?: string[];
}

export interface TreeOnlyBrowserCollectResult {
  snapshot: TreeOnlyBrowserSnapshot;
  /**
   * Private snapshot-local resolver. Covers every retained node,
   * including nodes withheld from `snapshot.nodes` by the delivery
   * budget, so bounded same-snapshot expansion keeps working. Never
   * serialize or share across snapshots: stale references resolve to
   * `null` instead of rebinding.
   */
  resolver: TreeOnlyReferenceResolver<TreeOnlyBrowserNode>;
  /**
   * Private executable handles for T09 validation, keyed by snapshot
   * ref. Never sent to the model and never persisted.
   */
  backend: ReadonlyMap<string, TreeOnlyBackendRef>;
  /** Every retained node in document order (delivered + omitted). */
  retainedNodes: readonly TreeOnlyBrowserNode[];
}

let collectCounter = 0;

function nextSnapshotId(): string {
  collectCounter += 1;
  return `snap-${Date.now().toString(36)}-${collectCounter}`;
}

function roleForElement(info: ElementInfo): string {
  switch (info.nodeType) {
    case NodeType.BUTTON:
      return 'button';
    case NodeType.A:
      return 'link';
    case NodeType.FORM_ITEM: {
      const tag = (info.attributes?.htmlTagName ?? '').toLowerCase();
      const inputType = (info.attributes?.type ?? '').toLowerCase();
      if (tag.includes('select')) return 'combobox';
      if (tag.includes('option')) return 'option';
      if (tag.includes('textarea')) return 'textbox';
      if (inputType === 'checkbox') return 'checkbox';
      if (inputType === 'radio') return 'radio';
      if (inputType === 'submit' || inputType === 'button') return 'button';
      return 'textbox';
    }
    case NodeType.IMG:
      return 'img';
    case NodeType.TEXT:
      return 'text';
    default:
      return 'generic';
  }
}

function present(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function stateForElement(
  info: ElementInfo,
): Record<string, string | boolean> | undefined {
  const state: Record<string, string | boolean> = {};
  const attributes = info.attributes ?? {};
  const flag = (names: string[]) => {
    for (const name of names) {
      if (attributes[name] !== undefined) return true;
    }
    return undefined;
  };
  const disabled = flag(['disabled', 'aria-disabled']);
  if (disabled !== undefined) state.disabled = disabled;
  const checked = flag(['checked', 'aria-checked']);
  if (checked !== undefined) state.checked = checked;
  const readonly = flag(['readonly', 'aria-readonly']);
  if (readonly !== undefined) state.readonly = readonly;
  const required = flag(['required', 'aria-required']);
  if (required !== undefined) state.required = required;
  const selected = flag(['selected', 'aria-selected']);
  if (selected !== undefined) state.selected = selected;
  const inputType = present(attributes.type);
  if (info.nodeType === NodeType.FORM_ITEM && inputType) {
    state.inputType = inputType;
  }
  return Object.keys(state).length > 0 ? state : undefined;
}

function nameAndTextForElement(
  info: ElementInfo,
  role: string,
): Pick<TreeOnlyBrowserNode, 'name' | 'text'> {
  const attributes = info.attributes ?? {};
  const content = present(info.content);
  if (role === 'text') {
    return content ? { text: content } : {};
  }
  if (role === 'generic') {
    // Structural ancestors carry no names; their descendants hold the
    // user-facing text. This keeps retained ancestors from leaking
    // unrelated off-screen text into model evidence.
    return {};
  }
  if (role === 'img') {
    const name =
      present(attributes.alt) ??
      present(attributes['aria-label']) ??
      present(attributes.title);
    return name ? { name } : {};
  }
  const name =
    present(attributes['aria-label']) ??
    content ??
    present(attributes.placeholder) ??
    present(attributes.value) ??
    present(attributes.alt) ??
    present(attributes.title);
  if (!name && !content) return {};
  if (!name) return { text: content };
  if (!content || content === name) return { name };
  return { name, text: content };
}

function toAvailableBounds(
  rect: ElementInfo['rect'] | undefined,
): TreeOnlyBounds {
  if (!rect) return null;
  const bounds: Rect = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  return isBoundsAvailable(bounds) ? bounds : null;
}

function clipToViewport(
  bounds: Rect,
  viewport: TreeOnlyBrowserCollectViewport,
): Rect | null {
  const left = Math.max(bounds.left, 0);
  const top = Math.max(bounds.top, 0);
  const right = Math.min(bounds.left + bounds.width, viewport.width);
  const bottom = Math.min(bounds.top + bounds.height, viewport.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function sameBounds(a: Rect, b: Rect): boolean {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}

interface PendingEntry {
  info: ElementInfo;
  role: string;
  structural: boolean;
}

function collectPendingEntries(
  tree: ElementTreeNode<ElementInfo> | null | undefined,
  intersectsViewport: (bounds: Rect) => boolean,
): PendingEntry[] {
  const visit = (
    node: ElementTreeNode<ElementInfo> | null | undefined,
  ): PendingEntry[] => {
    if (!node) return [];
    const childEntries: PendingEntry[] = [];
    for (const child of node.children ?? []) {
      childEntries.push(...visit(child));
    }
    // Null shells promote their children to the upper layer.
    if (!node.node) return childEntries;
    const info = node.node;
    if (!info.isVisible) return childEntries;
    const role = roleForElement(info);
    const bounds = toAvailableBounds(info.rect);
    if (bounds && !intersectsViewport(bounds)) {
      // Fully off-screen leaves are excluded. An off-screen container
      // with visible descendants is retained as a structural shell with
      // truthful bounds so T09 validation can still reject it as a
      // target; shells carry no names (generic already has none).
      if (isContainerRole(role) && childEntries.length > 0) {
        return [{ info, role, structural: true }, ...childEntries];
      }
      return childEntries;
    }
    return [{ info, role, structural: false }, ...childEntries];
  };
  return visit(tree);
}

function isContainerRole(role: string): boolean {
  return role === 'generic';
}

/**
 * Collect a browser snapshot honoring the T01 shared snapshot contract.
 *
 * - Only viewport-visible evidence becomes candidates: fully off-screen
 *   leaves are excluded, while minimal structural ancestors needed to
 *   interpret visible descendants are retained with truthful (possibly
 *   off-screen) bounds so T09 validation can still reject them.
 * - A visible control keeps its computed accessible name even when the
 *   naming source sits outside the viewport, because the name travels in
 *   the node's own content; the off-screen source itself is never
 *   exposed as a separate candidate.
 * - Unknown or invalid geometry is preserved as `bounds: null`, never a
 *   fabricated origin rectangle. Genuine zero-area geometry stays
 *   distinct (see `isZeroAreaRect`); zero-area nodes are kept when their
 *   origin sits inside the viewport and dropped otherwise.
 * - CSS classes, inline styles, and other browser internals are dropped
 *   at collection; only roles, names, states, text, structure, frame or
 *   shadow boundaries, and geometry cross the boundary.
 * - References are minted per snapshot (`r1`, `r2`, ...) and resolve only
 *   through the returned private resolver. Content that looks like an
 *   ARIA `[ref=...]` marker never becomes a reference.
 */
export function collectTreeOnlyBrowserSnapshot(
  tree: ElementTreeNode<ElementInfo> | null | undefined,
  options: TreeOnlyBrowserCollectOptions,
): TreeOnlyBrowserCollectResult {
  const snapshotId = options.snapshotId ?? nextSnapshotId();
  if (!snapshotId) {
    throw new Error('collectTreeOnlyBrowserSnapshot: snapshotId is required');
  }
  const viewport = options.viewport;
  if (
    !viewport ||
    !viewport.id ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    throw new Error(
      'collectTreeOnlyBrowserSnapshot: viewport with id and positive dimensions is required',
    );
  }
  const frameId = options.frameId ?? 'main';
  const shadowBoundary = options.shadowBoundary ?? false;
  const maxNodes = options.maxNodes ?? TREE_ONLY_BROWSER_DEFAULT_MAX_NODES;
  if (!Number.isInteger(maxNodes) || maxNodes <= 0) {
    throw new Error(
      'collectTreeOnlyBrowserSnapshot: maxNodes must be a positive integer',
    );
  }

  const gaps: TreeOnlyCoverageGap[] = [...(options.coverageGaps ?? [])];
  const captureError = options.captureError?.trim()
    ? options.captureError.trim()
    : undefined;

  const intersectsViewport = (bounds: Rect): boolean => {
    if (bounds.width === 0 || bounds.height === 0) {
      return (
        bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.left <= viewport.width &&
        bounds.top <= viewport.height
      );
    }
    return clipToViewport(bounds, viewport) !== null;
  };

  const source = collectPendingEntries(tree, intersectsViewport);
  const nodes: TreeOnlyBrowserNode[] = [];
  const backendByRef = new Map<string, TreeOnlyBackendRef>();
  let refCounter = 0;

  for (const entry of source) {
    const { info, role } = entry;
    refCounter += 1;
    const ref = `r${refCounter}`;
    const described = nameAndTextForElement(info, role);
    const state = stateForElement(info);
    const bounds = toAvailableBounds(info.rect);
    let clippedBounds: TreeOnlyBounds | undefined;
    if (bounds) {
      const clipped = clipToViewport(bounds, viewport);
      if (clipped && !sameBounds(clipped, bounds)) {
        clippedBounds = clipped;
      }
    }
    nodes.push({
      ref,
      role,
      ...described,
      ...(state ? { state } : {}),
      bounds,
      ...(clippedBounds ? { clippedBounds } : {}),
      frameId,
      ...(shadowBoundary ? { shadowBoundary: true as const } : {}),
    });
    backendByRef.set(ref, {
      id: info.id,
      indexId: info.indexId,
      nodeHashId: info.nodeHashId,
      ...(info.xpaths ? { xpaths: [...info.xpaths] } : {}),
    });
  }

  const resolver = createTreeOnlyReferenceResolver(snapshotId, nodes);

  // A bare collector failure beside usable nodes is partial evidence,
  // not a silent downgrade; the gap below discloses it. Total failure
  // (no usable nodes) stays `failed` even when gaps are known.
  if (captureError && nodes.length > 0 && gaps.length === 0) {
    gaps.push({ region: 'document', reason: captureError });
  }

  let status: TreeOnlySnapshotStatus;
  if (nodes.length === 0 && gaps.length === 0) {
    status = captureError ? 'failed' : 'success-empty';
  } else if (captureError && nodes.length === 0) {
    status = 'failed';
  } else if (gaps.length > 0 || captureError) {
    status = 'partial';
  } else {
    status = 'success-nonempty';
  }

  const truncated = nodes.length > maxNodes;
  const delivered = truncated ? nodes.slice(0, maxNodes) : nodes;
  const omittedSections = truncated
    ? [`nodes[r${maxNodes + 1}-r${nodes.length}]`]
    : [];
  if (truncated && nodes.length > TREE_ONLY_MAX_CONCRETE_CANDIDATES) {
    // Delivery truncation is independent of the Choice option budget;
    // T08 hierarchical selection consumes the retained nodes.
    omittedSections.push(
      `choice-budget(${TREE_ONLY_MAX_CONCRETE_CANDIDATES}-concrete-max)`,
    );
  }

  return {
    snapshot: {
      base: {
        snapshotId,
        platform: 'browser',
        capturedAt: options.capturedAt ?? Date.now(),
        viewport: {
          id: viewport.id,
          width: viewport.width,
          height: viewport.height,
        },
        coordinateSpace: { units: 'css-px' },
        status,
        coverageGaps: gaps,
        delivery: {
          truncated,
          ...(omittedSections.length > 0 ? { omittedSections } : {}),
        },
      },
      nodes: delivered,
    },
    resolver,
    backend: backendByRef,
    retainedNodes: nodes,
  };
}

/**
 * Serialize a snapshot to the text-only state consumed by typed Jev
 * evaluation. Emits one line per node with the snapshot-scoped ref, so
 * the model can only select references the owning snapshot resolves.
 * Never includes screenshots, credentials, CSS classes, or backend ids.
 */
export function serializeTreeOnlyBrowserSnapshot(
  snapshot: TreeOnlyBrowserSnapshot,
): string {
  const lines: string[] = [];
  lines.push(
    `# snapshot ${snapshot.base.snapshotId} (browser ${snapshot.base.viewport.width}x${snapshot.base.viewport.height}, ${snapshot.base.status}, ${snapshot.nodes.length} nodes)`,
  );
  for (const node of snapshot.nodes) {
    const parts: string[] = [`[${node.ref}]`, node.role];
    if (node.name !== undefined)
      parts.push(`name=${JSON.stringify(node.name)}`);
    if (node.text !== undefined)
      parts.push(`text=${JSON.stringify(node.text)}`);
    if (node.state !== undefined) {
      const state = Object.entries(node.state)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ');
      parts.push(`state(${state})`);
    }
    if (node.bounds) {
      parts.push(
        `bounds=(${node.bounds.left},${node.bounds.top},${node.bounds.width},${node.bounds.height})`,
      );
    } else {
      parts.push('bounds=unavailable');
    }
    if (node.clippedBounds) {
      parts.push(
        `clipped=(${node.clippedBounds.left},${node.clippedBounds.top},${node.clippedBounds.width},${node.clippedBounds.height})`,
      );
    }
    if (node.frameId && node.frameId !== 'main') {
      parts.push(`frame=${node.frameId}`);
    }
    if (node.shadowBoundary) parts.push('shadow-boundary');
    lines.push(parts.join(' '));
  }
  if (snapshot.base.delivery.truncated) {
    const omitted = (snapshot.base.delivery.omittedSections ?? []).join(', ');
    lines.push(
      `# omitted by budget: ${omitted || 'withheld sections'} (request bounded expansion within ${snapshot.base.snapshotId}; scrolling needs a fresh capture)`,
    );
  }
  for (const gap of snapshot.base.coverageGaps) {
    lines.push(`# gap: ${gap.region} (${gap.reason})`);
  }
  return lines.join('\n');
}
