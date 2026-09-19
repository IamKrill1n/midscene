# Testing and validation

## Test strategy

- Add or update tests when behavior changes. Start with the nearest unit test
  suite; use AI tests or e2e only when the change actually depends on model
  behavior or browser/device integration.
- AI tests require model env vars such as `MIDSCENE_MODEL_BASE_URL` to be set.
  See `CONTRIBUTING.md` for the full list.

## Report e2e dogfooding

- Report app e2e tests under `apps/report/e2e` are also dogfooding Midscene's
  AI capabilities. Do not stabilize them by replacing core `aiAssert`,
  `aiTap`, `aiHover`, or similar coverage with raw DOM-only `javascript`
  checks unless the test is explicitly meant to validate DOM plumbing.
- For `apps/report/e2e/report-single.yaml`, keep the report loading assertions
  on `aiAssert`; if they are flaky, improve the prompt, timing, or fixture
  while preserving `aiAssert` coverage.

## Builds and generated output

- Do not hand-edit generated output under `dist/` or `apps/site/doc_build/`.
- When changing shared packages or exported entry points, run a focused build
  for the affected project before finishing. This is required, not optional.

## Validation tiers

- Docs-only change: usually `pnpm run lint` is enough.
- Single-package code change: run `pnpm run lint` plus the smallest relevant
  `npx nx test <project>` and, if exports/build wiring changed,
  `npx nx build <project>`.
- Cross-package runtime or build-system change: run `pnpm run lint` plus the
  focused `npx nx build` for affected projects. If broader validation is still
  outstanding, say so explicitly in your summary.

Note: `pnpm`-only applies to package management. `npx nx ...` for Nx
execution is allowed and kept verbatim here.
