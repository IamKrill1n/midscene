# Git, commits, and PRs

- NEVER force push anything unless you are explicitly told to do so.
- Commits must follow Conventional Commits with a required scope.
- Scope values come from directory names under `apps/` and `packages/`, plus
  shared scopes in `commitlint.config.js` such as `workflow`, `llm`,
  `playwright`, `puppeteer`, `bridge`, `blog`, and `recorder`.
- Important mismatch: use `web-integration` as the commit scope for changes
  under `packages/web-integration`, even though the published package name is
  `@midscene/web`.
- Important mismatch: use `site` as the commit scope for `apps/site`, even
  though the Nx project name is `doc`.
- In PR summaries, list the actual validation commands you ran.
