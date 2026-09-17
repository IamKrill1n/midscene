import {
  type TreeOnlyInputMode,
  type TreeOnlyModeSource,
  TreeOnlyOperationError,
} from './types';

/**
 * T02 operation-scoped input-mode resolution.
 *
 * Pure functions only: no global mutable state, no agent mutation. Each
 * top-level operation resolves its own `{ effectiveMode, modeSource }` and
 * carries it for the whole operation (planning turns, locating, retries)
 * without mutating the agent default, so concurrent operations stay
 * isolated. T17 consumes the normalized option helpers for YAML/fixture
 * forwarding; this module tests precedence independently of those entry
 * points.
 *
 * Agreed compatibility (issue 02, hybrid removed 2026-09-17):
 * - Public values are `visual | tree-only`. `hybrid` is rejected
 *   explicitly; unknown values and `null` are rejected, never defaulted.
 * - Omitted call settings inherit the agent setting; the implicit default
 *   remains `visual`.
 * - YAML precedence: flow-step setting, script agent setting, existing
 *   agent setting, then implicit visual. Script defaults never mutate the
 *   existing agent.
 * - When an explicit mode is effective (including an inherited agent mode
 *   and explicit `visual`), defined legacy `domIncluded`/`screenshotIncluded`
 *   flags — including `false` — are rejected. `undefined` counts as omitted.
 * - Recorded screenshot observations never inherit live `inputMode`; a
 *   supplied value is rejected at runtime.
 */

export const TREE_ONLY_DEFAULT_MODE: TreeOnlyInputMode = 'visual';

export const TREE_ONLY_SUPPORTED_MODES: readonly TreeOnlyInputMode[] = [
  'visual',
  'tree-only',
] as const;

export interface TreeOnlyResolvedMode {
  effectiveMode: TreeOnlyInputMode;
  modeSource: TreeOnlyModeSource;
}

export interface TreeOnlyLegacyEvidenceFlags {
  domIncluded?: boolean | 'visible-only';
  screenshotIncluded?: boolean;
}

/**
 * Forwardable mode option shape for T17 YAML/fixture wiring. Layers pass
 * this shape through without reinterpreting legacy flags as modes.
 */
export interface TreeOnlyForwardableModeOptions {
  inputMode?: TreeOnlyInputMode;
}

export type TreeOnlyNormalizedCallOptions = TreeOnlyForwardableModeOptions &
  TreeOnlyLegacyEvidenceFlags;

function sourceLabelForError(source: TreeOnlyModeSource): string {
  switch (source) {
    case 'call':
      return 'call options';
    case 'agent':
      return 'agent options';
    case 'yaml-step':
      return 'YAML flow step';
    case 'yaml-script':
      return 'YAML script agent';
    case 'default':
      return 'implicit default';
  }
}

function rawSourceLabel(label: string): string {
  return label || 'options';
}

/**
 * Validate a single raw `inputMode` value. `undefined` means inherit.
 * Throws {@link TreeOnlyOperationError}: `unsupported-operation` for the
 * explicitly removed `hybrid` mode, `malformed` for `null`/unknown/wrong
 * types. Never defaults silently.
 */
export function normalizeInputModeOption(
  raw: unknown,
  sourceLabel = 'options',
): TreeOnlyInputMode | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === 'visual' || raw === 'tree-only') {
    return raw;
  }
  const label = rawSourceLabel(sourceLabel);
  if (raw === 'hybrid') {
    throw new TreeOnlyOperationError(
      `unsupported input mode "hybrid" from ${label}; expected "visual" or "tree-only" ("hybrid" is not supported in the Jev tree-only path)`,
      'unsupported-operation',
    );
  }
  throw new TreeOnlyOperationError(
    `invalid input mode ${JSON.stringify(raw) ?? String(raw)} from ${label}; expected "visual" or "tree-only", or omit the setting to inherit`,
    'malformed',
  );
}

/**
 * Normalize a forwardable option bag for T17 without mutating the input.
 * Unknown extra keys are dropped; legacy evidence flags pass through as-is
 * so {@link assertLegacyFlagsCompatible} can validate them separately.
 */
export function normalizeForwardableModeOptions(raw: {
  inputMode?: unknown;
}): TreeOnlyForwardableModeOptions {
  const normalized = normalizeInputModeOption(raw?.inputMode, 'options');
  return normalized === undefined ? {} : { inputMode: normalized };
}

/** Normalize an agent-default option bag without mutating the input. */
export function normalizeAgentModeOptions(raw: {
  inputMode?: unknown;
}): TreeOnlyForwardableModeOptions {
  const normalized = normalizeInputModeOption(raw?.inputMode, 'agent options');
  return normalized === undefined ? {} : { inputMode: normalized };
}

/** Normalize a per-call option bag without mutating the input. */
export function normalizeCallModeOptions(
  raw: {
    inputMode?: unknown;
    domIncluded?: boolean | 'visible-only';
    screenshotIncluded?: boolean;
  },
  sourceLabel = 'call options',
): TreeOnlyNormalizedCallOptions {
  const normalized = normalizeInputModeOption(raw?.inputMode, sourceLabel);
  const out: TreeOnlyNormalizedCallOptions = {};
  if (normalized !== undefined) {
    out.inputMode = normalized;
  }
  if (raw?.domIncluded !== undefined) {
    out.domIncluded = raw.domIncluded;
  }
  if (raw?.screenshotIncluded !== undefined) {
    out.screenshotIncluded = raw.screenshotIncluded;
  }
  return out;
}

/**
 * Resolve call-over-agent precedence. The call override governs the whole
 * operation without mutating the agent default. Returns a fresh object on
 * every call so concurrent operations cannot share mutable resolution.
 */
export function resolveEffectiveInputMode(layers: {
  callInputMode?: unknown;
  agentInputMode?: unknown;
}): TreeOnlyResolvedMode {
  const call = normalizeInputModeOption(layers?.callInputMode, 'call options');
  const agent = normalizeInputModeOption(
    layers?.agentInputMode,
    'agent options',
  );
  if (call !== undefined) {
    return { effectiveMode: call, modeSource: 'call' };
  }
  if (agent !== undefined) {
    return { effectiveMode: agent, modeSource: 'agent' };
  }
  return { effectiveMode: TREE_ONLY_DEFAULT_MODE, modeSource: 'default' };
}

/**
 * Resolve YAML precedence independently of the YAML player (T17 wires this
 * in): flow-step setting, script agent setting, existing agent setting,
 * then implicit visual. Script defaults are scoped to script execution;
 * this function never mutates the agent.
 */
export function resolveYamlInputMode(layers: {
  stepInputMode?: unknown;
  scriptAgentInputMode?: unknown;
  agentInputMode?: unknown;
}): TreeOnlyResolvedMode {
  const step = normalizeInputModeOption(
    layers?.stepInputMode,
    'YAML flow step',
  );
  const script = normalizeInputModeOption(
    layers?.scriptAgentInputMode,
    'YAML script agent',
  );
  const agent = normalizeInputModeOption(
    layers?.agentInputMode,
    'agent options',
  );
  if (step !== undefined) {
    return { effectiveMode: step, modeSource: 'yaml-step' };
  }
  if (script !== undefined) {
    return { effectiveMode: script, modeSource: 'yaml-script' };
  }
  if (agent !== undefined) {
    return { effectiveMode: agent, modeSource: 'agent' };
  }
  return { effectiveMode: TREE_ONLY_DEFAULT_MODE, modeSource: 'default' };
}

/**
 * Enforce the agreed legacy compatibility: with no explicit mode at any
 * applicable scope, legacy flags keep their existing behavior. When an
 * explicit mode is effective — including an inherited agent/script mode and
 * explicit `visual` — any defined legacy flag (including `false`) is
 * rejected. `undefined` counts as omitted.
 */
export function assertLegacyFlagsCompatible(
  resolved: TreeOnlyResolvedMode,
  flags: TreeOnlyLegacyEvidenceFlags | undefined,
  options?: { operation?: string },
): void {
  if (resolved.modeSource === 'default') {
    return;
  }
  const defined: string[] = [];
  if (flags?.domIncluded !== undefined) {
    defined.push('domIncluded');
  }
  if (flags?.screenshotIncluded !== undefined) {
    defined.push('screenshotIncluded');
  }
  if (defined.length === 0) {
    return;
  }
  const operation = options?.operation ? ` for ${options.operation}` : '';
  throw new TreeOnlyOperationError(
    `explicit input mode "${resolved.effectiveMode}" from ${sourceLabelForError(resolved.modeSource)}${operation} conflicts with legacy option${defined.length > 1 ? 's' : ''} ${defined.map((name) => `"${name}"`).join(' and ')}; remove the legacy domIncluded/screenshotIncluded flags or remove explicit inputMode configuration to retain legacy behavior`,
    'unsupported-input',
  );
}

/**
 * Enforce operation scope: internal child calls inherit the enclosing
 * operation's resolved mode. An omitted child setting inherits; an equal
 * child setting is compatible; a conflicting child setting is rejected so
 * an operation never splits across modes.
 */
export function resolveNestedInputMode(
  parent: TreeOnlyResolvedMode,
  childInputMode?: unknown,
  options?: { operation?: string },
): TreeOnlyResolvedMode {
  const child = normalizeInputModeOption(childInputMode, 'nested call options');
  if (child === undefined || child === parent.effectiveMode) {
    return { ...parent };
  }
  const operation = options?.operation ? ` for ${options.operation}` : '';
  throw new TreeOnlyOperationError(
    `conflicting nested input mode "${child}"${operation} inside an operation with resolved mode "${parent.effectiveMode}" from ${sourceLabelForError(parent.modeSource)}; internal calls must inherit the enclosing operation mode`,
    'unsupported-input',
  );
}

/**
 * Recorded screenshot observations never inherit live `inputMode`. Their
 * option types must not expose it; reject any supplied value at runtime
 * rather than silently accepting it.
 */
export function assertObservationHasNoInputMode(
  options: unknown,
  opLabel = 'UIObservation',
): void {
  if (
    typeof options === 'object' &&
    options !== null &&
    (options as { inputMode?: unknown }).inputMode !== undefined
  ) {
    throw new TreeOnlyOperationError(
      `${opLabel} does not support inputMode because it only evaluates recorded screenshots`,
      'unsupported-input',
    );
  }
}

/** True when the resolved mode came from an explicit setting. */
export function isExplicitInputMode(resolved: TreeOnlyResolvedMode): boolean {
  return resolved.modeSource !== 'default';
}
