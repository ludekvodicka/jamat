import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const environment = vi.hoisted(() => ({
  configDir: '',
  userDataDir: '',
  logError: vi.fn(),
}))

vi.mock('electron', () => ({ app: { getPath: () => environment.userDataDir } }))
vi.mock('./logger', () => ({ logError: environment.logError }))
vi.mock('./jamat-paths', () => ({
  getJamatPaths: () => ({
    configDir: environment.configDir,
    appState: join(environment.configDir, 'app-state.json'),
    snapshotsDir: join(environment.configDir, 'snapshots'),
  }),
}))

let root = ''

beforeEach(() => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'jamat-app-state-'))
  environment.configDir = join(root, 'config')
  environment.userDataDir = join(root, 'user-data')
  mkdirSync(environment.configDir, { recursive: true })
  mkdirSync(environment.userDataDir, { recursive: true })
  environment.logError.mockClear()
})

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true })
})

describe('app-state-store session descriptions', () => {
  it('coerces v1 to v2, preserves existing sections, and round-trips sparse descriptions', async () => {
    const statePath = join(environment.configDir, 'app-state.json')
    writeFileSync(statePath, JSON.stringify({
      schemaVersion: 1,
      savedAt: 10,
      windows: { main: { isNew: false } },
      groups: [{ id: 'g1', name: 'Work', createdAt: 1 }],
      layouts: { main: { grid: true } },
      notes: { Project: ['keep me'] },
      onboardingComplete: true,
    }), 'utf-8')

    const store = await import('./app-state-store')
    const loaded = store.loadAppState()
    expect(loaded.schemaVersion).toBe(2)
    expect(loaded.sessionDescriptions).toEqual({})
    expect(loaded.windows).toEqual({ main: { isNew: false } })
    expect(loaded.groups).toEqual([{ id: 'g1', name: 'Work', createdAt: 1 }])
    expect(loaded.layouts).toEqual({ main: { grid: true } })
    expect(loaded.notes).toEqual({ Project: ['keep me'] })
    expect(loaded.onboardingComplete).toBe(true)

    const sessionId = '12345678-1234-1234-1234-123456789012'
    store.setSessionDescriptionState(sessionId, 'Private description')
    store.flushAppStateNow()
    let persisted = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(persisted.schemaVersion).toBe(2)
    expect(persisted.sessionDescriptions).toEqual({ [sessionId]: 'Private description' })
    expect(persisted.notes).toEqual({ Project: ['keep me'] })

    store.setSessionDescriptionState(sessionId, '')
    store.flushAppStateNow()
    persisted = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(persisted.sessionDescriptions).toEqual({})
  })

  it('keeps only string description values when coercing state', async () => {
    writeFileSync(join(environment.configDir, 'app-state.json'), JSON.stringify({
      schemaVersion: 2,
      windows: {},
      groups: [],
      layouts: {},
      notes: {},
      sessionDescriptions: {
        '12345678-1234-1234-1234-123456789012': 'valid',
        invalid: 42,
      },
    }), 'utf-8')
    const store = await import('./app-state-store')
    expect(store.loadAppState().sessionDescriptions).toEqual({
      '12345678-1234-1234-1234-123456789012': 'valid',
    })
  })
})
