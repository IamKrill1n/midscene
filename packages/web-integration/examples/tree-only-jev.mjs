import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PlaywrightAgent } from '../dist/es/playwright/index.mjs';

// Requires TYPESAFE_API_KEY, optionally TYPESAFE_MODEL. aiAct typing also
// requires the normal MIDSCENE_MODEL_* configuration for a text model.
// Run with Node 24: node --env-file=/path/to/.env examples/tree-only-jev.mjs
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`
    <label>Name <input aria-label="Name" /></label>
    <button onclick="document.querySelector('output').textContent = 'Saved ' + document.querySelector('input').value">Save</button>
    <output></output>
  `);
  const agent = new PlaywrightAgent(page, {
    inputMode: 'tree-only',
    generateReport: false,
    replanningCycleLimit: 8,
  });
  // Fail the smoke test if any tree-only path tries to capture an image.
  agent.interface.screenshotBase64 = async () => {
    throw new Error('Unexpected screenshot in tree-only execution');
  };
  await agent.aiInput('Name field', { value: 'Bob' });
  await agent.aiTap('Save button');
  assert.equal(await page.locator('output').textContent(), 'Saved Bob');
  console.log('PASS direct input/click; verified Saved Bob');

  await page.locator('input').fill('');
  await page.locator('output').evaluate((element) => {
    element.textContent = '';
  });
  await agent.aiAct(
    'Enter Alice in the Name field, then click Save. Finish when Saved Alice is shown.',
  );
  // A Jev DONE choice does not replace an independent outcome assertion.
  assert.equal(await page.locator('output').textContent(), 'Saved Alice');
  console.log('PASS aiAct with typing helper; verified Saved Alice');

  await assert.rejects(agent.aiTap('A nonexistent Delete account button'));
  console.log('PASS absent target rejected');
} finally {
  await browser.close();
}
