import type { TModelFamily } from '@midscene/shared/env';
import type {
  ChatCompletionCallContext,
  ChatCompletionParamsResult,
  ModelAdapterDefinition,
} from '../model-adapter/types';

const resolveMuseReasoningEffort = (
  input: ChatCompletionCallContext,
): string | undefined => {
  const { reasoningEnabled, reasoningEffort } = input.userConfig;

  // 'default' follows provider default: omit param, model picks level.
  if (reasoningEnabled === 'default') {
    return reasoningEffort;
  }

  // Explicit effort always wins when set.
  if (reasoningEffort) {
    return reasoningEffort;
  }

  if (reasoningEnabled === true) {
    // OpenRouter + Meta docs default to medium.
    return 'medium';
  }

  if (reasoningEnabled === false) {
    // Muse rejects "none" (HTTP 400), so map disabled to lowest level.
    return 'minimal';
  }

  // Unset: omit param, let model decide.
  return undefined;
};

const buildMuseChatCompletionParams = (
  input: ChatCompletionCallContext,
): ChatCompletionParamsResult => {
  const { midsceneDefaults, userConfig } = input;
  const commonOverrideConfig: Record<string, unknown> = {};

  if (userConfig.temperature !== undefined) {
    commonOverrideConfig.temperature = userConfig.temperature;
  }

  // Muse supports structured outputs via response_format.
  // https://openrouter.ai/meta/muse-spark-1.3-contributor
  if (
    userConfig.responseFormat !== 'none' &&
    input.expectedJsonObjectResponse
  ) {
    commonOverrideConfig.response_format = { type: 'json_object' };
  }

  // Meta Chat Completions uses top-level reasoning_effort:
  // minimal/low/medium/high/xhigh. "none" returns HTTP 400.
  // https://ai.developer.meta.com/docs/features/reasoning
  const reasoningEffort = resolveMuseReasoningEffort(input);

  return {
    config: {
      ...midsceneDefaults,
      ...commonOverrideConfig,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    },
  };
};

export const museAdapters = {
  'muse-spark': {
    acceptBbox2dAlias: true,
    chatCompletion: {
      unsupportedUserConfig: ['reasoningBudget'],
      buildChatCompletionParams: buildMuseChatCompletionParams,
      messageExtraction: {
        kind: 'default',
        // OpenRouter may surface thinking as `reasoning` instead of
        // `reasoning_content`; accept both like qwen adapters.
        reasoningContentKeys: ['reasoning_content', 'reasoning'],
      },
      useReasoningAsContentFallback: true,
    },
    locate: {
      element: {
        resultFormat: {
          coordinates: { shape: 'bbox', order: 'xy', normalizedBy: 1000 },
        },
      },
    },
  },
} satisfies Pick<Record<TModelFamily, ModelAdapterDefinition>, 'muse-spark'>;
