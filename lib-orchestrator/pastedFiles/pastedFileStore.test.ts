import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PastedFileStore } from './pastedFileStore'

describe('lib-orchestrator/pastedFiles/pastedFileStore', () => {
  const created: string[] = []
  const dayConst = 86_400_000
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])
  const text = new TextEncoder().encode('first part|second part')

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function directory(): string {
    const root = mkdtempSync(join(tmpdir(), 'jamat-v3-pasted-files-'))
    created.push(root)
    return join(root, 'pasted-files')
  }

  describe('clipboard images', () => {
    it('writes a PNG and a JPEG under the session folder with the extension their signature names', async () => {
      const root = directory()
      const store = new PastedFileStore(root, () => Date.UTC(2026, 9, 14, 8, 30, 5))
      const first = await store.saveImage('session-1', png)
      const second = await store.saveImage('session-1', jpeg)
      if (!first.ok || !second.ok) throw new Error('save refused')
      expect(dirname(first.path)).toBe(join(root, 'session-1'))
      expect(basename(first.path)).toMatch(/^20261014-083005-[0-9a-f]{6}-clipboard\.png$/)
      expect(second.path).toMatch(/clipboard\.jpg$/)
      expect(Uint8Array.from(readFileSync(first.path))).toEqual(png)
    })

    it('refuses bytes that are neither PNG nor JPEG and writes nothing', async () => {
      const root = directory()
      const answer = await new PastedFileStore(root).saveImage('s', new TextEncoder().encode('<svg/>'))
      expect(answer).toEqual({ ok: false, detail: 'The clipboard image is not a PNG or JPEG' })
      expect(existsSync(root)).toBe(false)
    })

    it('keeps a session id from naming a path outside its own folder', async () => {
      const root = directory()
      const answer = await new PastedFileStore(root).saveImage('../../escape', png)
      if (!answer.ok) throw new Error(answer.detail)
      expect(dirname(answer.path)).toBe(join(root, '______escape'))
    })
  })

  describe('files sent in chunks', () => {
    it('assembles the chunks in order and answers the path with the last one', async () => {
      const root = directory()
      const store = new PastedFileStore(root)
      const head = text.slice(0, 10)
      const tail = text.slice(10)
      expect(await store.receive('k', 's1', { fileName: 'notes.txt', size: text.length, offset: 0, bytes: head }))
        .toEqual({ ok: true, kind: 'partial', received: 10 })
      const done = await store.receive('k', 's1', { fileName: 'notes.txt', size: text.length, offset: 10, bytes: tail })
      if (!done.ok || done.kind !== 'complete') throw new Error(JSON.stringify(done))
      expect(dirname(done.path)).toBe(join(root, 's1'))
      expect(done.path).toMatch(/-notes\.txt$/)
      expect(readFileSync(done.path, 'utf8')).toBe('first part|second part')
      expect(readdirSync(join(root, 's1'))).toEqual([basename(done.path)])
    })

    it('completes an empty file at once', async () => {
      const store = new PastedFileStore(directory())
      const done = await store.receive('k', 's1', { fileName: 'empty.log', size: 0, offset: 0, bytes: new Uint8Array(0) })
      expect(done).toMatchObject({ ok: true, kind: 'complete' })
    })

    it('keeps only the last name of a sender path and replaces what a path could read as structure', async () => {
      const store = new PastedFileStore(directory())
      const done = await store.receive('k', 's1', { fileName: 'C:\\Users\\Ann\\..\\Bug report č.1.txt', size: 1, offset: 0, bytes: Uint8Array.from([65]) })
      if (!done.ok || done.kind !== 'complete') throw new Error(JSON.stringify(done))
      expect(basename(done.path)).toMatch(/-Bug_report__\.1\.txt$/)
    })

    it('refuses a chunk out of order or past the size and removes the partial file', async () => {
      const root = directory()
      const store = new PastedFileStore(root)
      await store.receive('k', 's1', { fileName: 'a.txt', size: text.length, offset: 0, bytes: text.slice(0, 5) })
      expect(await store.receive('k', 's1', { fileName: 'a.txt', size: text.length, offset: 7, bytes: text.slice(7) }))
        .toEqual({ ok: false, detail: 'The file upload arrived out of order; paste again' })
      expect(readdirSync(join(root, 's1'))).toEqual([])
      await store.receive('k', 's1', { fileName: 'a.txt', size: 2, offset: 0, bytes: text.slice(0, 1) })
      expect(await store.receive('k', 's1', { fileName: 'a.txt', size: 2, offset: 1, bytes: text.slice(1, 5) }))
        .toEqual({ ok: false, detail: 'The file upload is larger than it said' })
      expect(await store.receive('other', 's1', { fileName: 'a.txt', size: 2, offset: 1, bytes: text.slice(1, 2) }))
        .toEqual({ ok: false, detail: 'The file upload is unknown or expired; paste again' })
    })

    it('drops an upload idle past its time, so its next chunk is refused', async () => {
      const clock = { now: 1_000_000 }
      const root = directory()
      const store = new PastedFileStore(root, () => clock.now)
      await store.receive('k', 's1', { fileName: 'a.txt', size: 4, offset: 0, bytes: text.slice(0, 2) })
      clock.now += PastedFileStore.uploadIdleMillisecondsConst + 1
      expect(await store.receive('k', 's1', { fileName: 'a.txt', size: 4, offset: 2, bytes: text.slice(2, 4) }))
        .toEqual({ ok: false, detail: 'The file upload is unknown or expired; paste again' })
      expect(readdirSync(join(root, 's1'))).toEqual([])
    })
  })

  it('removes files past their age and the folders they leave empty, and keeps recent ones', async () => {
    const root = directory()
    const now = 100 * dayConst
    const old = join(root, 'gone', 'old.png')
    const recent = join(root, 'kept', 'recent.png')
    for (const path of [old, recent]) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, png)
    }
    utimesSync(old, new Date(now - 15 * dayConst), new Date(now - 15 * dayConst))
    utimesSync(recent, new Date(now - dayConst), new Date(now - dayConst))
    const answer = await new PastedFileStore(root, () => now).saveImage('fresh', png)
    expect(answer.ok).toBe(true)
    expect(readdirSync(root).sort()).toEqual(['fresh', 'kept'])
  })

  it('saves concurrently pasted images for different sessions without one prune losing the other', async () => {
    const root = directory()
    const store = new PastedFileStore(root)
    const answers = await Promise.all(['a', 'b', 'c'].map((session) => store.saveImage(session, png)))
    for (const answer of answers) {
      if (!answer.ok) throw new Error(answer.detail)
      expect(existsSync(answer.path)).toBe(true)
    }
  })
})
