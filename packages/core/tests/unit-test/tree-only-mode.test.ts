import {
  aiActOptionsInputSchema,
  insightOptionsInputSchema,
  locateOptionsInputSchema,
} from '@/agent/test-runner-nodes';
import {
  TREE_ONLY_DEFAULT_MODE,
  assertLegacyFlagsCompatible,
  assertObservationHasNoInputMode,
  normalizeAgentModeOptions,
  normalizeCallModeOptions,
  normalizeForwardableModeOptions,
  normalizeInputModeOption,
  resolveEffectiveInputMode,
  resolveNestedInputMode,
  resolveYamlInputMode,
} from '@/tree-only/mode';
import { TreeOnlyOperationError } from '@/tree-only/types';
import { describe, expect, it } from '@rstest/core';

function categoryOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TreeOnlyOperationError);
    return (error as TreeOnlyOperationError).category;
  }
  throw new Error('expected function to throw');
}

describe('tree-only mode resolution', () => {
  it('accepts visual and tree-only and defaults to visual', () => {
    expect(normalizeInputModeOption('visual', 'call options')).toBe('visual');
    expect(normalizeInputModeOption('tree-only', 'agent options')).toBe(
      'tree-only',
    );
    expect(normalizeInputModeOption(undefined)).toBeUndefined();
    expect(TREE_ONLY_DEFAULT_MODE).toBe('visual');
  });

  it('rejects hybrid explicitly without silent fallback', () => {
    expect(categoryOf(() => normalizeInputModeOption('hybrid'))).toBe(
      'unsupported-operation',
    );
    expect(() => normalizeInputModeOption('hybrid', 'call options')).toThrow(
      /hybrid/,
    );
    expect(() =>
      resolveEffectiveInputMode({ callInputMode: 'hybrid' }),
    ).toThrow(/hybrid/);
    expect(() =>
      resolveEffectiveInputMode({ agentInputMode: 'hybrid' }),
    ).toThrow(/hybrid/);
    expect(() => resolveYamlInputMode({ stepInputMode: 'hybrid' })).toThrow(
      /hybrid/,
    );
  });

  it('rejects unknown values and null instead of defaulting', () => {
    for (const raw of [
      null,
      'unknown',
      '',
      'VISUAL',
      'tree_only',
      123,
      true,
      {},
      [],
    ]) {
      expect(categoryOf(() => normalizeInputModeOption(raw))).toBe('malformed');
    }
    expect(() => resolveEffectiveInputMode({ callInputMode: null })).toThrow(
      /invalid input mode/,
    );
    expect(() =>
      resolveYamlInputMode({ scriptAgentInputMode: 'sometimes' }),
    ).toThrow(/invalid input mode/);
  });

  it('resolves call-over-agent precedence with sources', () => {
    expect(
      resolveEffectiveInputMode({
        callInputMode: 'tree-only',
        agentInputMode: 'visual',
      }),
    ).toEqual({ effectiveMode: 'tree-only', modeSource: 'call' });
    expect(
      resolveEffectiveInputMode({
        callInputMode: 'visual',
        agentInputMode: 'tree-only',
      }),
    ).toEqual({ effectiveMode: 'visual', modeSource: 'call' });
    expect(resolveEffectiveInputMode({ agentInputMode: 'tree-only' })).toEqual({
      effectiveMode: 'tree-only',
      modeSource: 'agent',
    });
    expect(resolveEffectiveInputMode({})).toEqual({
      effectiveMode: 'visual',
      modeSource: 'default',
    });
  });

  it('resolves YAML step over script over agent over default', () => {
    expect(
      resolveYamlInputMode({
        stepInputMode: 'visual',
        scriptAgentInputMode: 'tree-only',
        agentInputMode: 'tree-only',
      }),
    ).toEqual({ effectiveMode: 'visual', modeSource: 'yaml-step' });
    expect(
      resolveYamlInputMode({
        scriptAgentInputMode: 'tree-only',
        agentInputMode: 'visual',
      }),
    ).toEqual({ effectiveMode: 'tree-only', modeSource: 'yaml-script' });
    expect(resolveYamlInputMode({ agentInputMode: 'tree-only' })).toEqual({
      effectiveMode: 'tree-only',
      modeSource: 'agent',
    });
    expect(resolveYamlInputMode({})).toEqual({
      effectiveMode: 'visual',
      modeSource: 'default',
    });
  });

  it('keeps concurrent operations isolated without mutating shared config', async () => {
    const agentConfig = { inputMode: 'tree-only' as const };
    const snapshot = JSON.stringify(agentConfig);
    const resolveOp = (callInputMode: unknown) =>
      Promise.resolve().then(() =>
        resolveEffectiveInputMode({
          callInputMode,
          agentInputMode: agentConfig.inputMode,
        }),
      );
    const [opA, opB] = await Promise.all([
      resolveOp('visual'),
      resolveOp(undefined),
    ]);
    expect(opA).toEqual({ effectiveMode: 'visual', modeSource: 'call' });
    expect(opB).toEqual({ effectiveMode: 'tree-only', modeSource: 'agent' });
    expect(JSON.stringify(agentConfig)).toBe(snapshot);
    expect(opA).not.toBe(opB);
    opA.effectiveMode = 'tree-only';
    expect(opB.effectiveMode).toBe('tree-only');
  });

  it('does not mutate normalized option inputs', () => {
    const agentRaw = { inputMode: 'tree-only' as unknown };
    const agentOut = normalizeAgentModeOptions(agentRaw);
    expect(agentOut).toEqual({ inputMode: 'tree-only' });
    expect(agentOut).not.toBe(agentRaw);
    expect(agentRaw).toEqual({ inputMode: 'tree-only' });

    const callRaw = {
      inputMode: 'visual' as unknown,
      domIncluded: false as const,
      extra: 'drop-me',
    };
    const callOut = normalizeCallModeOptions(callRaw);
    expect(callOut).toEqual({ inputMode: 'visual', domIncluded: false });
    expect(callRaw).toEqual({
      inputMode: 'visual',
      domIncluded: false,
      extra: 'drop-me',
    });

    expect(normalizeForwardableModeOptions({})).toEqual({});
    expect(normalizeForwardableModeOptions({ inputMode: 'tree-only' })).toEqual(
      { inputMode: 'tree-only' },
    );
  });

  it('retains legacy flags only when no explicit mode exists', () => {
    const implicit = resolveEffectiveInputMode({});
    expect(() =>
      assertLegacyFlagsCompatible(implicit, {
        domIncluded: true,
        screenshotIncluded: false,
      }),
    ).not.toThrow();
  });

  it('rejects defined legacy flags under any explicit mode, including false', () => {
    const inherited = resolveEffectiveInputMode({
      agentInputMode: 'tree-only',
    });
    expect(() =>
      assertLegacyFlagsCompatible(inherited, { domIncluded: false }),
    ).toThrow(/agent options.*domIncluded/);
    expect(() =>
      assertLegacyFlagsCompatible(
        inherited,
        { screenshotIncluded: false },
        { operation: 'aiAct' },
      ),
    ).toThrow(/remove the legacy/);

    const explicitVisual = resolveEffectiveInputMode({
      callInputMode: 'visual',
    });
    expect(() =>
      assertLegacyFlagsCompatible(explicitVisual, {
        domIncluded: 'visible-only',
      }),
    ).toThrow(/explicit input mode "visual" from call options/);

    const yamlStep = resolveYamlInputMode({ stepInputMode: 'tree-only' });
    expect(
      categoryOf(() =>
        assertLegacyFlagsCompatible(yamlStep, { domIncluded: true }),
      ),
    ).toBe('unsupported-input');

    const explicit = resolveEffectiveInputMode({
      callInputMode: 'tree-only',
    });
    expect(() =>
      assertLegacyFlagsCompatible(explicit, undefined),
    ).not.toThrow();
    expect(() => assertLegacyFlagsCompatible(explicit, {})).not.toThrow();
  });

  it('inherits nested calls and rejects conflicting nested modes', () => {
    const parent = resolveEffectiveInputMode({
      agentInputMode: 'tree-only',
    });
    const inherited = resolveNestedInputMode(parent, undefined);
    expect(inherited).toEqual(parent);
    expect(inherited).not.toBe(parent);
    expect(resolveNestedInputMode(parent, 'tree-only')).toEqual(parent);
    expect(categoryOf(() => resolveNestedInputMode(parent, 'visual'))).toBe(
      'unsupported-input',
    );
    expect(() => resolveNestedInputMode(parent, 'visual')).toThrow(
      /conflicting nested input mode/,
    );
    expect(categoryOf(() => resolveNestedInputMode(parent, 'hybrid'))).toBe(
      'unsupported-operation',
    );
    expect(categoryOf(() => resolveNestedInputMode(parent, null))).toBe(
      'malformed',
    );
  });

  it('rejects inputMode on recorded observations without inheriting live mode', () => {
    expect(() => assertObservationHasNoInputMode(undefined)).not.toThrow();
    expect(() => assertObservationHasNoInputMode({})).not.toThrow();
    expect(() =>
      assertObservationHasNoInputMode({ domIncluded: true }),
    ).not.toThrow();
    for (const raw of ['visual', 'tree-only', 'hybrid', null]) {
      expect(
        categoryOf(() => assertObservationHasNoInputMode({ inputMode: raw })),
      ).toBe('unsupported-input');
    }
    expect(() =>
      assertObservationHasNoInputMode({ inputMode: 'visual' }),
    ).toThrow(/only evaluates recorded screenshots/);
  });

  it('validates forwarded inputMode in test-runner schemas', () => {
    for (const schema of [
      aiActOptionsInputSchema,
      insightOptionsInputSchema,
      locateOptionsInputSchema,
    ]) {
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ inputMode: 'visual' }).success).toBe(true);
      expect(schema.safeParse({ inputMode: 'tree-only' }).success).toBe(true);
      expect(schema.safeParse({ inputMode: 'hybrid' }).success).toBe(false);
      expect(schema.safeParse({ inputMode: null }).success).toBe(false);
      expect(schema.safeParse({ inputMode: 'unknown' }).success).toBe(false);
    }
  });
});
