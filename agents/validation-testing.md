# Validation & testing

- Never default to full monorepo validation. Run the smallest Nx target per touched project via `pnpm exec nx`.
- Matrix:
  - Docs-only: `pnpm run lint` is usually enough.
  - Single-package code change: `pnpm run lint` plus `pnpm exec nx test <project>`; add `pnpm exec nx build <project>` if exports or build wiring changed.
  - Cross-package runtime or build-system change: `pnpm run lint`, and say explicitly if broader validation is still outstanding.
- Shared packages or exported entry points: run a focused build for the affected project before finishing.
- Do not hand-edit generated output under `dist/` or `apps/site/doc_build/`.
- Tests: start with the nearest unit suite in `<PACKAGE_DIR>/tests` (Vitest). Use AI tests or e2e only when the change depends on model behavior or browser/device integration. AI env setup lives in `CONTRIBUTING.md` (Testing section, `.env` file).
- `apps/report/e2e` is dogfooding Midscene's AI capabilities. Do not replace core `aiAssert`, `aiTap`, `aiHover`, or similar coverage with raw DOM-only `javascript` checks unless the test is explicitly meant to validate DOM plumbing. For `apps/report/e2e/report-single.yaml`, keep report loading assertions on `aiAssert`; if flaky, improve the prompt, timing, or fixture while preserving `aiAssert` coverage.
