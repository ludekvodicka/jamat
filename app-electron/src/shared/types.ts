// Re-export canonical types from core
export type { MenuSelection, AppConfig, SessionDonePrompt, UsageCache } from '../../../core/types.js'

// PTY spawn config is canonical in the IPC contract (`TerminalConfig`).
// Re-exported here under the historical `PtyConfig` name so existing
// imports keep working without a second source of truth.
export type { TerminalConfig as PtyConfig } from '../../../core/types/ipc-contracts.js'
