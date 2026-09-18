import type { Rect } from '../types';

/**
 * T01 shared snapshot contract for tree-only operation.
 *
 * This module declares interfaces only. Capture implementations land in
 * later tasks (T05 browser, T15 Android) against these types. Field names
 * follow the resolved capture contract: outer metadata is shared across
 * platforms while browser and Android nodes keep their own source fields.
 */

/** Platforms covered by the shared outer snapshot record. */
export type TreeOnlySnapshotPlatform = 'browser' | 'android';

/**
 * Capture outcome. `success-empty` is a genuinely empty capture;
 * `partial` carries usable evidence plus disclosed gaps; `failed`
 * carries no usable evidence. Never relabel failed/partial as empty.
 */
export type TreeOnlySnapshotStatus =
  | 'success-nonempty'
  | 'success-empty'
  | 'partial'
  | 'failed';

/** Viewport (browser) or display (Android) identity and dimensions. */
export interface TreeOnlyViewport {
  /** Document/window/display identity used to detect navigation changes. */
  id: string;
  width: number;
  height: number;
}

/** Units and transform metadata for interpreting node bounds. */
export interface TreeOnlyCoordinateSpace {
  units: 'css-px' | 'logical-px';
  /**
   * Scale applied by the collector when converting source bounds into
   * execution coordinates (for example Android devicePixelRatio).
   */
  sourceScale?: number;
}

/** A disclosed region the collector could not capture. */
export interface TreeOnlyCoverageGap {
  /** Human-readable region, e.g. `frame[id="ads"]` or `shadow-host`. */
  region: string;
  /** Why the region is missing, e.g. `inaccessible-frame`. */
  reason: string;
}

/** Payload delivery metadata: budget truncation is not capture failure. */
export interface TreeOnlyPayloadDelivery {
  /** True when an overview was sent and sections were withheld by budget. */
  truncated: boolean;
  /** Omitted-section markers with handles for bounded same-snapshot expansion. */
  omittedSections?: string[];
}

/** Shared outer record; both platforms embed this verbatim. */
export interface TreeOnlySnapshotBase {
  /** Unique identity for this capture; references are scoped to it. */
  snapshotId: string;
  platform: TreeOnlySnapshotPlatform;
  /** Wall-clock capture time in milliseconds. */
  capturedAt: number;
  viewport: TreeOnlyViewport;
  coordinateSpace: TreeOnlyCoordinateSpace;
  status: TreeOnlySnapshotStatus;
  coverageGaps: TreeOnlyCoverageGap[];
  delivery: TreeOnlyPayloadDelivery;
}

/**
 * Node bounds. `null` means unavailable (missing, nonfinite, malformed,
 * or unsupported) and must never be fabricated as a zero rectangle.
 * A genuine zero-area node is represented explicitly (see
 * {@link isZeroAreaRect}) and is not an actionable point target.
 */
export type TreeOnlyBounds = Rect | null;

export function isBoundsAvailable(bounds: TreeOnlyBounds): bounds is Rect {
  if (!bounds) return false;
  return (
    Number.isFinite(bounds.left + bounds.top) &&
    Number.isFinite(bounds.width + bounds.height) &&
    bounds.width >= 0 &&
    bounds.height >= 0
  );
}

export function isZeroAreaRect(rect: Rect): boolean {
  return rect.width === 0 || rect.height === 0;
}

/**
 * DOM-derived accessibility evidence for one collected node, computed
 * in-page from the live element. Optional: captures without a live DOM
 * fall back to extractor-derived fields. `name` follows accessible-name
 * resolution (aria-labelledby, aria-label, labels, content, title,
 * placeholder); `role` uses explicit ARIA roles when they describe a
 * supported control; `state` carries truthful native/ARIA booleans.
 */
export interface TreeOnlyAccessibilityOverride {
  role?: string;
  name?: string;
  state?: Record<string, string | boolean>;
}

/** Browser semantic candidate node (Playwright-style evidence). */
export interface TreeOnlyBrowserNode {
  /** Snapshot-scoped reference; resolves only via the owning snapshot. */
  ref: string;
  role: string;
  name?: string;
  text?: string;
  state?: Record<string, string | boolean>;
  bounds: TreeOnlyBounds;
  /** Viewport-clipped portion of {@link bounds}, when clipping applies. */
  clippedBounds?: TreeOnlyBounds;
  /** Owning frame identity for frame-local geometry conversion. */
  frameId?: string;
  /** True when the node sits behind an exposed shadow boundary. */
  shadowBoundary?: boolean;
}

/**
 * Android hierarchy candidate node. Accessibility fields are preserved
 * as-is; unknown geometry stays `null` (never a fabricated origin rect).
 */
export interface TreeOnlyAndroidNode {
  /** Snapshot-scoped reference; resolves only via the owning snapshot. */
  ref: string;
  type: string;
  attrs: Record<string, string | undefined>;
  bounds: TreeOnlyBounds;
  windowId?: string;
  displayId?: string;
}

export type TreeOnlyCandidateNode = TreeOnlyBrowserNode | TreeOnlyAndroidNode;

/** Browser snapshot: shared outer record plus browser tree. */
export interface TreeOnlyBrowserSnapshot {
  base: TreeOnlySnapshotBase & { platform: 'browser' };
  nodes: TreeOnlyBrowserNode[];
}

/** Android snapshot: shared outer record plus hierarchy nodes. */
export interface TreeOnlyAndroidSnapshot {
  base: TreeOnlySnapshotBase & { platform: 'android' };
  nodes: TreeOnlyAndroidNode[];
}

export type TreeOnlySnapshot =
  | TreeOnlyBrowserSnapshot
  | TreeOnlyAndroidSnapshot;

/**
 * Private snapshot-local reference resolver. The mapping never leaves
 * the owning operation: resolvers are created per snapshot, and a
 * reference from another snapshot (or after recapture) resolves to
 * `null` instead of rebinding to a same-name replacement.
 */
export interface TreeOnlyReferenceResolver<
  TNode extends TreeOnlyCandidateNode = TreeOnlyCandidateNode,
> {
  readonly snapshotId: string;
  resolve(ref: string): TNode | null;
  has(ref: string): boolean;
  refs(): readonly string[];
  readonly size: number;
}

export function createTreeOnlyReferenceResolver<
  TNode extends TreeOnlyCandidateNode,
>(
  snapshotId: string,
  nodes: readonly TNode[],
): TreeOnlyReferenceResolver<TNode> {
  if (!snapshotId) {
    throw new Error('createTreeOnlyReferenceResolver: snapshotId is required');
  }
  const mapping = new Map<string, TNode>();
  for (const node of nodes) {
    if (!mapping.has(node.ref)) {
      mapping.set(node.ref, node);
    }
  }
  return {
    snapshotId,
    resolve: (ref: string) => mapping.get(ref) ?? null,
    has: (ref: string) => mapping.has(ref),
    refs: () => [...mapping.keys()],
    size: mapping.size,
  };
}

/**
 * Choice transport budget. One of the maximum 255 options is reserved
 * for no-match, so at most 254 concrete candidates fit a single
 * evaluation. Larger trees require disclosed hierarchical selection or
 * visible snapshot expansion; never silently truncate.
 */
export const TREE_ONLY_MAX_CHOICE_OPTIONS = 255;
export const TREE_ONLY_NO_MATCH_OPTION_ID = 'no-match';
export const TREE_ONLY_MAX_CONCRETE_CANDIDATES =
  TREE_ONLY_MAX_CHOICE_OPTIONS - 1;

export function exceedsSingleChoiceBudget(candidateCount: number): boolean {
  return candidateCount > TREE_ONLY_MAX_CONCRETE_CANDIDATES;
}
