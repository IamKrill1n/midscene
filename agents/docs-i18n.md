# Docs and i18n

- Treat user-facing docs as bilingual by default.
- If you edit `README.md`, update `README.zh.md` in the same change.
- If you edit `apps/site/docs/en/**`, inspect and update the corresponding
  file under `apps/site/docs/zh/**`. Do the same in the opposite direction.
- The English and Chinese trees are not perfectly mirrored. If the counterpart
  file does not exist, decide whether to add it or call out the intentional
  gap in your final summary.
- Before editing site copy, read `apps/site/agents.md` for terminology rules.
  It already documents translation constraints such as keeping `API Key` and
  `Agent` untranslated in Chinese where appropriate.

## Upgrading recommended models

`apps/site/docs/{en,zh}/model-strategy.mdx` and
`apps/site/docs/{en,zh}/model-common-config.mdx` are the source of truth for
which models we recommend and the exact model/family strings. When the
recommended models or their versions change (e.g. `qwen3-vl` → `qwen3.x`,
`gemini-3-flash` → `gemini-3.5-flash`), update the strategy/config docs first,
then propagate the new model names to every place that markets the supported
model list:

- `README.md` and `README.zh.md` (the "Driven by Visual Language Model"
  section).
- `apps/site/docs/en/introduction.mdx` and
  `apps/site/docs/zh/introduction.mdx` (same section).

Keep all four spots in sync and consistent with the strategy/config docs.
Leave historical references in `changelog.mdx` alone, and keep illustrative
"newer beats older" comparisons in `faq.md` intact. Remember README and
introduction are bilingual: update the en/zh counterparts in the same change.
