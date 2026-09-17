import { Agent } from '@/agent';
import { describe, expect, it, rs } from '@rstest/core';

function agent(mode: 'visual' | 'tree-only' = 'tree-only') {
  const result = Object.create(Agent.prototype) as Agent<any>;
  (result as any).opts = { inputMode: mode };
  result.interface = { interfaceType: 'playwright', treeOnly: {} };
  (result as any).runTreeOnlyOperation = rs.fn(async () => undefined);
  (result as any).resolveModelRuntime = rs.fn(() => ({}));
  result.taskExecutor = {
    runPlans: rs.fn(async () => ({ output: undefined })),
  } as any;
  return result;
}

describe('Agent tree-only routing', () => {
  it('routes aiAct and direct actions without resolving a visual model', async () => {
    const subject = agent();
    await subject.aiAct('Complete form');
    await subject.aiTap('Submit');
    await subject.aiInput('Name', { value: 'Alice' });
    await subject.aiScroll({ direction: 'down' });
    expect((subject as any).runTreeOnlyOperation).toHaveBeenCalledTimes(4);
    expect((subject as any).resolveModelRuntime).not.toHaveBeenCalled();
  });
  it('honors per-call mode without changing the agent default', async () => {
    const subject = agent('visual');
    await subject.aiTap('Submit', { inputMode: 'tree-only' });
    expect((subject as any).runTreeOnlyOperation).toHaveBeenCalledTimes(1);
    await subject.aiTap('Submit');
    expect(subject.taskExecutor.runPlans).toHaveBeenCalledTimes(1);
    expect((subject as any).opts.inputMode).toBe('visual');
  });
  it('rejects queries, assertions, waits and undeclared direct actions', async () => {
    const subject = agent();
    await expect(subject.aiQuery('title')).rejects.toThrow('not supported');
    await expect(subject.aiAssert('complete')).rejects.toThrow('not supported');
    await expect(subject.aiWaitFor('complete')).rejects.toThrow(
      'not supported',
    );
    await expect(subject.aiHover('Submit')).rejects.toThrow('not supported');
    await expect(
      subject.aiTap('Submit', { fileChooserAccept: '/tmp/file' }),
    ).rejects.toThrow('not supported');
    expect((subject as any).resolveModelRuntime).not.toHaveBeenCalled();
  });
  it('rejects unsupported platforms before model resolution', async () => {
    const subject = agent();
    subject.interface.interfaceType = 'puppeteer';
    await expect(subject.aiAct('Click')).rejects.toThrow('Playwright Chromium');
  });
});
