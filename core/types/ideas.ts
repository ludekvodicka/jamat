/**
 * Idea shape for the global Ideas panel. Per-window storage (each
 * named window persists its own list); see `IpcInvokeMap['ideas:load']`
 * in `core/types/ipc-contracts.ts`.
 */

export interface Idea {
  /** Stable id (`crypto.randomUUID()` at create time). */
  id: string
  title: string
  /** Optional free-text body. Empty string when missing. */
  body: string
  /** Free-text category — user-defined. Empty string means uncategorized. */
  category: string
  /** 1 (low) .. 5 (critical). Default 3 on new ideas. */
  importance: 1 | 2 | 3 | 4 | 5
  /** ISO yyyy-mm-dd; empty string when no deadline. */
  dueDate: string
  /** ISO timestamp. */
  createdAt: string
  /** ISO timestamp. */
  updatedAt: string
}
