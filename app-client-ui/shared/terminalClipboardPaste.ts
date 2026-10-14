/**
 * What one paste into a terminal turned out to be, decided in the main process that reads the
 * clipboard. An image or a file never reaches the renderer: it is saved on, or sent to, the computer
 * the agent runs on, and what comes back is the text that pastes its path there.
 */
export type TerminalClipboardPaste =
  | { kind: 'text'; text: string }
  | { kind: 'empty' }
