# Docs & i18n

- Treat user-facing docs as bilingual by default.
- If you edit `README.md`, update `README.zh.md` in the same change.
- If you edit `apps/site/docs/en/**`, inspect and update the corresponding file under `apps/site/docs/zh/**`. Do the same in the opposite direction.
- The English and Chinese trees are not perfectly mirrored. If the counterpart file does not exist, decide whether to add it or call out the intentional gap in your final summary.
- Before editing site copy, read `apps/site/agents.md` for terminology and style rules (keeps `API Key` and `Agent` untranslated in Chinese where appropriate, `:::info` usage, Device lifecycle, no-marketing tone).
- Upgrading recommended models: `apps/site/docs/{en,zh}/model-strategy.mdx` and `apps/site/docs/{en,zh}/model-common-config.mdx` are the source of truth. Update the strategy/config docs first, then propagate to `README.md`, `README.zh.md`, `apps/site/docs/en/introduction.mdx`, and `apps/site/docs/zh/introduction.mdx` (Driven by Visual Language Model section). Keep all spots in sync. Leave historical references in `changelog.mdx` alone, and keep illustrative "newer beats older" comparisons in `faq.md` intact.
