import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { type JsonDocumentReading, JsonDocumentStore } from './jsonDocumentStore'

/**
 * The latch, measured on the base rather than on each store that leans on it. Three stores held
 * their own copy of it and it was missing from others, which is how a workspace was lost on
 * 2026-06-11 - so what this file asserts is that a subclass CANNOT get it wrong, not that one
 * particular subclass got it right.
 */
describe('lib-orchestrator/shared/jsonDocumentStore', () => {
  interface Held {
    kept: readonly string[]
  }

  class ProbeStore extends JsonDocumentStore<Held> {
    document: Held = { kept: [] }
    /** Set by a test to make `coerce` answer "usable, but the file said more than this". */
    partial = false

    constructor(file: string, readonly said: string[]) {
      super(file, (message) => said.push(message))
    }

    static open(file: string): ProbeStore {
      const store = new ProbeStore(file, [])
      store.load()
      return store
    }

    /** The subclass's own load, which is where every store here reads: from inside itself. */
    load(): void {
      this.document = this.readDocumentSync()
    }

    protected get subject(): string {
      return 'The probe document'
    }

    protected get refusalConsequence(): string {
      return 'nothing is written for the rest of this session'
    }

    protected get readFailureConsequence(): string {
      return 'starting from none'
    }

    protected emptyDocument(): Held {
      return { kept: [] }
    }

    protected coerce(parsed: unknown): JsonDocumentReading<Held> {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('expected an object')
      const kept = (parsed as { kept?: unknown }).kept
      if (!Array.isArray(kept)) throw new Error('kept must be an array')
      return { document: { kept: kept as string[] }, damaged: this.partial }
    }

    protected writeFailureMessage(detail: string): string {
      return `The probe document could not be written (${detail})`
    }

    write(kept: readonly string[]): Promise<boolean> {
      return this.writeDocument({ kept })
    }

    writeSync(kept: readonly string[]): boolean {
      return this.writeDocumentSync({ kept })
    }

    writeAfter(kept: readonly string[], before: () => Promise<boolean>): Promise<boolean> {
      return this.writeDocument({ kept }, before)
    }
  }

  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function fileIn(contents?: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-json-store-'))
    directories.push(directory)
    const file = join(directory, 'nested', 'document.json')
    if (contents !== undefined) {
      mkdirSync(join(directory, 'nested'))
      writeFileSync(file, contents, 'utf8')
    }
    return file
  }

  // A machine that has recorded nothing looks exactly like this, and the first write creates it.
  it('does not latch on a file that is not there, and creates it on the first write', async () => {
    const store = ProbeStore.open(fileIn())

    expect(store.latched).toBe(false)
    expect(await store.write(['one'])).toBe(true)
    expect(store.said).toEqual([])
  })

  it('latches a document it cannot parse, and says what it will mean once', async () => {
    const store = ProbeStore.open(fileIn('{ "kept": '))

    expect(store.latched).toBe(true)
    expect(store.said).toHaveLength(1)
    expect(store.said[0]).toContain('are unreadable')
    expect(store.said[0]).toContain('starting from none')

    expect(await store.write(['one'])).toBe(false)
    expect(store.writeSync(['two'])).toBe(false)

    // Once, whichever writer got there first, and whichever asked afterwards.
    const refusals = store.said.filter((message) => message.includes('nothing is written'))
    expect(refusals).toHaveLength(1)
  })

  /*
   * The half a parse check cannot see. The document came back USABLE - the store can answer from it
   * - and it is still one a write would erase the rest of, because the file said things this store
   * dropped. `SetupTrustStore` is the case: an entry of a shape it does not understand is somebody's
   * agreement, and writing over it withdraws an answer a person already gave.
   */
  it('latches a document that parsed but was only partly understood', async () => {
    const file = fileIn('{ "kept": ["one"] }')
    const store = new ProbeStore(file, [])
    store.partial = true
    store.load()

    expect(store.document.kept).toEqual(['one'])
    expect(store.latched).toBe(true)
    expect(await store.write(['two'])).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{ "kept": ["one"] }')
  })

  // The recovery point `SessionRecordsStore` takes before a destructive write: no undo, no write.
  it('abandons the write when what must happen first refuses', async () => {
    const file = fileIn('{ "kept": ["one"] }')
    const store = ProbeStore.open(file)

    expect(await store.writeAfter(['two'], () => Promise.resolve(false))).toBe(false)

    expect(readFileSync(file, 'utf8')).toBe('{ "kept": ["one"] }')
    expect(await store.writeAfter(['two'], () => Promise.resolve(true))).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ kept: ['two'] })
  })

  it('answers false and says its own sentence when the write itself cannot land', async () => {
    const file = fileIn('{ "kept": ["one"] }')
    const store = ProbeStore.open(file)
    rmSync(file)
    mkdirSync(file)

    expect(await store.write(['two'])).toBe(false)

    expect(store.said.at(-1)).toContain('The probe document could not be written')
    expect(store.document.kept).toEqual(['one'])
  })
})
