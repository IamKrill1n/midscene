import { Agent } from '@/agent';
import { getModelRuntime } from '@/ai-model/models';
import {
  actionInputParamSchema,
  actionScrollParamSchema,
  actionTapParamSchema,
} from '@/device';
import type { DeviceAction } from '@/types';
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

function testAction(
  name: string,
  paramSchema: DeviceAction['paramSchema'],
): DeviceAction {
  return {
    name,
    description: `${name} action`,
    paramSchema,
    call: async () => {},
  } as DeviceAction;
}

/** Agent wired through the real runTreeOnlyOperation with a stubbed executor. */
function wiredAgent(aiContexts: Record<string, string> = {}) {
  const result = Object.create(Agent.prototype) as Agent<any>;
  (result as any).opts = { inputMode: 'tree-only', aiContexts };
  result.interface = { interfaceType: 'playwright', treeOnly: {} };
  (result as any).fullActionSpace = [
    testAction('Tap', actionTapParamSchema),
    testAction('Input', actionInputParamSchema),
    testAction('Scroll', actionScrollParamSchema),
  ];
  (result as any).resolveModelRuntime = rs.fn(() =>
    getModelRuntime({
      modelName: 'planner',
      modelDescription: 'test',
      slot: 'planning',
      intent: 'planning',
    }),
  );
  const runTreeOnly = rs.fn(async (_options: any) => undefined);
  result.taskExecutor = { runTreeOnly } as any;
  return { subject: result, runTreeOnly };
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

describe('Agent tree-only planner wiring', () => {
  it('plans aiAct with a text planner and passes the agent context', async () => {
    const { subject, runTreeOnly } = wiredAgent({
      aiAct: 'agent aiAct context',
    });
    await subject.aiAct('Complete form');
    expect(runTreeOnly).toHaveBeenCalledTimes(1);
    const options = runTreeOnly.mock.calls[0][0] as any;
    expect(typeof options.plan).toBe('function');
    expect(options.direct).toBeUndefined();
    expect(options.context.instruction).toBe('Complete form');
    expect(options.context.actionContext).toBe('agent aiAct context');
  });

  it('gives call context precedence over api and default contexts', async () => {
    const { subject, runTreeOnly } = wiredAgent({
      aiAct: 'agent aiAct context',
      default: 'default context',
    });
    await subject.aiAct('Complete form', { context: 'call context' });
    expect(runTreeOnly.mock.calls[0][0].context.actionContext).toBe(
      'call context',
    );
    await subject.aiAct('Complete form');
    expect(runTreeOnly.mock.calls[1][0].context.actionContext).toBe(
      'agent aiAct context',
    );
  });

  it('falls back to the default aiContexts entry', async () => {
    const { subject, runTreeOnly } = wiredAgent({ default: 'default context' });
    await subject.aiAct('Complete form');
    expect(runTreeOnly.mock.calls[0][0].context.actionContext).toBe(
      'default context',
    );
  });

  it('keeps direct primitives free of planning and action context', async () => {
    const { subject, runTreeOnly } = wiredAgent({ aiAct: 'agent context' });
    await subject.aiTap('Submit');
    const options = runTreeOnly.mock.calls[0][0] as any;
    expect(options.plan).toBeUndefined();
    expect(options.context.actionContext).toBeUndefined();
    expect(options.direct.type).toBe('Tap');
    expect(options.direct.param.locate.prompt).toContain('Submit');
  });

  it('rejects custom planning adapters for tree-only aiAct', async () => {
    const { subject } = wiredAgent();
    const runtime = getModelRuntime({
      modelName: 'planner',
      modelDescription: 'test',
      slot: 'planning',
      intent: 'planning',
    });
    (subject as any).resolveModelRuntime = rs.fn(() => ({
      ...runtime,
      adapter: {
        ...runtime.adapter,
        planning: { kind: 'custom', planFn: async () => ({}) },
      },
    }));
    await expect(subject.aiAct('Complete form')).rejects.toThrow(
      'standard planning adapter',
    );
  });
});
