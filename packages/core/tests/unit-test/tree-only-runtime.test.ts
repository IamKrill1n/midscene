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
    validate: rs.fn(async () => ({
      center: [60, 25] as [number, number],
      rect,
      description: 'field',
    })),
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
    execute: rs.fn(async (plan, before) => {
      await before(plan.param);
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
    options.evaluate = rs.fn(async (request) => {
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
        outcome: 'executed',
      },
      { operation: 'CLICK', target: 'Submit', outcome: 'executed' },
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
      return { center: [60, 25], rect, description: 'Submit' };
    };
    await runTreeOnly(options);
    expect(options.browser.capture).toHaveBeenCalledTimes(2);
    expect(options.execute).toHaveBeenCalledTimes(1);
  });
  it('never repeats a dispatched mutation after execution failure', async () => {
    const { options } = setup();
    options.evaluate = async (request) => answer(request);
    options.execute = rs.fn(async (plan, before) => {
      await before(plan.param);
      throw new Error('input outcome unknown');
    });
    await expect(runTreeOnly(options)).rejects.toThrow('input outcome unknown');
    expect(options.execute).toHaveBeenCalledTimes(1);
    expect(options.browser.capture).toHaveBeenCalledTimes(1);
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
