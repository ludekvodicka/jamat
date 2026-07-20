# Session descriptions

## Decision

AppJamat owns one optional multiline description per agent session. The description is private
application metadata: it is never added to a Claude Code transcript, Codex rollout/name index,
terminal prompt, native `/rename` command, or automatic agent context.

F2 opens **Session details** with two independent values:

- **Name** keeps the provider-native rename path and the live TUI synchronization.
- **Description (AppJamat only)** reads and writes AppJamat's own state.

A description-only save therefore produces no PTY input, native session write, or tab-title change.

## Identity and persistence

Descriptions live in the main-owned `<config-dir>/app-state.json` schema v2:

```jsonc
{
  "schemaVersion": 2,
  "sessionDescriptions": {
    "<session UUID>": "What this session is doing"
  }
}
```

The exact UUID is the key. It survives panel/window recreation and project moves, while a Dockview
panel id does not. It also keeps simultaneous sessions in one project separate, unlike the existing
project-level Notes sidebar.

The map is sparse. Saving blank text deletes an entry. AppJamat does not prune entries merely because
a session is absent from discovery: a transient/moved session must not destroy a user's note. A fork
or new session has a new UUID and starts without its parent's description.

Version-1 app state is normalized in memory to version 2 with an empty description map. The next
normal atomic write persists it; the existing loaded-good launch snapshot preserves the previous
file. The description consequently inherits app-state's single main writer, debounced atomic writes,
rotating snapshots, recovery, and portable config-dir behavior.

## Data flow

`SessionDescriptionManager` validates the canonical UUID, plain-string input, and 4,000-character
limit. It trims outer whitespace, preserves internal newlines, and delegates to narrow app-state
accessors.

The typed local operations are:

- `session-description:load(sessionId)`
- `session-description:save(sessionId, description)`

The save operation is classified `rw` by the typed op bridge. These channels retain normal local
UI/AI reach and are not exposed as Remote Viewer network operations.

`CustomTab` loads fresh state whenever Session details opens. Async responses are tied to the active
dialog request so a response arriving after close/session replacement is ignored. Save compares Name
and Description independently:

- Name only uses the existing adapter/native rename flow.
- Description only uses `session-description:save`.
- Both rename first, then save the local description. If the second step fails, the successful name
  becomes the new form baseline so retry cannot submit `/rename` twice.

## Unresolved sessions

A brand-new terminal has no UUID until `screen-executor.ts` discovers the provider's new session and
publishes it through `screen:update-params`. Name editing remains available immediately through the
provider's live `/rename` command. Description is disabled until that authoritative UUID arrives,
then it loads automatically if the dialog is still open.

AppJamat deliberately does not stage the description under a panel id or fall back to the project's
latest session. Either could attach private text to a neighbouring session.

## Scope and entry points

The first surface is F2/context-menu Session details on local agent tabs. Descriptions are not shown
in tab titles/tooltips, session search/list results, Remote Viewer, or agent prompts.

- `app-electron/src/main/app-state-store.ts`
- `app-electron/src/main/sessionDescriptionManager.ts`
- `app-electron/src/main/ipc-sessions.ts`
- `core/types/ipc-contracts.ts`
- `app-electron/src/preload/index.ts`
- `app-electron/src/shared/typed-ipc.ts`
- `app-electron/src/renderer/components/layout/CustomTab.tsx`
- `app-electron/src/renderer/components/layout/TabContextMenu.tsx`
