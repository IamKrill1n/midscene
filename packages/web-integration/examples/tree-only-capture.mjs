import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PlaywrightAgent } from '../dist/es/playwright/index.mjs';

// Repeatable capture harness for one fixed interaction (T02).
//
// Usage:
//   MIDSCENE_TREE_ONLY_JEVD_DUMP_DIR=<outDir> \
//   node --env-file=/path/to/.env examples/tree-only-capture.mjs \
//     --url http://localhost:8080/ \
//     --instruction "the Login link in the header navigation" \
//     --role link --name Login
//
// Writes:
//   - Jev request/response/error JSON records (transport hook, same dir)
//   - independent-observation.json: intended-target facts taken from
//     Playwright locators, plus the tree-only outcome.
// Requires TYPESAFE_API_KEY; no screenshots are captured or sent.

function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for --${name}`);
  }
  return value;
}

const outDir = process.env.MIDSCENE_TREE_ONLY_JEVD_DUMP_DIR;
if (!outDir) {
  throw new Error(
    'MIDSCENE_TREE_ONLY_JEVD_DUMP_DIR must point at the capture directory',
  );
}
const url = readArg('url', 'http://localhost:8080/');
const instruction = readArg('instruction');
if (!instruction) {
  throw new Error('--instruction is required');
}
const role = readArg('role');
const name = readArg('name');

const startedAt = new Date().toISOString();
const record = {
  startedAt,
  url,
  instruction,
  intendedTarget: role && name ? { role, name } : undefined,
  model: {
    jev: process.env.TYPESAFE_MODEL ?? 'pinned-default',
    text: process.env.MIDSCENE_MODEL_NAME ?? undefined,
  },
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 768 });
  await page.goto(url);

  if (role && name) {
    const locator = page.getByRole(role, { name, exact: true });
    const count = await locator.count();
    record.intendedTarget = {
      role,
      name,
      locatorCount: count,
      visible: count > 0 ? await locator.first().isVisible() : false,
      box: count > 0 ? await locator.first().boundingBox() : null,
    };
  }

  const agent = new PlaywrightAgent(page, {
    inputMode: 'tree-only',
    generateReport: false,
    replanningCycleLimit: 4,
  });
  agent.interface.screenshotBase64 = async () => {
    throw new Error('Unexpected screenshot in tree-only capture');
  };

  try {
    await agent.aiTap(instruction);
    record.outcome = { status: 'performed' };
  } catch (error) {
    record.outcome = {
      status: 'error',
      name: error?.name,
      message: error?.message,
      category: error?.category,
    };
  }

  record.finalUrl = page.url();
  record.recordedAt = new Date().toISOString();
  await writeFile(
    join(outDir, 'independent-observation.json'),
    JSON.stringify(record, null, 2),
    'utf8',
  );
  console.log(JSON.stringify(record, null, 2));
} finally {
  await browser.close();
}
