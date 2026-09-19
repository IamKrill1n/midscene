# AndroidWorld stability patches and validator updates

This note maps the two change tables from the official
[AndroidWorld benchmark report](https://midscenejs.com/android-world-benchmark-report.html)
to the AndroidWorld checkout used by `androidworld_bridge.py`. Apply these to
a pinned AndroidWorld commit and record the commit hash in the run evidence.
Unpinned or unrecorded validator edits silently move the goalposts, so the
guide treats the patch list as part of the run configuration.

## Stability improvements (no task-intent change)

| Change | Affected cases | Where to patch (upstream layout) |
| --- | --- | --- |
| Force canvas pixels to flush after drawing, then use thicker rounded strokes so target colors stay stable in the final canvas pixels. | `BrowserDraw` | `android_world/task_evals/single/browser.py` (draw setup) |
| Retry reading the `Success!` text from the accessibility tree after browser tasks finish. | `BrowserMaze`, `BrowserMultiply`, `BrowserDraw` | `android_world/task_evals/single/browser.py` (validators) |
| Before SMS tasks start, verify the prepared incoming messages are visible in the inbox and the contacts are visible in Contacts before the agent runs. | `SimpleSmsReplyMostRecent`, `SimpleSmsSendReceivedAddress` | SMS task setup under `android_world/task_evals/` |
| Wait for Pro Expense to create its database tables before validators write test data. | `ExpenseAddMultiple`, `ExpenseAddMultipleFromGallery`, `ExpenseAddMultipleFromMarkor`, `ExpenseAddSingle`, `ExpenseDeleteDuplicates`, `ExpenseDeleteDuplicates2`, `ExpenseDeleteMultiple`, `ExpenseDeleteMultiple2`, `ExpenseDeleteSingle` | `android_world/task_evals/single/expense.py` (setup) |
| Preload OsmAnd offline map files into the app data directory and wait for OsmAnd to extract its built-in basemap before map tasks run. | `OsmAndFavorite`, `OsmAndMarker`, `OsmAndTrack` | OsmAnd task setup under `android_world/task_evals/` |

## Validation condition updates

| Change | Affected cases |
| --- | --- |
| Calendar "after start time" validates against an event one minute after the boundary. | `SimpleCalendarFirstEventAfterStartTime` |
| Expense notes imported from Markor ignore the extra `Reimbursable.` suffix and terminal period differences. | `ExpenseAddMultipleFromMarkor` |
| Markor merged notes accept single-newline or blank-line separation, and Markor's default `.md` extension. | `MarkorMergeNotes` |
| Recipe quantity fields allow omitted units while still rejecting wrong amounts or incompatible units. | `RecipeAddSingleRecipe`, `RecipeAddMultipleRecipes`, `RecipeAddMultipleRecipesFromMarkor`, `RecipeAddMultipleRecipesFromMarkor2`, `RecipeAddMultipleRecipesFromImage`, `NotesRecipeIngredientCount` |
| Minimum brightness validates against Android's actual minimum, `0`, instead of `1`. | `SystemBrightnessMin`, `SystemBrightnessMinVerify` |

## How to record the patch state

1. Pin the checkout: `git -C <android_world> rev-parse HEAD`.
2. Keep each table row as a separate, reviewable diff hunk.
3. Store the commit hash plus the applied-hunk list next to `summary.json`
   in the run output directory.
