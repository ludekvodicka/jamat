import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenedPathsStore } from './openedPathsStore'

describe('lib-orchestrator/terminalDetector/register/openedPathsStore', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function registerFile(): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-opened-paths-'))
    created.push(root)
    return join(root, 'nested', 'terminal-opened-paths.json')
  }

  it('reads a missing file as an empty register', () => {
    expect(OpenedPathsStore.load(registerFile(), () => undefined).entries()).to.deep.equal([])
  })

  it('lands a burst of saves as the latest register', async () => {
    const file = registerFile()
    const store = OpenedPathsStore.load(file, () => undefined)
    for (let index = 1; index <= 5; index++)
      store.save(Array.from({ length: index }, (_, at) => ({ path: `E:\\f${at}.md`, kind: 'file' as const, openedAt: at })))

    await vi.waitFor(() => expect(OpenedPathsStore.load(file, () => undefined).entries()).to.have.length(5))
    expect(OpenedPathsStore.load(file, () => undefined).entries()[4])
      .to.deep.equal({ path: 'E:\\f4.md', kind: 'file', openedAt: 4 })
  })

  it('never writes over a register it could not read', async () => {
    const file = registerFile()
    const reports: string[] = []
    OpenedPathsStore.load(file, () => undefined)
      .save([{ path: 'E:\\a.md', kind: 'file', openedAt: 1 }])
    await vi.waitFor(() => expect(OpenedPathsStore.load(file, () => undefined).entries()).to.have.length(1))
    const damaged = JSON.stringify({ schemaVersion: 1, paths: [{ path: 'E:\\a.md', kind: 'symlink', openedAt: 1 }] })
    writeFileSync(file, damaged, 'utf8')

    const store = OpenedPathsStore.load(file, (message) => reports.push(message))
    expect(store.entries()).to.deep.equal([])
    store.save([{ path: 'E:\\b.md', kind: 'file', openedAt: 2 }])

    await vi.waitFor(() => expect(reports).to.have.length(1))
    expect(readFileSync(file, 'utf8')).to.equal(damaged)
  })
})
