import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SetupTrustStore } from './setupTrust'

describe('lib-orchestrator/projectSetup/setupTrust', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function trustFile(): string {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-setup-trust-'))
    created.push(directory)
    return join(directory, 'setup-trust.json')
  }

  const projectRoot = join('Q:', 'apps', 'one')

  it('knows nothing before anything is acknowledged', () => {
    expect(SetupTrustStore.load(trustFile(), () => undefined).acknowledgedHashOf(projectRoot))
      .toBe(null)
  })

  it('answers the hash it was given, and only for the project it was given for', () => {
    const store = SetupTrustStore.load(trustFile(), () => undefined)
    store.acknowledge(projectRoot, 'hash-1')

    expect(store.acknowledgedHashOf(projectRoot)).toBe('hash-1')
    expect(store.acknowledgedHashOf(join('Q:', 'apps', 'two'))).toBe(null)
  })

  /* One project is one project however its path is spelled: `PathCompare` is what decides that, and
     the store leans on it so a create from a differently-cased path is not asked all over again. */
  it('reads the same project through a differently spelled path', () => {
    const store = SetupTrustStore.load(trustFile(), () => undefined)
    store.acknowledge(join('Q:', 'apps', 'one'), 'hash-1')

    expect(store.acknowledgedHashOf(join('Q:', 'apps', 'one', 'two', '..'))).toBe('hash-1')
  })

  it('keeps what another store wrote instead of overwriting it with a stale picture', () => {
    const file = trustFile()
    const first = SetupTrustStore.load(file, () => undefined)
    first.acknowledge(projectRoot, 'hash-1')

    const second = SetupTrustStore.load(file, () => undefined)
    second.acknowledge(join('Q:', 'apps', 'two'), 'hash-2')

    const reloaded = SetupTrustStore.load(file, () => undefined)
    expect(reloaded.acknowledgedHashOf(projectRoot)).toBe('hash-1')
    expect(reloaded.acknowledgedHashOf(join('Q:', 'apps', 'two'))).toBe('hash-2')
  })

  /* Forgetting an agreement costs one question; inventing one runs somebody else's shell, so damage
     is read as "nothing is acknowledged" and reported. The second half of that rule - never repaired
     into a guess, which is a statement about the FILE - is asserted in the latch block below. */
  it('forgets everything a damaged file said, and says so', () => {
    const file = trustFile()
    writeFileSync(file, '{ "projects": ', 'utf8')
    const reports: string[] = []

    const store = SetupTrustStore.load(file, (message) => reports.push(message))

    expect(store.acknowledgedHashOf(projectRoot)).toBe(null)
    expect(reports).toHaveLength(1)
  })

  it('ignores entries of a shape it does not understand', () => {
    const file = trustFile()
    writeFileSync(file, JSON.stringify({ projects: { 'q:/apps/one': { hash: 'x' } } }), 'utf8')

    expect(SetupTrustStore.load(file, () => undefined).acknowledgedHashOf(projectRoot)).toBe(null)
  })

  describe('the latch over a file it could not read', () => {
    /*
     * Reading nothing costs one extra question. WRITING over a document this store could not read
     * replaces every other project's agreement with the single one being recorded, and those are
     * answers a person already gave. So a damaged read stops the write, the way every other store
     * in this library stops it.
     */
    it('leaves a damaged file exactly as it found it', () => {
      const file = trustFile()
      const damaged = '{ "projects": '
      writeFileSync(file, damaged, 'utf8')
      const reports: string[] = []
      const store = SetupTrustStore.load(file, (message) => reports.push(message))

      store.acknowledge(projectRoot, 'hash-1')

      expect(readFileSync(file, 'utf8')).toBe(damaged)
      expect(reports.some((message) => message.includes('asked about again'))).toBe(true)
    })

    /** The same fact on every later acknowledgement, so it is said once. */
    it('says the latch once however often it is asked', () => {
      const file = trustFile()
      writeFileSync(file, '{ "projects": ', 'utf8')
      const reports: string[] = []
      const store = SetupTrustStore.load(file, (message) => reports.push(message))

      store.acknowledge(projectRoot, 'hash-1')
      store.acknowledge(join('Q:', 'apps', 'two'), 'hash-2')

      expect(reports.filter((message) => message.includes('asked about again'))).toHaveLength(1)
    })

    // An entry this store drops is an agreement it would erase on the next write, so the shape it
    // does not understand latches too - reading it is lenient, writing over it is not.
    it('latches on an entry it had to drop, not only on unreadable JSON', () => {
      const file = trustFile()
      const held = JSON.stringify({ projects: { 'q:/apps/one': { hash: 'x' } } })
      writeFileSync(file, held, 'utf8')
      const store = SetupTrustStore.load(file, () => undefined)

      store.acknowledge(join('Q:', 'apps', 'two'), 'hash-2')

      expect(readFileSync(file, 'utf8')).toBe(held)
    })

    // A file that is not there yet is not damaged: it is what a machine that agreed to nothing
    // looks like, and the first acknowledgement is what creates it.
    it('writes normally when there was simply no file yet', () => {
      const file = trustFile()
      const store = SetupTrustStore.load(file, () => undefined)

      store.acknowledge(projectRoot, 'hash-1')

      expect(SetupTrustStore.load(file, () => undefined).acknowledgedHashOf(projectRoot))
        .toBe('hash-1')
    })

    /** An empty document is ordinary: nothing has been agreed to, and the write is allowed. */
    it('writes normally over a document that names no projects', () => {
      const file = trustFile()
      writeFileSync(file, JSON.stringify({ schemaVersion: 1 }), 'utf8')
      const store = SetupTrustStore.load(file, () => undefined)

      store.acknowledge(projectRoot, 'hash-1')

      expect(SetupTrustStore.load(file, () => undefined).acknowledgedHashOf(projectRoot))
        .toBe('hash-1')
    })
  })

  describe('hashOf', () => {
    it('answers the same for the same commands and differently for a different order', () => {
      expect(SetupTrustStore.hashOf(['a', 'b'])).toBe(SetupTrustStore.hashOf(['a', 'b']))
      expect(SetupTrustStore.hashOf(['a', 'b'])).not.toBe(SetupTrustStore.hashOf(['b', 'a']))
      expect(SetupTrustStore.hashOf(['a'])).not.toBe(SetupTrustStore.hashOf(['a', '']))
    })
  })
})
