import { getModelRuntime } from '@/ai-model/models';
import { callAI } from '@/ai-model/service-caller';
import { treeOnlyTypingText } from '@/tree-only/text-helper';
import { beforeEach, describe, expect, it, rs } from '@rstest/core';
rs.mock('@/ai-model/service-caller', () => ({ callAI: rs.fn() }));
const input = {
  goal: 'Enter Alice',
  field: { ref: 'r1', role: 'textbox', name: 'Name', bounds: null },
  page: { url: 'https://fixture.test', title: 'Form', text: 'Name' },
  recent_actions: [],
};
const runtime = getModelRuntime({
  modelName: 'text-helper',
  modelDescription: 'test',
  slot: 'default',
  intent: 'default',
});
beforeEach(() => {
  rs.clearAllMocks();
});
describe('tree-only typing helper', () => {
  it('sends only text and disables nested retries', async () => {
    rs.mocked(callAI).mockResolvedValue({
      content: '{"text":"Alice"}',
      isStreamed: false,
    });
    expect(await treeOnlyTypingText(input, runtime)).toBe('Alice');
    const [messages, model] = rs.mocked(callAI).mock.calls[0];
    expect(
      messages.every((message) => typeof message.content === 'string'),
    ).toBe(true);
    expect(JSON.parse(messages[1].content as string)).toEqual(input);
    expect(model.config.retryCount).toBe(0);
  });
  it.each([
    'not JSON',
    '{"text": 3}',
    '{"text":"Alice","selector":"#name"}',
    'null',
    '[]',
  ])('rejects malformed helper output %s', async (content) => {
    rs.mocked(callAI).mockResolvedValue({ content, isStreamed: false });
    await expect(treeOnlyTypingText(input, runtime)).rejects.toThrow();
    expect(callAI).toHaveBeenCalledTimes(1);
  });
});
