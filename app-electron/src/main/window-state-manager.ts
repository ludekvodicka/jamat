import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { logError } from './logger'
import { getWindowsState, setWindowsState } from './app-state-store'

/** A window's last on-screen rectangle (the RESTORED bounds, i.e. un-maximized). */
export interface WindowBounds { x: number; y: number; width: number; height: number }

export interface WindowStateEntry {
  groupName?: string
  groupColor?: string
  isNew: boolean
  /** Last position+size so the window reopens exactly where it was. Absent for
   *  pre-existing state files (→ falls back to the default 1200×800, centered). */
  bounds?: WindowBounds
  /** Restore maximized if it was maximized at save time (bounds hold the
   *  un-maximized rect so un-maximizing returns to the right place). */
  isMaximized?: boolean
}

interface WindowState {
  [windowId: string]: WindowStateEntry
}

interface InstanceMarker {
  pid: number
  timestamp: number
}

function getMarkerFilePath(): string {
  const userId = process.env.USERNAME || process.env.USER || 'unknown'
  // Namespace by app name (jamat) so V1 (claude-screen) and V2 never share a
  // marker — a running V1 must not make V2 conclude it is a "subsequent instance".
  return join(tmpdir(), `${app.getName()}-${userId}.lock`)
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    // Signal 0 = an existence probe only (sends nothing). Works on Windows too — Node maps
    // it to OpenProcess and throws ESRCH when the pid is gone. Replaces a `tasklist /FI`
    // check that exited 0 even for a MISSING pid (so it ALWAYS returned "alive" → one stale
    // marker pinned every later launch to "subsequent instance").
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    // EPERM = the process exists but is protected/owned by another user → still alive.
    return e?.code === 'EPERM'
  }
}

export function isFirstInstance(): boolean {
  const markerPath = getMarkerFilePath()

  try {
    if (!existsSync(markerPath)) {
      logError('instance', 'No marker found, I am first instance')
      return true
    }

    const marker: InstanceMarker = JSON.parse(readFileSync(markerPath, 'utf-8'))
    const isAlive = isProcessAlive(marker.pid)

    if (!isAlive) {
      logError('instance', `Previous instance (PID ${marker.pid}) is dead, I am now first instance`)
      return true
    }

    logError('instance', `Another instance (PID ${marker.pid}) is alive, I am subsequent instance`)
    return false
  } catch (e: any) {
    logError('instance', `Error checking marker: ${e.message}, assuming first instance`)
    return true
  }
}

export function setAsFirstInstance(): void {
  const markerPath = getMarkerFilePath()

  try {
    const marker: InstanceMarker = {
      pid: process.pid,
      timestamp: Date.now()
    }
    writeFileSync(markerPath, JSON.stringify(marker, null, 2))
    logError('instance', `Set marker with PID ${process.pid}`)
  } catch (e: any) {
    logError('instance', `Failed to set marker: ${e.message}`)
  }
}

export function clearInstanceMarker(): void {
  const markerPath = getMarkerFilePath()

  try {
    if (existsSync(markerPath)) {
      const marker: InstanceMarker = JSON.parse(readFileSync(markerPath, 'utf-8'))
      if (marker.pid === process.pid) {
        unlinkSync(markerPath)
        logError('instance', 'Cleared instance marker')
      }
    }
  } catch (e: any) {
    logError('instance', `Failed to clear marker: ${e.message}`)
  }
}

export function saveWindowState(state: WindowState): void {
  // The windows live in the unified app-state.json (single writer = main, atomic + snapshotted).
  try {
    setWindowsState(state)
    logError('window-state', `Saved state with ${Object.keys(state).length} windows`)
  } catch (e: any) {
    logError('window-state', `Failed to save state: ${e.message}`)
  }
}

export function loadWindowState(): WindowState | null {
  // Read the windows section of app-state.json. Return null when empty so the boot path keeps its
  // old fallback (a single default window 0) instead of restoring zero windows.
  const windows = getWindowsState()
  const n = Object.keys(windows).length
  logError('window-state', `Loaded state with ${n} windows`)
  return n > 0 ? windows : null
}

export function clearWindowState(): void {
  setWindowsState({})
  logError('window-state', 'Cleared window state')
}
