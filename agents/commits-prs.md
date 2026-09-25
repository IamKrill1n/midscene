# Commits & PRs

- Follow Conventional Commits with a required scope (`scope-empty: never` enforced in `commitlint.config.js`).
- Scope source of truth is `commitlint.config.js`: auto-discovers directory names under `apps/` and `packages/`, plus shared scopes (`workflow`, `llm`, `playwright`, `puppeteer`, `blog`, `bridge`, `recorder`). Note `scope-enum` is currently disabled (level 0), so the list is advisory.
- Mismatches to memorize:
  - Use `web-integration` as the scope for `packages/web-integration`, even though the published package is `@midscene/web`.
  - Use `site` as the scope for `apps/site`, even though the Nx project name is `doc`.
- NEVER force push unless explicitly told to do so.
- In PR summaries, list the actual validation commands you ran.
