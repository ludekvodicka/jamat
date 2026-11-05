---
title: Interactive checklist - test guide
status: example
jamat: interactive
---

# Interactive checklist - test guide

Open this local file in Jamat's Rendered view from a live Claude or Codex session. Confirm a check
only after observing its result. An unchecked item can mean failed or not tried.

:::warning[This example saves your ticks]
Checkbox clicks update this file immediately. After trying the example, clear its ticks to restore
the example. Ask and Insert to terminal prepare text in your agent prompt without sending it;
Send results sends its summary to the agent.
:::

## Save a check

Tick the first item, then reopen this file in Rendered view.

- [ ] The first item stays checked after reopening the file.
- [ ] The Checklist strip shows the number of checked items out of the total.

## Ask about an item

Click the `?` button beside the next item. Inspect the draft in the owning session's terminal.
Leave the draft unsent and clear it before trying another prompt action.

- [ ] The question draft names this file, the item's line, this heading and the item text.
- [ ] The agent receives no message until I press Enter.

## Ask about selected text

Select this sentence in Rendered view and choose Ask from its context menu. Inspect and clear the
unsent draft.

- [ ] The draft quotes the selected text with its file, line and heading.

## Prepare results

Leave at least one item unchecked. Open the arrow beside Send results above the document and choose
Insert to terminal. Inspect and clear the unsent draft.

- [ ] The results draft groups unconfirmed items by heading.
- [ ] The terminal has the keyboard, so typing continues the draft.
