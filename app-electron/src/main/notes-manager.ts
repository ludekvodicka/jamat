import { getNotesState, setNotesState } from './app-state-store'

/**
 * Per-project notes. Stored as the `notes[<sanitizedPanelId>]` section of the unified app-state.json
 * (single writer = main, atomic + snapshotted). The async signatures are kept so the IPC call sites
 * (`notes:load` / `notes:save`) don't change; the read/write is now an in-memory store access.
 */

function sanitizeId(panelId: string): string {
  return panelId.replace(/[:\\\/]/g, '_').replace(/\.\./g, '')
}

function validatePanelId(panelId: string): boolean {
  return panelId.length > 0 && panelId.length < 200
}

export async function loadNotes(panelId: string): Promise<string[]> {
  if (!validatePanelId(panelId)) return ['']
  return getNotesState(sanitizeId(panelId)) ?? ['']
}

export async function saveNotes(panelId: string, entries: string[]): Promise<void> {
  if (!validatePanelId(panelId)) return
  setNotesState(sanitizeId(panelId), entries)
}
