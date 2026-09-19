# Code principles

- Throw errors instead of returning blank values when something goes wrong.
- Report dump serialization format (`ScreenshotRef`, `ReportActionDump` JSON)
  does not need backward compatibility with older formats. Old report files are
  disposable and can be regenerated, so do not add legacy-format shims when
  changing the serialization schema.
- For warning logs in package code, prefer `getDebug(topic, { console: true })`
  over direct `console.warn(...)` so console output and Midscene log files stay
  aligned.
