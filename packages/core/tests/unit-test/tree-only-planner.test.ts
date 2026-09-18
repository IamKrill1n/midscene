import { createDefaultMidscenePlanningProtocol } from '@/ai-model/model-adapter/default-planning-protocol';
import { getModelRuntime } from '@/ai-model/models';
import { callAI } from '@/ai-model/service-caller';
import { parseModelResponseJson } from '@/ai-model/shared/json';
import {
  actionInputParamSchema,
  actionScrollParamSchema,
  actionTapParamSchema,
} from '@/device';
import {
  createTreeOnlyPlanner,
  parseTreeOnlyPlannerDecision,
  treeOnlyPlannerActionSpace,
  treeOnlyPlannerDirect,
} from '@/tree-only/planner';
import type { DeviceAction } from '@/types';
import { beforeEach, describe, expect, it, rs } from '@rstest/core';

rs.mock('@/ai-model/service-caller', () => ({ callAI: rs.fn() }));

const planningProtocol = createDefaultMidscenePlanningProtocol({
  jsonParser: parseModelResponseJson,
});

function action(
  name: string,
  paramSchema: DeviceAction['paramSchema'],
  sample?: Record<string, unknown>,
): DeviceAction {
  return {
    name,
    description: `${name} action`,
    paramSchema,
    sample,
    call: async () => {},
  } as DeviceAction;
}

const actionSpace: DeviceAction[] = [
  action('Tap', actionTapParamSchema, {
    locate: { prompt: 'the Save button' },
  }),
  action('Input', actionInputParamSchema, {
    value: 'Alice',
    locate: { prompt: 'the Name field' },
  }),
  action('Scroll', actionScrollParamSchema, {
    direction: 'down',
    scrollType: 'singleAction',
  }),
  action('KeyboardPress', undefined, { keyName: 'Enter' }),
];

const runtime = getModelRuntime({
  modelName: 'planner',
  modelDescription: 'test',
  slot: 'planning',
  intent: 'planning',
});

const plannerInput = {
  instruction: 'Save the form',
  actionContext: 'admin UI',
  recoveryContext: 'the previous click did not register',
  state: {
    page: { url: 'https://fixture.test', title: 'Form', text: 'Name Submit' },
    elements: [
      {
        ref: 'r1',
        role: 'button',
        name: 'Submit',
        bounds: { left: 10, top: 10, width: 100, height: 30 },
        supported_operations: ['CLICK'],
      },
    ],
    coverage: [],
    recent_actions: [],
  },
};

beforeEach(() => {
  rs.clearAllMocks();
});

describe('tree-only planner request', () => {
  it('calls a text model with image-free messages and only tree-only actions', async () => {
    rs.mocked(callAI).mockResolvedValue({
      content:
        '<log>Click Save</log>\n<action-type>Tap</action-type>\n<action-param-json>{"locate":{"prompt":"the Save button"}}</action-param-json>',
      isStreamed: false,
    });
    const plan = createTreeOnlyPlanner({ runtime, actionSpace });
    const decision = await plan(plannerInput);
    expect(decision).toEqual({
      operation: 'CLICK',
      instruction: 'the Save button',
      log: 'Click Save',
    });

    const [messages, model] = rs.mocked(callAI).mock.calls[0];
    expect(messages).toHaveLength(2);
    expect(
      messages.every((message) => typeof message.content === 'string'),
    ).toBe(true);
    const system = messages[0].content as string;
    const user = messages[1].content as string;
    expect(system).toContain('JSON UI tree');
    expect(system).toContain('Tap');
    expect(system).toContain('Input');
    expect(system).toContain('Scroll');
    expect(system).not.toContain('KeyboardPress');
    expect(user).toContain(
      '<user_instruction>\nSave the form\n</user_instruction>',
    );
    expect(user).toContain('<CONTEXT>\nadmin UI\n</CONTEXT>');
    expect(user).toContain(
      '<RECOVERY_CONTEXT>\nthe previous click did not register\n</RECOVERY_CONTEXT>',
    );
    expect(user).toContain('"ref": "r1"');
    expect(model.config.retryCount).toBe(0);
  });

  it('keeps planner evidence text-only and bounded by the caller', async () => {
    rs.mocked(callAI).mockResolvedValue({
      content: '<complete success="true">done</complete>',
      isStreamed: false,
    });
    const plan = createTreeOnlyPlanner({ runtime, actionSpace });
    await plan({
      ...plannerInput,
      state: {
        ...plannerInput.state,
        recent_actions: [
          { operation: 'step-1', outcome: 'executed' },
          { operation: 'step-2', outcome: 'executed' },
        ],
      },
    });
    const user = rs.mocked(callAI).mock.calls[0][0][1].content as string;
    expect(user).toContain('step-1');
    expect(user).toContain('step-2');
    expect(user).not.toMatch(/screenshot|base64/i);
  });

  it('rejects custom planning adapters', () => {
    const customRuntime = {
      ...runtime,
      adapter: {
        ...runtime.adapter,
        planning: { kind: 'custom', planFn: async () => ({}) },
      },
    } as unknown as typeof runtime;
    expect(() =>
      createTreeOnlyPlanner({ runtime: customRuntime, actionSpace }),
    ).toThrow('standard planning adapter');
  });
});

describe('tree-only planner decisions', () => {
  const parse = (content: string) =>
    parseTreeOnlyPlannerDecision(content, { actionSpace, planningProtocol });

  it('accepts a tap and keeps only the textual target', () => {
    expect(
      parse(
        '<action-type>Tap</action-type><action-param-json>{"locate":{"prompt":"the Save button"}}</action-param-json>',
      ),
    ).toEqual({ operation: 'CLICK', instruction: 'the Save button' });
  });

  it('drops coordinate and locatedPixelResult output from locate params', () => {
    const decision = parse(
      '<action-type>Tap</action-type><action-param-json>{"locate":{"prompt":"the Save button","bbox":[1,2,3,4],"bbox_2d":[1,2,3,4],"locatedPixelResult":{"center":[1,2]}}}</action-param-json>',
    );
    expect(decision).toEqual({
      operation: 'CLICK',
      instruction: 'the Save button',
    });
    expect(JSON.stringify(decision)).not.toMatch(
      /bbox|locatedPixelResult|coordinates/,
    );
  });

  it('preserves input values as strings', () => {
    expect(
      parse(
        '<action-type>Input</action-type><action-param-json>{"value":42,"locate":{"prompt":"the Age field"}}</action-param-json>',
      ),
    ).toEqual({
      operation: 'TYPE_TEXT',
      instruction: 'the Age field',
      value: '42',
    });
  });

  it('supports page-level single scrolls with distance', () => {
    expect(
      parse(
        '<action-type>Scroll</action-type><action-param-json>{"direction":"up","distance":300,"scrollType":"singleAction"}</action-param-json>',
      ),
    ).toEqual({ operation: 'SCROLL_UP', distance: 300 });
  });

  it('rejects scroll targets and unsupported scroll options', () => {
    expect(() =>
      parse(
        '<action-type>Scroll</action-type><action-param-json>{"direction":"down","locate":{"prompt":"the list"}}</action-param-json>',
      ),
    ).toThrow('page-level only');
    expect(() =>
      parse(
        '<action-type>Scroll</action-type><action-param-json>{"direction":"right"}</action-param-json>',
      ),
    ).toThrow('Unsupported tree-only scroll direction');
    expect(() =>
      parse(
        '<action-type>Scroll</action-type><action-param-json>{"scrollType":"scrollToBottom"}</action-param-json>',
      ),
    ).toThrow('singleAction only');
  });

  it('maps completion and errors to explicit stops', () => {
    expect(parse('<complete success="true">all done</complete>')).toEqual({
      operation: 'DONE',
      message: 'all done',
    });
    expect(parse('<complete success="false">blocked</complete>')).toEqual({
      operation: 'BLOCKED',
      message: 'blocked',
    });
    expect(parse('<error>missing field</error>')).toEqual({
      operation: 'BLOCKED',
      message: 'missing field',
    });
  });

  it('rejects actions outside the tree-only set and missing targets', () => {
    expect(() =>
      parse(
        '<action-type>KeyboardPress</action-type><action-param-json>{"keyName":"Enter"}</action-param-json>',
      ),
    ).toThrow('Unsupported tree-only planner action: KeyboardPress');
    expect(() =>
      parse(
        '<action-type>Tap</action-type><action-param-json>{}</action-param-json>',
      ),
    ).toThrow('Tap requires a textual locate prompt');
  });

  it('fails when the planner returns nothing actionable', () => {
    expect(() => parse('<planning>thinking</planning>')).toThrow(
      'no action, completion, or error',
    );
  });
});

describe('tree-only planner to execution mapping', () => {
  it('restricts the planner action space to Tap, Input, and Scroll', () => {
    expect(
      treeOnlyPlannerActionSpace(actionSpace).map((it) => it.name),
    ).toEqual(['Tap', 'Input', 'Scroll']);
  });

  it('preserves planned parameters in the execution action', () => {
    expect(
      treeOnlyPlannerDirect({ operation: 'CLICK', instruction: 'Save' }),
    ).toEqual({ type: 'Tap', param: {} });
    expect(
      treeOnlyPlannerDirect({
        operation: 'TYPE_TEXT',
        instruction: 'Name',
        value: 'Alice',
      }),
    ).toEqual({ type: 'Input', param: { value: 'Alice' } });
    expect(
      treeOnlyPlannerDirect({ operation: 'SCROLL_DOWN', distance: 120 }),
    ).toEqual({
      type: 'Scroll',
      param: { direction: 'down', scrollType: 'singleAction', distance: 120 },
    });
    expect(treeOnlyPlannerDirect({ operation: 'SCROLL_UP' })).toEqual({
      type: 'Scroll',
      param: { direction: 'up', scrollType: 'singleAction' },
    });
  });
});
