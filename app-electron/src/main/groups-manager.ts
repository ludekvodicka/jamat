import { getGroupsState, setGroupsState, deleteLayoutState } from './app-state-store'

export interface WindowGroup {
  id: string
  name: string
  color?: string
  createdAt: string
  /** Set when this group was created by NAMING an already-open (unnamed) window: the window's
   *  stable numeric id, so it keeps its layout + live PTYs. Absent for "born named" windows,
   *  whose own id IS the group id. `getGroupForWindow` treats `windowId ?? id` as the owner. */
  windowId?: string
}

// Groups live in the unified app-state.json (single writer = main, atomic + snapshotted).
function loadGroups(): WindowGroup[] {
  return getGroupsState()
}

function saveGroups(groups: WindowGroup[]): void {
  setGroupsState(groups)
}

export function getGroups(): WindowGroup[] {
  return loadGroups()
}

export function createGroup(name: string, windowId?: string): WindowGroup {
  const groups = loadGroups()
  const group: WindowGroup = {
    id: `group-${Date.now()}`,
    name,
    createdAt: new Date().toISOString(),
    ...(windowId ? { windowId } : {})
  }
  groups.push(group)
  saveGroups(groups)
  return group
}

/**
 * The group that owns a window — born-named (group id === windowId) or an unnamed window that
 * was later named (group.windowId === windowId). Null when the window is unnamed. Single source
 * of truth for "is this window named", replacing the old `id.startsWith('group-')` check.
 */
export function getGroupForWindow(windowId: string): WindowGroup | null {
  return loadGroups().find(g => (g.windowId ?? g.id) === windowId) ?? null
}

export function deleteGroup(id: string): void {
  const groups = loadGroups().filter(g => g.id !== id)
  saveGroups(groups)
  // Drop the group window's tab layout too (was `layouts/layout-<id>.json`).
  deleteLayoutState(id)
}

export function renameGroup(id: string, newName: string): void {
  const groups = loadGroups()
  const group = groups.find(g => g.id === id)
  if (group) {
    group.name = newName
    saveGroups(groups)
  }
}

export function setGroupColor(id: string, color: string): void {
  const groups = loadGroups()
  const group = groups.find(g => g.id === id)
  if (group) {
    group.color = color || undefined
    saveGroups(groups)
  }
}

