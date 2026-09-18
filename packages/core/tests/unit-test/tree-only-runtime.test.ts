import type {
  TreeOnlyPlannerDecision,
  TreeOnlyPlannerInput,
} from '@/tree-only/planner';
import {
  type TreeOnlyCapture,
  type TreeOnlyRunOptions,
  buildTreeOnlyRequest,
  runTreeOnly,
} from '@/tree-only/runtime';
import {
  type JevEvaluationRequest,
  type JevEvaluationResponse,
  TreeOnlyOperationError,
} from '@/tree-only/types';
import { describe, expect, it, rs } from '@rstest/core';

const rect = { left: 10, top: 10, width: 100, height: 30 };
function validated(ref: string) {
  const name = ref === 'r2' ? 'Name' : 'Submit';
  return {
    element: {
      center: [60, 25] as [number, number],
      rect,
      description: name,
    },
    observation: {
      role: ref === 'r2' ? 'textbox' : 'button',
      name,
    },
  };
}
function capture(): TreeOnlyCapture {
  return {
    snapshot: {
      base: {
        snapshotId: 's1',
        platform: 'browser',
        capturedAt: 0,
        viewport: { id: 'main', width: 800, height: 600 },
        coordinateSpace: { units: 'css-px' },
        status: 'success-nonempty',
        coverageGaps: [],
        delivery: { truncated: false },
      },
      nodes: [
        { ref: 'r1', role: 'button', name: 'Submit', bounds: rect },
        { ref: 'r2', role: 'textbox', name: 'Name', bounds: rect },
      ],
    },
    page: { url: 'https://fixture.test', title: 'Form', text: 'Name Submit' },
    validate: rs.fn(async (ref: string) => validated(ref)),
    release: rs.fn(async () => {}),
  };
}
function answer(
  request: JevEvaluationRequest,
  operation = 'CLICK',
  target = 'r1',
): JevEvaluationResponse {
  return {
    model: 'test-jev',
    answers: request.questions.map((q) => ({
      questionId: q.id,
      kind: 'choice' as const,
      optionId:
        q.id === 'operation'
          ? operation
          : q.id === `target_${operation}`
            ? target
            : 'no-match',
    })),
  };
}
function setup() {
  const captured = capture();
  const options: TreeOnlyRunOptions = {
    context: {
      operationId: 'test',
      kind: 'aiact',
      instruction: 'Submit the form',
      effectiveMode: 'tree-only',
      modeSource: 'agent',
    },
    browser: { capture: rs.fn(async () => captured) },
    model: 'test-jev',
    maxSteps: 5,
    evaluate: rs.fn(async (request) => answer(request, 'DONE')),
    typeText: rs.fn(async () => 'Alice'),
    execute: rs.fn(async (plan, beforeDispatch) => {
      await beforeDispatch(plan.param);
    }),
  };
  return { options, captured };
}

describe('tree-only Jev actions', () => {
  it('sends named JSON context and batches compatible target questions without executable identities', () => {
    const request = buildTreeOnlyRequest(capture(), 'Fill form', [], 'test');
    expect(request.questions.map((q) => q.id)).toEqual([
      'operation',
      'target_CLICK',
      'target_TYPE_TEXT',
    ]);
    const state = JSON.parse(request.state);
    expect(state.page.title).toBe('Form');
    expect(state.elements[1].supported_operations).toEqual([
      'CLICK',
      'TYPE_TEXT',
    ]);
    expect(request.state).not.toMatch(
      /screenshot|base64|xpath|selector|apiKey/,
    );
    const typing = request.questions.find((q) => q.id === 'target_TYPE_TEXT');
    expect(
      typing?.kind === 'choice' && typing.options.map((o) => o.id),
    ).toEqual(['no-match', 'r2']);
  });
  it('types, clicks and completes; ignores unused targets and supplies recent actions', async () => {
    const { options, captured } = setup();
    const requests: JevEvaluationRequest[] = [];
    options.evaluate = rs.fn(async (request: JevEvaluationRequest) => {
      requests.push(request);
      return answer(
        request,
        requests.length === 1
          ? 'TYPE_TEXT'
          : requests.length === 2
            ? 'CLICK'
            : 'DONE',
        requests.length === 1 ? 'r2' : 'r1',
      );
    });
    await runTreeOnly(options);
    expect(options.execute).toHaveBeenCalledTimes(2);
    expect(options.typeText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(requests[2].state).recent_actions).toEqual([
      {
        operation: 'TYPE_TEXT',
        target: 'Name',
        value: 'Alice',
        outcome: 'confirmed',
      },
      { operation: 'CLICK', target: 'Submit', outcome: 'confirmed' },
    ]);
    expect(captured.validate).toHaveBeenCalledTimes(4);
    expect(captured.release).toHaveBeenCalled();
  });
  it('direct input uses the supplied value without invoking the helper', async () => {
    const { options } = setup();
    options.direct = { type: 'Input', param: { value: 'Bob' } };
    options.evaluate = async (request) => answer(request, 'TYPE_TEXT', 'r2');
    await runTreeOnly(options);
    expect(options.typeText).not.toHaveBeenCalled();
    expect(options.execute).toHaveBeenCalledTimes(1);
  });
  it.each(['no-match', 'invented'])(
    'rejects invalid selected target %s before input',
    async (target) => {
      const { options } = setup();
      options.evaluate = async (request) => answer(request, 'CLICK', target);
      await expect(runTreeOnly(options)).rejects.toThrow();
      expect(options.execute).not.toHaveBeenCalled();
    },
  );
  it('fails overflow and truncated captures without a model call', async () => {
    const { options, captured } = setup();
    captured.snapshot.nodes = Array.from({ length: 255 }, (_, i) => ({
      ref: `r${i}`,
      role: 'button',
      bounds: rect,
    }));
    await expect(runTreeOnly(options)).rejects.toThrow(
      'Too many CLICK candidates',
    );
    expect(options.evaluate).not.toHaveBeenCalled();
    captured.snapshot.nodes = [];
    captured.snapshot.base.delivery.truncated = true;
    await expect(runTreeOnly(options)).rejects.toThrow('capture budget');
  });
  it('reselects stale evidence within the shared budget before dispatch', async () => {
    const { options, captured } = setup();
    options.direct = { type: 'Tap', param: {} };
    options.evaluate = async (request) => answer(request);
    let calls = 0;
    captured.validate = async () => {
      if (++calls === 1)
        throw new TreeOnlyOperationError('stale', 'stale-target');
      return validated('r1');
    };
    await runTreeOnly(options);
    expect(options.browser.capture).toHaveBeenCalledTimes(2);
    expect(options.execute).toHaveBeenCalledTimes(1);
  });
  it('inspects an uncertain dispatched mutation once and never repeats it', async () => {
    const { options } = setup();
    options.evaluate = async (request) => answer(request);
    options.execute = rs.fn(async (plan, beforeDispatch) => {
      await beforeDispatch(plan.param);
      throw new Error('input outcome unknown');
    });
    let error: unknown;
    try {
      await runTreeOnly(options);
    } catch (caught) {
      error = caught;
    }
    expect((error as TreeOnlyOperationError).category).toBe(
      'uncertain-delivery',
    );
    expect((error as Error).message).toContain('input outcome unknown');
    expect((error as Error).message).toContain('fresh evidence');
    expect(options.execute).toHaveBeenCalledTimes(1);
    expect(options.browser.capture).toHaveBeenCalledTimes(2);
  });
  it('reports inspected meaning by role and name instead of reusing a ref', async () => {
    const { options, captured } = setup();
    options.evaluate = async (request) => answer(request);
    options.execute = rs.fn(async (plan, beforeDispatch) => {
      await beforeDispatch(plan.param);
      throw new Error('input outcome unknown');
    });
    let calls = 0;
    options.browser.capture = rs.fn(async () => {
      calls += 1;
      if (calls === 1) return captured;
      return {
        ...captured,
        snapshot: {
          ...captured.snapshot,
          base: { ...captured.snapshot.base, snapshotId: 's2' },
          nodes: [{ ref: 'r1', role: 'button', name: 'Delete', bounds: rect }],
        },
        release: rs.fn(async () => {}),
      } as TreeOnlyCapture;
    });
    let error: unknown;
    try {
      await runTreeOnly(options);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toContain('no longer present');
    expect((error as Error).message).toContain('Delete');
    expect((error as Error).message).toContain('now denotes');
  });
  it('fails a dispatched permanent failure as a confirmed incorrect interaction', async () => {
    const { options } = setup();
    options.evaluate = async (request) => answer(request);
    options.execute = rs.fn(async (plan, beforeDispatch) => {
      await beforeDispatch(plan.param);
      throw new TreeOnlyOperationError(
        'element became obstructed',
        'obstruction',
      );
    });
    let error: unknown;
    try {
      await runTreeOnly(options);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TreeOnlyOperationError);
    expect((error as TreeOnlyOperationError).category).toBe('obstruction');
    expect((error as Error).message).toContain('obstructed');
    expect(options.execute).toHaveBeenCalledTimes(1);
    expect(options.browser.capture).toHaveBeenCalledTimes(1);
  });
  it('recovers a freshness failure raised by final dispatch validation', async () => {
    const { options, captured } = setup();
    options.direct = { type: 'Tap', param: {} };
    options.evaluate = async (request) => answer(request);
    let calls = 0;
    captured.validate = async (ref: string) => {
      calls += 1;
      if (calls === 2)
        throw new TreeOnlyOperationError(
          'target changed at dispatch',
          'stale-target',
        );
      return validated(ref);
    };
    await runTreeOnly(options);
    expect(options.browser.capture).toHaveBeenCalledTimes(2);
    expect(options.execute).toHaveBeenCalledTimes(2);
  });
  it('refuses a target whose meaning changed even though the ref still resolves', async () => {
    const { options, captured } = setup();
    options.direct = { type: 'Tap', param: {} };
    options.evaluate = async (request) => answer(request);
    captured.validate = async () => ({
      element: { center: [60, 25], rect, description: 'Delete' },
      observation: { role: 'button', name: 'Delete' },
    });
    await expect(runTreeOnly(options)).rejects.toThrow(
      /changed after selection/,
    );
    expect(options.execute).not.toHaveBeenCalled();
  });
  it('stops after the initial attempt and two service recoveries', async () => {
    const { options } = setup();
    options.evaluate = rs.fn(async () => {
      throw new Error('service unavailable');
    });
    await expect(runTreeOnly(options)).rejects.toThrow('budget exhausted');
    expect(options.evaluate).toHaveBeenCalledTimes(3);
    expect(options.execute).not.toHaveBeenCalled();
  });
  it('honors cancellation before capture and reports blocked explicitly', async () => {
    const { options } = setup();
    options.context.abortSignal = AbortSignal.abort();
    await expect(runTreeOnly(options)).rejects.toThrow();
    expect(options.browser.capture).not.toHaveBeenCalled();
    options.context.abortSignal = undefined;
    options.evaluate = async (request) => answer(request, 'BLOCKED');
    await expect(runTreeOnly(options)).rejects.toThrow('cannot complete');
  });
  it('rejects helper failures without browser input', async () => {
    const { options } = setup();
    options.evaluate = async (request) => answer(request, 'TYPE_TEXT', 'r2');
    options.typeText = async () => {
      throw new TreeOnlyOperationError('bad helper JSON', 'malformed');
    };
    await expect(runTreeOnly(options)).rejects.toThrow('bad helper JSON');
    expect(options.execute).not.toHaveBeenCalled();
  });
});

describe('tree-only planned operations', () => {
  function plannedSetup(decisions: TreeOnlyPlannerDecision[]) {
    const { options, captured } = setup();
    options.plan = rs.fn(async () => decisions.shift()!);
    return { options, captured };
  }

  it('routes each planned interaction to Jev for target selection only', async () => {
    const { options } = plannedSetup([
      { operation: 'TYPE_TEXT', instruction: 'the Name field', value: 'Alice' },
      { operation: 'CLICK', instruction: 'the Submit button' },
      { operation: 'DONE' },
    ]);
    const requests: JevEvaluationRequest[] = [];
    options.evaluate = rs.fn(async (request: JevEvaluationRequest) => {
      requests.push(request);
      return {
        model: 'test-jev',
        answers: request.questions.map((question) => ({
          questionId: question.id,
          kind: 'choice' as const,
          optionId:
            question.id === 'target_TYPE_TEXT'
              ? 'r2'
              : question.id === 'target_CLICK'
                ? 'r1'
                : 'no-match',
        })),
      };
    });
    await runTreeOnly(options);

    // The planner chooses the operation; Jev sees only the target question.
    expect(
      requests.map((request) => request.questions.map((q) => q.id)),
    ).toEqual([['target_TYPE_TEXT'], ['target_CLICK']]);
    expect(JSON.parse(requests[0].state).goal).toBe('the Name field');
    const calls = rs.mocked(options.execute).mock.calls;
    expect(calls.map(([plan]) => plan.type)).toEqual(['Input', 'Tap']);
    expect(calls[0][0].param.value).toBe('Alice');
    expect(calls[0][0].param.locate.center).toEqual([60, 25]);
    expect(calls[1][0].param.locate.center).toEqual([60, 25]);
    expect(options.typeText).not.toHaveBeenCalled();
  });

  it('passes instruction, public context, and recovery context to the planner', async () => {
    const { options } = plannedSetup([{ operation: 'DONE' }]);
    options.context.actionContext = 'public context';
    options.context.recoveryContext = 'fresh evidence';
    await runTreeOnly(options);
    expect(options.plan).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: 'Submit the form',
        actionContext: 'public context',
        recoveryContext: 'fresh evidence',
        state: expect.objectContaining({
          page: expect.objectContaining({ title: 'Form' }),
          elements: expect.any(Array),
          recent_actions: [],
        }),
      }),
    );
    expect(options.evaluate).not.toHaveBeenCalled();
  });

  it('includes interaction, public, and recovery context in the Jev goal', async () => {
    const { options } = plannedSetup([
      { operation: 'CLICK', instruction: 'the Submit button' },
      { operation: 'DONE' },
    ]);
    options.context.actionContext = 'admin UI';
    options.context.recoveryContext = 'the previous click missed';
    const requests: JevEvaluationRequest[] = [];
    options.evaluate = rs.fn(async (request: JevEvaluationRequest) => {
      requests.push(request);
      return answer(request, 'CLICK', 'r1');
    });
    await runTreeOnly(options);
    expect(JSON.parse(requests[0].state).goal).toBe(
      'the Submit button\nContext: admin UI\nRecovery: the previous click missed',
    );
    expect(options.execute).toHaveBeenCalledTimes(1);
  });

  it('uses the typing helper only when the planner omits an input value', async () => {
    const { options } = plannedSetup([
      { operation: 'TYPE_TEXT', instruction: 'the Name field' },
      { operation: 'DONE' },
    ]);
    options.evaluate = async (request) => answer(request, 'TYPE_TEXT', 'r2');
    await runTreeOnly(options);
    expect(options.typeText).toHaveBeenCalledTimes(1);
    expect(options.typeText).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: 'the Name field',
        field: expect.objectContaining({ ref: 'r2' }),
      }),
    );
    const calls = rs.mocked(options.execute).mock.calls;
    expect(calls[0][0].param.value).toBe('Alice');
  });

  it('executes planned scrolls without a model call and preserves parameters', async () => {
    const { options } = plannedSetup([
      { operation: 'SCROLL_UP', distance: 120 },
      { operation: 'DONE' },
    ]);
    await runTreeOnly(options);
    expect(options.evaluate).not.toHaveBeenCalled();
    const calls = rs.mocked(options.execute).mock.calls;
    expect(calls[0][0]).toMatchObject({
      type: 'Scroll',
      param: { direction: 'up', scrollType: 'singleAction', distance: 120 },
    });
  });

  it('recovers planner failures through the shared budget', async () => {
    const { options, captured } = setup();
    let attempts = 0;
    options.plan = rs.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('planner service unavailable');
      return { operation: 'DONE' as const };
    });
    await runTreeOnly(options);
    expect(attempts).toBe(2);
    expect(options.browser.capture).toHaveBeenCalledTimes(2);
    expect(captured.release).toHaveBeenCalled();
  });

  it('feeds revised failure context and fresh evidence into planner recovery', async () => {
    const { options } = setup();
    const inputs: TreeOnlyPlannerInput[] = [];
    let attempts = 0;
    options.plan = rs.fn(async (input: TreeOnlyPlannerInput) => {
      inputs.push(input);
      attempts += 1;
      if (attempts === 1) throw new Error('planner service unavailable');
      return { operation: 'DONE' as const };
    });
    await runTreeOnly(options);
    expect(inputs).toHaveLength(2);
    expect(inputs[1].recoveryContext).toContain('planner service unavailable');
    expect(inputs[1].recoveryContext).toContain('fresh evidence');
    expect(inputs[1].state.page.title).toBe('Form');
  });

  it('revises planner context with the changed target meaning', async () => {
    const { options, captured } = setup();
    const inputs: TreeOnlyPlannerInput[] = [];
    const decisions: TreeOnlyPlannerDecision[] = [
      { operation: 'CLICK', instruction: 'the Submit button' },
      { operation: 'CLICK', instruction: 'the Submit button' },
      { operation: 'DONE' },
    ];
    options.plan = rs.fn(async (input: TreeOnlyPlannerInput) => {
      inputs.push(input);
      return decisions.shift()!;
    });
    options.evaluate = async (request) => answer(request, 'CLICK', 'r1');
    let calls = 0;
    captured.validate = async (ref: string) => {
      calls += 1;
      if (calls === 1)
        return {
          element: { center: [60, 25], rect, description: 'Delete' },
          observation: { role: 'button', name: 'Delete' },
        };
      return validated(ref);
    };
    await runTreeOnly(options);
    expect(inputs).toHaveLength(3);
    expect(inputs[1].recoveryContext).toContain('changed after selection');
    expect(inputs[1].recoveryContext).toContain('Delete');
    expect(options.execute).toHaveBeenCalledTimes(1);
  });

  it('does not accept a later planner completion after a dispatched failure', async () => {
    const { options } = plannedSetup([
      { operation: 'CLICK', instruction: 'the Submit button' },
      { operation: 'DONE' },
    ]);
    options.evaluate = async (request) => answer(request, 'CLICK', 'r1');
    options.execute = rs.fn(async (plan, beforeDispatch) => {
      await beforeDispatch(plan.param);
      throw new Error('click outcome unknown');
    });
    await expect(runTreeOnly(options)).rejects.toThrow('click outcome unknown');
    expect(options.plan).toHaveBeenCalledTimes(1);
    expect(options.execute).toHaveBeenCalledTimes(1);
  });

  it('fails a dispatched permanent action failure without replanning', async () => {
    const { options } = plannedSetup([
      { operation: 'CLICK', instruction: 'the Submit button' },
      { operation: 'DONE' },
    ]);
    options.evaluate = async (request) => answer(request, 'CLICK', 'r1');
    options.execute = rs.fn(async (plan, beforeDispatch) => {
      await beforeDispatch(plan.param);
      throw new TreeOnlyOperationError('target vanished mid-action', 'missing');
    });
    await expect(runTreeOnly(options)).rejects.toThrow('target vanished');
    expect(options.plan).toHaveBeenCalledTimes(1);
    expect(options.execute).toHaveBeenCalledTimes(1);
    expect(options.browser.capture).toHaveBeenCalledTimes(1);
  });

  it('fails a blocked plan permanently without asking Jev', async () => {
    const { options } = plannedSetup([
      { operation: 'BLOCKED', message: 'no supported path' },
    ]);
    await expect(runTreeOnly(options)).rejects.toThrow('no supported path');
    expect(options.evaluate).not.toHaveBeenCalled();
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.browser.capture).toHaveBeenCalledTimes(1);
  });

  it('rejects combining a planner with a direct action', async () => {
    const { options } = setup();
    options.plan = async () => ({ operation: 'DONE' });
    options.direct = { type: 'Tap', param: {} };
    await expect(runTreeOnly(options)).rejects.toThrow('not both');
    expect(options.browser.capture).not.toHaveBeenCalled();
  });

  it('does not plan from failed or truncated captures', async () => {
    const { options, captured } = plannedSetup([{ operation: 'DONE' }]);
    captured.snapshot.base.delivery.truncated = true;
    await expect(runTreeOnly(options)).rejects.toThrow('capture budget');
    expect(options.plan).not.toHaveBeenCalled();

    captured.snapshot.base.delivery.truncated = false;
    captured.snapshot.base.status = 'failed';
    await expect(runTreeOnly(options)).rejects.toThrow('capture failed');
    expect(options.plan).not.toHaveBeenCalled();
  });
});
