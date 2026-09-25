# Design principles

- Throw errors instead of returning blank values on failure.
- Report dump (`ScreenshotRef`, `ReportActionDump` JSON) has no backward compatibility. Old report files are disposable and can be regenerated, so do not add legacy-format shims when changing the serialization schema.
- Warning logs in `packages/*`: prefer `getDebug(topic, { console: true })` over `console.warn(...)` so console output and Midscene log files stay aligned.
