import { readFile } from 'node:fs/promises';
import type { TreeOnlyRunOptions } from '@midscene/core/tree-only';
import { afterAll, beforeAll, describe, expect, it, rs } from '@rstest/core';
import { type Browser, chromium } from 'playwright';
import { WebPage } from '../../src/playwright/page';
import { PlaywrightAgent } from '../../src/playwright/page-agent';

/**
 * T4 input execution and value-verification regressions.
 *
 * The fixture mirrors V_BookingView: React-controlled native date inputs and
 * a Confirm button that stays disabled until a date lands in app state. A
 * mocked Jev pins the selection to the independently known target, so a
 * failure here isolates input execution from model selection. No paid calls.
 */

let browser: Browser;
let fixture: string;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  fixture = await readFile(
    new URL('./fixtures/tree-only-controlled-input.html', import.meta.url),
    'utf8',
  );
});
afterAll(async () => {
  await browser?.close();
});

async function treeOnlyAgentWithJevTarget(targetName: string) {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 768 });
  await page.setContent(fixture);
  const agent = new PlaywrightAgent(page, {
    inputMode: 'tree-only',
    generateReport: false,
    waitAfterAction: 0,
  });
  const run = agent.taskExecutor.runTreeOnly.bind(agent.taskExecutor);
  const evaluate = rs.fn(
    async (request: Parameters<TreeOnlyRunOptions['evaluate']>[0]) => {
      const state = JSON.parse(request.state);
      const node = state.elements.find(
        (element: { name?: string }) => element.name === targetName,
      );
      return {
        model: 'mock-jev',
        answers: request.questions.map((question) => ({
          questionId: question.id,
          kind: 'choice' as const,
          optionId:
            question.id === 'target_TYPE_TEXT'
              ? (node?.ref ?? 'no-match')
              : 'no-match',
        })),
      };
    },
  );
  rs.spyOn(agent.taskExecutor, 'runTreeOnly').mockImplementation((options) =>
    run({ ...options, evaluate }),
  );
  return { page, agent };
}

describe('web input primitive (no paid APIs)', () => {
  async function inputActionCenter(selector: string) {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.setContent(fixture);
    const box = await page.locator(selector).boundingBox();
    if (!box) {
      throw new Error(`No bounding box for ${selector}`);
    }
    const webPage = new WebPage(page);
    const inputAction = webPage
      .actionSpace()
      .find((action) => action.name === 'Input');
    if (!inputAction) {
      throw new Error('Input action is missing');
    }
    const center: [number, number] = [
      box.x + box.width / 2,
      box.y + box.height / 2,
    ];
    return { page, inputAction, center };
  }

  it('enters the requested value into a native date control', async () => {
    const { page, inputAction, center } =
      await inputActionCenter('#hourlyDate');
    try {
      await inputAction.call(
        { value: '2026-12-09', locate: { center } } as any,
        {} as any,
      );
      expect(await page.locator('#hourlyDate').inputValue()).toBe('2026-12-09');
      expect(await page.locator('#confirm').isDisabled()).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('throws when a controlled field does not retain the value', async () => {
    const { page, inputAction, center } = await inputActionCenter('#rejecting');
    try {
      await expect(
        inputAction.call(
          { value: 'kept', locate: { center } } as any,
          {} as any,
        ),
      ).rejects.toThrow(/not retained/i);
      expect(await page.locator('#rejecting').inputValue()).toBe('');
    } finally {
      await page.close();
    }
  });

  it('never echoes a rejected password value', async () => {
    const { page, inputAction, center } =
      await inputActionCenter('#rejectingSecret');
    try {
      const failure = await inputAction
        .call({ value: 's3cret-value', locate: { center } } as any, {} as any)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(String((failure as Error)?.message)).toMatch(/not retained/i);
      expect(String((failure as Error)?.message)).not.toContain('s3cret-value');
    } finally {
      await page.close();
    }
  });
});

describe('tree-only controlled input (no paid APIs)', () => {
  it('retains the requested value on a controlled date input', async () => {
    const { page, agent } = await treeOnlyAgentWithJevTarget('Date');
    try {
      await agent.aiInput('the Date field in the booking form', {
        value: '2026-12-09',
      });
      // Explicit application-response assertions, separate from execution:
      // the DOM value, the controlled app state, and the enabled button.
      expect(await page.locator('#hourlyDate').inputValue()).toBe('2026-12-09');
      expect(await page.locator('#state').getAttribute('data-hourlyDate')).toBe(
        '2026-12-09',
      );
      expect(await page.locator('#confirm').isDisabled()).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('retains the requested value on a controlled text input', async () => {
    const { page, agent } = await treeOnlyAgentWithJevTarget('Full name');
    try {
      await agent.aiInput('the Full name textbox', { value: 'Alice Nguyen' });
      expect(await page.locator('#fullName').inputValue()).toBe('Alice Nguyen');
    } finally {
      await page.close();
    }
  });

  it('exposes a value that does not stick as an input failure', async () => {
    const { page, agent } = await treeOnlyAgentWithJevTarget('Rejecting field');
    try {
      const failure = await agent
        .aiInput('the Rejecting field textbox', { value: 'kept' })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(String((failure as Error)?.message)).toMatch(/not retained/i);
      // A returned typing call is not proof of entry, and the failed entry
      // is never repeated: "kept" dispatches exactly four keystrokes once.
      expect(
        await page.locator('#rejecting').getAttribute('data-input-events'),
      ).toBe('4');
      expect(await page.locator('#rejecting').inputValue()).toBe('');
    } finally {
      await page.close();
    }
  });
});
