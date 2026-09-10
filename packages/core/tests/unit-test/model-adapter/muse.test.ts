import { ResolvedModelAdapter } from '@/ai-model/model-adapter/resolve';
import { getModelAdapter } from '@/ai-model/models';
import { museAdapters } from '@/ai-model/models/muse';
import { describe, expect, it } from '@rstest/core';

const museAdapter = new ResolvedModelAdapter(
  museAdapters['muse-spark'],
  'muse-spark',
);

describe('muse model adapter', () => {
  it('omits reasoning_effort by default and lets model decide', () => {
    const result = museAdapter.chatCompletion.buildChatCompletionParams({
      userConfig: {},
    });

    expect(museAdapter.chatCompletion.unsupportedUserConfig).toEqual([
      'reasoningBudget',
    ]);
    expect(result.config).toEqual({
      temperature: 0,
    });
  });

  it('preserves midscene defaults and applies explicit temperature override', () => {
    const buildChatCompletionParams =
      museAdapters['muse-spark'].chatCompletion?.buildChatCompletionParams;
    expect(buildChatCompletionParams).toBeDefined();
    if (!buildChatCompletionParams) {
      throw new Error(
        'muse-spark should define chat completion params builder',
      );
    }

    const result = buildChatCompletionParams({
      midsceneDefaults: {
        temperature: 0,
        seed: 123,
      } as any,
      userConfig: {
        temperature: 0.7,
        reasoningEnabled: true,
      },
    });

    expect(result.config).toEqual({
      temperature: 0.7,
      seed: 123,
      reasoning_effort: 'medium',
    });
  });

  it('maps reasoningEnabled=true to medium effort', () => {
    const result = museAdapter.chatCompletion.buildChatCompletionParams({
      userConfig: {
        reasoningEnabled: true,
      },
    });

    expect(result.config).toEqual({
      temperature: 0,
      reasoning_effort: 'medium',
    });
  });

  it('maps reasoningEnabled=false to minimal effort since none is rejected', () => {
    const result = museAdapter.chatCompletion.buildChatCompletionParams({
      userConfig: {
        reasoningEnabled: false,
      },
    });

    expect(result.config).toEqual({
      temperature: 0,
      reasoning_effort: 'minimal',
    });
  });

  it('follows provider default when reasoningEnabled=default', () => {
    const result = museAdapter.chatCompletion.buildChatCompletionParams({
      userConfig: {
        reasoningEnabled: 'default',
      },
    });

    expect(result.config).toEqual({
      temperature: 0,
    });
  });

  it('prefers explicit reasoningEffort over enabled flag', () => {
    const result = museAdapter.chatCompletion.buildChatCompletionParams({
      userConfig: {
        reasoningEnabled: true,
        reasoningEffort: 'xhigh',
      },
    });

    expect(result.config).toEqual({
      temperature: 0,
      reasoning_effort: 'xhigh',
    });
  });

  it('uses explicit reasoningEffort even without enabled flag', () => {
    const result = museAdapter.chatCompletion.buildChatCompletionParams({
      userConfig: {
        reasoningEffort: 'high',
      },
    });

    expect(result.config).toEqual({
      temperature: 0,
      reasoning_effort: 'high',
    });
  });

  it('uses json_object response format when expected', () => {
    const result = museAdapter.chatCompletion.buildChatCompletionParams({
      expectedJsonObjectResponse: true,
      userConfig: {},
    });

    expect(result.config).toEqual({
      temperature: 0,
      response_format: { type: 'json_object' },
    });
  });

  it('does not use json_object response format when disabled', () => {
    const result = museAdapter.chatCompletion.buildChatCompletionParams({
      expectedJsonObjectResponse: true,
      userConfig: { responseFormat: 'none' },
    });

    expect(result.config.response_format).toBeUndefined();
  });

  it('accepts reasoning and reasoning_content extraction keys', () => {
    const adapter = getModelAdapter('muse-spark');

    expect(adapter.chatCompletion.useReasoningAsContentFallback).toBe(true);
    expect(adapter.chatCompletion.replayRawAssistantMessage).toBe(false);
    expect(adapter.acceptBbox2dAlias).toBe(true);

    const fromReasoningContent =
      adapter.chatCompletion.extractContentAndReasoning({
        content: 'act',
        reasoning_content: 'thinking',
      } as any);
    const fromReasoning = adapter.chatCompletion.extractContentAndReasoning({
      content: 'act',
      reasoning: 'thinking',
    } as any);

    expect(fromReasoningContent.reasoning_content).toBe('thinking');
    expect(fromReasoning.reasoning_content).toBe('thinking');
  });

  it('uses normalized bbox xy locate coordinates', () => {
    const adapter = getModelAdapter('muse-spark');

    expect(adapter.locate.kind).toBe('standard');
    if (adapter.locate.kind !== 'standard') {
      throw new Error('muse-spark should use standard locate');
    }
    expect(
      adapter.locate.element.resultCodec.promptSpec.resultValueDescription,
    ).toContain('normalized to 0-1000');
  });
});
