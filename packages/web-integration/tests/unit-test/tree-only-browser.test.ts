import type { TreeOnlyRunOptions } from '@midscene/core/tree-only';
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

describe('tree-only browser integration (no paid APIs)', () => {
  it('runs public aiAct through native Input/Tap tasks without screenshots and verifies the DOM outcome', async () => {
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
      let turn = 0;
      const evaluate = mockJev(agent, () =>
        ++turn === 1
          ? { operation: 'TYPE_TEXT', name: 'Name' }
          : turn === 2
            ? { operation: 'CLICK', name: 'Save' }
            : { operation: 'DONE' },
      );
      await agent.aiAct('Enter Alice as Name and save');
      expect(await page.locator('output').textContent()).toBe('Saved Alice');
      expect(evaluate).toHaveBeenCalledTimes(3);
      expect(screenshot).not.toHaveBeenCalled();
      expect(
        agent.dump.executions
          .flatMap((e) => e.tasks)
          .some((task) => task.subType === 'Input'),
      ).toBe(true);
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
});
