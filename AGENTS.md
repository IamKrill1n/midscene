# AGENTS.md

Midscene.js is an AI-powered GUI agent for E2E testing across web, mobile, and desktop.

- Use `pnpm` only for installs/scripts. Requires Node
  `^20.19.0 || ^22.12.0 || >=24.0.0` and pnpm `>=9.3.0`.
- Before local dev, read `CONTRIBUTING.md`. Before commit/PR, run
  `pnpm run lint` from the repository root.
- For code changes, run the smallest relevant Nx target
  (`npx nx test <project>` / `npx nx build <project>`).
  `npx` for Nx execution is allowed.
- `CLAUDE.md` points here; do not duplicate rules.

## Details (load on demand)

- [Code principles](agents/code-principles.md) — errors, report dumps, logging
- [Testing and validation](agents/testing-validation.md) — test tiers, AI env, builds
- [Git, commits, and PRs](agents/git-commits.md) — scopes, no force push, PR summaries
- [Docs and i18n](agents/docs-i18n.md) — bilingual rules, terminology, model upgrades
