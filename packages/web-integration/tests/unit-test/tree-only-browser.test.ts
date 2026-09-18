import { readFile } from 'node:fs/promises';
import { getModelRuntime } from '@midscene/core/ai-model';
import type {
  TreeOnlyPlannerDecision,
  TreeOnlyPlannerInput,
  TreeOnlyRunOptions,
} from '@midscene/core/tree-only';
import { afterAll, beforeAll, describe, expect, it, rs } from '@rstest/core';
import { type Browser, chromium } from 'playwright';
import { PlaywrightAgent } from '../../src/playwright/page-agent';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});
const html =
  '<label>Name <input aria-label="Name" /></label><button onclick="document.querySelector(\'output\').textContent = \'Saved \' + document.querySelector(\'input\').value">Save</button><output></output><div style="height:1500px"></div><button>Bottom</button>';

function mockJev(
  agent: PlaywrightAgent,
  next: (request: Parameters<TreeOnlyRunOptions['evaluate']>[0]) => {
    operation: string;
    name?: string;
  },
) {
  const run = agent.taskExecutor.runTreeOnly.bind(agent.taskExecutor);
  const evaluate = rs.fn(
    async (request: Parameters<TreeOnlyRunOptions['evaluate']>[0]) => {
      const state = JSON.parse(request.state);
      const { operation, name } = next(request);
      const node = state.elements.find(
        (node: { name: string }) => node.name === name,
      );
      return {
        model: 'mock-jev',
        answers: request.questions.map((question) => ({
          questionId: question.id,
          kind: 'choice' as const,
          optionId:
            question.id === 'operation'
              ? operation
              : question.id === `target_${operation}`
                ? (node?.ref ?? 'no-match')
                : 'no-match',
        })),
      };
    },
  );
  rs.spyOn(agent.taskExecutor, 'runTreeOnly').mockImplementation((options) =>
    run({ ...options, evaluate, typeText: async () => 'Alice' }),
  );
  return evaluate;
}

/**
 * Runs the real tree-only runtime with a fake text planner and a fake Jev
 * that answers only target questions. Resolves a planning model runtime
 * offline so no credentials or network calls are needed.
 */
function mockPlannedAiAct(
  agent: PlaywrightAgent,
  planNext: (input: TreeOnlyPlannerInput) => TreeOnlyPlannerDecision,
  targetNames: Record<string, string> = {
    target_TYPE_TEXT: 'Name',
    target_CLICK: 'Save',
  },
) {
  const run = agent.taskExecutor.runTreeOnly.bind(agent.taskExecutor);
  rs.spyOn(agent as any, 'resolveModelRuntime').mockReturnValue(
    getModelRuntime({
      modelName: 'planner',
      modelDescription: 'test',
      slot: 'planning',
      intent: 'planning',
    }),
  );
  const plannerInputs: TreeOnlyPlannerInput[] = [];
  const plan = rs.fn(async (input: TreeOnlyPlannerInput) => {
    plannerInputs.push(input);
    return planNext(input);
  });
  const jevRequests: Parameters<TreeOnlyRunOptions['evaluate']>[0][] = [];
  const evaluate = rs.fn(
    async (request: Parameters<TreeOnlyRunOptions['evaluate']>[0]) => {
      jevRequests.push(request);
      const state = JSON.parse(request.state);
      const targetName = targetNames[request.questions[0]?.id ?? ''];
      const node = state.elements.find(
        (element: { name?: string }) => element.name === targetName,
      );
      return {
        model: 'mock-jev',
        answers: request.questions.map((question) => ({
          questionId: question.id,
          kind: 'choice' as const,
          optionId: node?.ref ?? 'no-match',
        })),
      };
    },
  );
  rs.spyOn(agent.taskExecutor, 'runTreeOnly').mockImplementation((options) =>
    run({ ...options, plan, evaluate }),
  );
  return { plan, evaluate, plannerInputs, jevRequests };
}

describe('tree-only browser integration (no paid APIs)', () => {
  it('plans aiAct through tree/text evidence and Jev target selection without screenshots', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(html);
      const agent = new PlaywrightAgent(page, {
        inputMode: 'tree-only',
        generateReport: false,
        waitAfterAction: 0,
      });
      const screenshot = rs
        .spyOn(agent.interface, 'screenshotBase64')
        .mockRejectedValue(new Error('Screenshot must not be called'));
      const visualLocate = rs
        .spyOn(agent.service, 'locate')
        .mockRejectedValue(new Error('Visual locate must not be called'));
      const plans: TreeOnlyPlannerDecision[] = [
        {
          operation: 'TYPE_TEXT',
          instruction: 'the Name field',
          value: 'Alice',
        },
        { operation: 'CLICK', instruction: 'the Save button' },
        { operation: 'DONE' },
      ];
      const { evaluate, plannerInputs, jevRequests } = mockPlannedAiAct(
        agent,
        () => plans.shift()!,
      );

      await agent.aiAct('Enter Alice as Name and save');
      expect(await page.locator('output').textContent()).toBe('Saved Alice');

      // The planner chose each interaction; Jev only answered target questions.
      expect(plannerInputs.map((input) => input.instruction)).toEqual([
        'Enter Alice as Name and save',
        'Enter Alice as Name and save',
        'Enter Alice as Name and save',
      ]);
      expect(plannerInputs[0].state.page.url).toContain('about:blank');
      expect(
        plannerInputs[0].state.elements.some(
          (element) => element.name === 'Name',
        ),
      ).toBe(true);
      expect(
        plannerInputs[2].state.recent_actions.map((it) => it.operation),
      ).toEqual(['TYPE_TEXT', 'CLICK']);
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(
        jevRequests.map((request) => request.questions.map((it) => it.id)),
      ).toEqual([['target_TYPE_TEXT'], ['target_CLICK']]);
      for (const request of jevRequests) {
        expect(request.questions.some((it) => it.id === 'operation')).toBe(
          false,
        );
        expect(request.state).not.toMatch(
          /screenshot|base64|data:image|locatedPixelResult/,
        );
      }
      expect(screenshot).not.toHaveBeenCalled();
      expect(visualLocate).not.toHaveBeenCalled();
      const subTypes = agent.dump.executions
        .flatMap((execution) => execution.tasks)
        .map((task) => task.subType);
      expect(subTypes).toContain('Input');
      expect(subTypes).toContain('Tap');
    } finally {
      await page.close();
    }
  });

  it('keeps long ordered planned sequences in order across replans', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(html);
      const agent = new PlaywrightAgent(page, {
        inputMode: 'tree-only',
        generateReport: false,
        waitAfterAction: 0,
      });
      const plans: TreeOnlyPlannerDecision[] = [
        {
          operation: 'TYPE_TEXT',
          instruction: 'the Name field',
          value: 'Alice',
        },
        { operation: 'CLICK', instruction: 'the Save button' },
        { operation: 'TYPE_TEXT', instruction: 'the Name field', value: 'Bob' },
        { operation: 'CLICK', instruction: 'the Save button' },
        { operation: 'DONE' },
      ];
      const { plannerInputs } = mockPlannedAiAct(agent, () => plans.shift()!);
      await agent.aiAct('Enter Alice and save, then enter Bob and save');
      expect(await page.locator('output').textContent()).toBe('Saved Bob');
      const history = plannerInputs[4].state.recent_actions.map(
        (entry) => `${entry.operation}:${entry.value ?? entry.target ?? ''}`,
      );
      expect(history).toEqual([
        'TYPE_TEXT:Alice',
        'CLICK:Save',
        'TYPE_TEXT:Bob',
        'CLICK:Save',
      ]);
    } finally {
      await page.close();
    }
  });
  it('routes direct input/click/locate/scroll and rejects reference images before evaluation', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(html);
      const agent = new PlaywrightAgent(page, {
        inputMode: 'tree-only',
        generateReport: false,
        waitAfterAction: 0,
      });
      const evaluate = mockJev(agent, (request) =>
        request.questions[0]?.id === 'target_TYPE_TEXT'
          ? { operation: 'TYPE_TEXT', name: 'Name' }
          : request.questions[0]?.id === 'target_LOCATE'
            ? { operation: 'LOCATE', name: 'Save' }
            : { operation: 'CLICK', name: 'Save' },
      );
      await agent.aiInput('Name', { value: 'Bob' });
      await agent.aiTap('Save');
      expect(await page.locator('output').textContent()).toBe('Saved Bob');
      expect((await agent.aiLocate('Save')).center).toHaveLength(2);
      await agent.aiScroll({ direction: 'down', distance: 500 });
      expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
      const calls = evaluate.mock.calls.length;
      await expect(
        agent.aiAct({
          prompt: 'Click',
          images: [{ name: 'missing', url: '/does-not-exist.png' }],
        }),
      ).rejects.toThrow('reference images');
      expect(evaluate).toHaveBeenCalledTimes(calls);
    } finally {
      await page.close();
    }
  });
  it('rejects replaced nodes and obstructed targets using the original DOM identity', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(html);
      const agent = new PlaywrightAgent(page, {
        inputMode: 'tree-only',
        generateReport: false,
      });
      const capture = await agent.interface.treeOnly.capture();
      const ref = capture.snapshot.nodes.find(
        (node) => node.name === 'Save',
      )!.ref;
      await page
        .locator('button')
        .first()
        .evaluate((element) => {
          element.replaceWith(element.cloneNode(true));
        });
      await expect(capture.validate(ref, 'CLICK')).rejects.toThrow('stale');
      await capture.release();
      const fresh = await agent.interface.treeOnly.capture();
      const freshRef = fresh.snapshot.nodes.find(
        (node) => node.name === 'Save',
      )!.ref;
      await page.evaluate(() => {
        const overlay = document.createElement('div');
        overlay.style.cssText =
          'position:fixed;inset:0;z-index:999;background:white';
        document.body.append(overlay);
      });
      await expect(fresh.validate(freshRef, 'CLICK')).rejects.toThrow(
        'obstructed',
      );
      await fresh.release();
    } finally {
      await page.close();
    }
  });

  it('reports the live target meaning at validation time', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(html);
      const agent = new PlaywrightAgent(page, {
        inputMode: 'tree-only',
        generateReport: false,
      });
      const capture = await agent.interface.treeOnly.capture();
      const ref = capture.snapshot.nodes.find(
        (node) => node.name === 'Save',
      )!.ref;
      await page
        .locator('button')
        .first()
        .evaluate((element) => {
          element.textContent = 'Delete';
        });
      const validated = await capture.validate(ref, 'CLICK');
      expect(validated.observation).toMatchObject({
        role: 'button',
        name: 'Delete',
      });
      expect(validated.element.center).toHaveLength(2);
      await capture.release();
    } finally {
      await page.close();
    }
  });

  it('refuses to execute after the selected target changed meaning', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(html);
      const agent = new PlaywrightAgent(page, {
        inputMode: 'tree-only',
        generateReport: false,
        waitAfterAction: 0,
      });
      const run = agent.taskExecutor.runTreeOnly.bind(agent.taskExecutor);
      let calls = 0;
      rs.spyOn(agent.taskExecutor, 'runTreeOnly').mockImplementation(
        (options) =>
          run({
            ...options,
            evaluate: async (request) => {
              calls += 1;
              if (calls === 1) {
                await page.evaluate(() => {
                  document.querySelector('button')!.textContent = 'Delete';
                });
              }
              const state = JSON.parse(request.state);
              const node = state.elements.find(
                (element: { name?: string }) => element.name === 'Save',
              );
              return {
                model: 'mock-jev',
                answers: request.questions.map((question) => ({
                  questionId: question.id,
                  kind: 'choice' as const,
                  optionId:
                    question.id === 'target_CLICK'
                      ? (node?.ref ?? 'no-match')
                      : 'no-match',
                })),
              };
            },
          }),
      );
      await expect(agent.aiTap('Save')).rejects.toThrow();
      expect(await page.locator('output').textContent()).toBe('');
    } finally {
      await page.close();
    }
  });

  it('captures the fixed observation fixture with distinguishable targets', async () => {
    const page = await browser.newPage();
    try {
      const fixture = await readFile(
        new URL('./fixtures/tree-only-observation.html', import.meta.url),
        'utf8',
      );
      await page.setViewportSize({ width: 1280, height: 768 });
      await page.setContent(fixture);
      const agent = new PlaywrightAgent(page, {
        inputMode: 'tree-only',
        generateReport: false,
        waitAfterAction: 0,
      });
      const screenshot = rs
        .spyOn(agent.interface, 'screenshotBase64')
        .mockRejectedValue(new Error('Screenshot must not be called'));
      const states: Array<Record<string, any>> = [];
      const evaluate = mockJev(agent, (request) => {
        states.push(JSON.parse(request.state));
        return { operation: 'CLICK', name: 'WiFi' };
      });

      await agent.aiTap('the WiFi amenity checkbox');
      expect(await page.locator('#WiFi').getAttribute('aria-checked')).toBe(
        'true',
      );

      const state = states[0];
      const byName = (name: string) =>
        state.elements.find((node: { name?: string }) => node.name === name);
      expect(byName('Login')).toMatchObject({
        role: 'link',
        supported_operations: ['CLICK'],
      });
      expect(byName('Search homestays...')).toMatchObject({
        role: 'searchbox',
        supported_operations: ['CLICK', 'TYPE_TEXT'],
      });
      expect(byName('WiFi')).toMatchObject({
        role: 'checkbox',
        state: { checked: false },
        supported_operations: ['CLICK'],
      });
      const viewDetails = state.elements.filter(
        (node: { name?: string }) => node.name === 'View Details',
      );
      expect(viewDetails).toHaveLength(1);
      expect(viewDetails[0].role).toBe('link');
      const fileInput = state.elements.find(
        (node: { state?: { inputType?: string } }) =>
          node.state?.inputType === 'file',
      );
      expect(fileInput?.supported_operations ?? []).not.toContain('TYPE_TEXT');
      expect(state.page.scroll.height).toBeGreaterThan(768);
      expect(screenshot).not.toHaveBeenCalled();
      expect(evaluate).toHaveBeenCalledTimes(1);
    } finally {
      await page.close();
    }
  });
});
