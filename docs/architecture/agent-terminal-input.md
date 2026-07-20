# Agent terminal input

AppJamat renders local agent sessions through xterm.js and forwards input to a node-pty process.
Modified keys are not portable across terminal applications, so the renderer adapter owns any
agent-specific PTY encoding that AppJamat synthesizes.

## Prompt newline

`Shift+Enter` inserts a newline without submitting the prompt. The xterm key handler in
`app-electron/src/renderer/hooks/useTerminal.ts` reads `promptNewlineSequences` from the current
`RendererAgent` and selects the standard or Win32-input-mode form from `term.modes.win32InputMode`:

| Agent | Standard mode | Win32 input mode | Reason |
|---|---|---|---|
| Claude Code | `ESC [ 13 ; 2 u` | `ESC [ 13 ; 2 u` | Claude Code accepts the CSI-u Shift+Enter encoding. |
| Codex | `LF` (`0x0A`) | `ESC [ 74 ; 36 ; 10 ; 1 ; 8 ; 1 _` | Codex maps `Ctrl+J` to newline. Windows Codex enables xterm's Win32 input mode, which requires an encoded `KeyJ + LeftCtrl` input record instead of a bare `LF`. |

The values live in `core/agents/<agent>/renderer-meta.ts` and are assembled by
`core/agents/renderer.ts`. This registry is safe for the Vite renderer because it imports no Node.js
filesystem modules. The local xterm enables `vtExtensions.win32InputMode`, allowing a TUI's
`DECSET 9001` request to update the public `term.modes.win32InputMode` flag and xterm's normal key
encoding.

## Synthetic prompt submission

One-click actions such as Compact, quick prompts, and live rename insert text and submit it without a
physical keyboard event. They must still use the live xterm's negotiated input mode. Bare CR is a
standard-mode Enter, but Codex in Win32 input mode interprets that direct byte as a prompt newline.

`TerminalPromptSubmitter` registers each live xterm under its panel id with a transport writer and a
live `term.modes.win32InputMode` getter. It writes the prompt text and Enter separately:

| xterm mode | Enter encoding |
|---|---|
| Standard | `CR` (`0x0D`) |
| Win32 input mode | `ESC [ 13 ; 28 ; 13 ; 1 ; 0 ; 1 _` (`VK_RETURN`, scan code `0x1C`) |

`useTerminal` supplies the local PTY writer. `RemoteViewerPanel` enables the same xterm Win32
extension and supplies its remote-stream writer, so local and remote Compact actions address their
own panel id without agent/transport branches. Cleanup is binding-identity-safe for a panel id that
is reused. Agent rename adapters return command text only; the submitter owns the terminal key.

## Lifecycle constraint

A screen-managed terminal starts in the AppJamat menu and receives its selected agent later through
`screen:update-params`. `useTerminal` therefore keeps the current `RendererAgent` in a ref. The xterm
instance and PTY must not remount when the agent changes.

## Codex submitted-message highlighting

Native Codex launches advertise `COLORTERM=truecolor` from
`core/agents/codex/launcher.ts`. Codex can then emit its own RGB background for committed user
history rows. That semantic styling distinguishes submitted prompts from the active composer and
working-status rows without AppJamat parsing the `›` glyph or terminal line wrapping.

xterm.js already renders RGB ANSI backgrounds and forwards terminal color-query replies through the
PTY. Existing Codex processes retain the capability detected at startup, so this takes effect in a
newly launched Codex tab.

## Constraints

- Plain `Enter` remains xterm's normal submit input.
- Physical `Ctrl+J` remains AppJamat's File Changes shortcut.
- No Claude Code, Codex, shell, or terminal-profile setting is changed.
- New agents must declare their prompt-newline sequence in renderer metadata and add a registry smoke
  assertion.

## Entry points

- `core/agents/renderer.ts`
- `core/agents/claude/renderer-meta.ts`
- `core/agents/codex/renderer-meta.ts`
- `core/agents/codex/launcher.ts`
- `app-electron/src/renderer/hooks/useTerminal.ts`
- `app-electron/src/renderer/utils/terminalPromptSubmitter.ts`
- `app-electron/src/renderer/components/panels/RemoteViewerPanel.tsx`
- `scripts/smoke-agents-registry.ts`
- `scripts/smoke-codex-launcher.ts`
