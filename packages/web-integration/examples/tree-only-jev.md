# Tree-only Jev (Playwright/Chromium)

Set `inputMode: 'tree-only'` on `PlaywrightAgent` or on a supported call. Visual mode remains the default. Jev chooses actions and observed targets from JSON containing the page, semantic elements and recent actions. No screenshots or reference images are sent to either model.

```js
const agent = new PlaywrightAgent(page, { inputMode: 'tree-only' });
await agent.aiInput('Name field', { value: 'Alice' });
await agent.aiTap('Save');
await agent.aiAct('Enter Bob in Name, then save');
```

Configure `TYPESAFE_API_KEY` and optionally `TYPESAFE_MODEL` for Jev. Existing model selection is preserved. For `aiAct` typing, configure the normal `MIDSCENE_MODEL_NAME`, `MIDSCENE_MODEL_BASE_URL`, and `MIDSCENE_MODEL_API_KEY` for a text-capable model. The helper only generates `{text: string}` after Jev selects a field; direct `aiInput` uses its supplied value. Click/locate/scroll do not require a text model. Credentials remain in the Node process.

Supported: `aiAct` with click, type, page scroll up/down, brief wait, done and blocked; direct `aiLocate`, `aiTap`, `aiInput`, and page-level single up/down `aiScroll`. Per-call mode overrides do not change agent defaults. General query/assert/wait APIs, uploads, select actions, visual hints and non-Playwright platforms fail explicitly. Text/visual model fallback is not performed.

The loop defaults to 20 decisions (`replanningCycleLimit` overrides it), with a two-minute deadline and at most two shared recovery attempts. Repeated identical decisions stop for lack of progress. Failed or uncertain mutations are not automatically repeated. Selected targets retain their original DOM identity and are checked again immediately before input. Validation checks current visibility, enabled state and ownership of the click point; it does not claim an area-exposure guarantee. Frames and other inaccessible elements can remain unsupported; missing evidence is not proof of absence. Candidate overflow or a truncated capture fails instead of silently dropping candidates. Jev decisions are not replayed from persistent cache.

`DONE` ends planning, not independent verification. Check the resulting page with Playwright assertions. Existing native task records remain available; no XLSX or extra reporting pipeline is needed.

After building `@midscene/web`, run the small live example from this package:

```sh
node --env-file=/absolute/path/to/.env examples/tree-only-jev.mjs
```

The example uses paid model calls, checks direct input/click and multistep typing, and verifies the final DOM state. Automated `tree-only-*` unit/browser tests use mocked model responses and make no paid calls.
