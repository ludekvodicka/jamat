import { describe, expect, it } from 'vitest'

import type {
  FileViewerDocument,
  FileViewerDocumentSource,
} from '../fileViewerApi.types'
import {
  FileViewerGrantStore,
  type StoredFileViewerEntry,
} from './fileViewerGrantStore'

/**
 * Every bounded grant this subsystem hands out, and the clock that bounds them.
 *
 * The store had no test file at all until 2026-08-24, and its constructor takes `now` for exactly
 * one reason - so a test can move the clock - which nothing did. Emptying `prune` (grants that never
 * expire), and turning `revokeOwner`, `revokeDocument` and `evict` into no-ops (grants that survive
 * a closed window, maps that grow without a ceiling), left every suite in the repository green.
 */
describe('lib-orchestrator/fileViewer/access/fileViewerGrantStore', () => {
  const hourConst = 60 * 60_000

  class Clock {
    private value = 1_000_000
    readonly read = (): number => this.value
    forward(milliseconds: number): void { this.value += milliseconds }
  }

  function sourceOf(path: string): FileViewerDocumentSource {
    return { kind: 'workspace', sessionId: 's1', path }
  }

  function documentOf(documentId: string, source = sourceOf('C:/work/a.ts')): FileViewerDocument {
    return {
      documentId,
      documentKey: `key-${documentId}`,
      source,
      path: source.path,
      name: 'a.ts',
      size: 10,
      contentVersion: 'v1',
      kind: { kind: 'text' },
      modes: ['raw'],
    } as unknown as FileViewerDocument
  }

  function store(clock: Clock): FileViewerGrantStore {
    return new FileViewerGrantStore(clock.read)
  }

  function put(
    grants: FileViewerGrantStore,
    documentId: string,
    ownerId = 'window-1',
    source = sourceOf('C:/work/a.ts'),
  ): void {
    grants.putDocument({ ownerId, rootPath: 'C:/work', document: documentOf(documentId, source) })
  }

  describe('the two hours a grant lasts', () => {
    it('answers while the grant is inside its window and refuses once it is past', () => {
      const clock = new Clock()
      const grants = store(clock)
      put(grants, 'read')
      put(grants, 'untouched')

      // A whisker inside. The read is also a use, so this one's window starts again from here.
      clock.forward(2 * hourConst - 1)
      expect(grants.document('read', 'window-1').ok).to.equal(true)

      clock.forward(2)
      const expired = grants.document('untouched', 'window-1')
      expect(expired.ok).to.equal(false)
      expect(expired.ok ? null : expired.code).to.equal('document-expired')
      expect(grants.document('read', 'window-1').ok).to.equal(true)
    })

    /* The window slides on every read, which is what makes a document open all day keep working. */
    it('gives a grant its full two hours back every time it is used', () => {
      const clock = new Clock()
      const grants = store(clock)
      put(grants, 'doc-1')

      for (let hour = 0; hour < 6; hour += 1) {
        clock.forward(hourConst)
        expect(grants.document('doc-1', 'window-1').ok).to.equal(true)
      }

      clock.forward(2 * hourConst + 1)
      expect(grants.document('doc-1', 'window-1').ok).to.equal(false)
    })

    it('expires a resource and a directory on the same clock', () => {
      const clock = new Clock()
      const grants = store(clock)
      const directoryId = grants.putDirectory({
        ownerId: 'window-1',
        rootPath: 'C:/work',
        path: 'C:/work/src',
        source: sourceOf('C:/work/a.ts'),
      })
      const resource = grants.putResource({
        ownerId: 'window-1',
        documentId: 'doc-1',
        rootPath: 'C:/work',
        path: 'C:/work/img.png',
        mimeType: 'image/png',
        size: 4,
        contentVersion: 'v1',
      })

      clock.forward(2 * hourConst + 1)
      expect(grants.directory(directoryId, 'window-1').ok).to.equal(false)
      expect(grants.resource(resource.resourceId)).to.equal(null)
    })

    /*
     * Refilling a directory's entries is a use of it too: the listing arrives after the token is
     * minted, and a token that kept its original deadline would be closer to expiry the slower the
     * listing was.
     */
    it('gives a directory its window back when its entries are filled in', () => {
      const clock = new Clock()
      const grants = store(clock)
      const directoryId = grants.putDirectory({
        ownerId: 'window-1',
        rootPath: 'C:/work',
        path: 'C:/work/src',
        source: sourceOf('C:/work/a.ts'),
      })

      clock.forward(hourConst)
      const entry: StoredFileViewerEntry = {
        public: {
          entryId: 'e1',
          name: 'a.ts',
          path: 'C:/work/src/a.ts',
          nodeKind: 'file',
          targetKind: 'file',
          size: 1,
          modifiedAt: null,
          openable: true,
          detail: null,
        },
        path: 'C:/work/src/a.ts',
        targetKind: 'file',
      }
      grants.setDirectoryEntries(directoryId, new Map([['e1', entry]]))

      clock.forward(2 * hourConst - 1)
      const found = grants.entry(directoryId, 'e1', 'window-1')
      expect(found.ok).to.equal(true)
      expect(found.ok ? found.entry.path : null).to.equal('C:/work/src/a.ts')
    })

    it('refuses to fill in a directory token nobody minted', () => {
      const grants = store(new Clock())
      expect(() => grants.setDirectoryEntries('nothing', new Map()))
        .to.throw(/Unknown directory token/)
    })
  })

  describe('whose grant it is', () => {
    it('refuses a document token another window holds, and says which refusal it is', () => {
      const grants = store(new Clock())
      put(grants, 'doc-1', 'window-1')

      const wrong = grants.document('doc-1', 'window-2')
      expect(wrong.ok).to.equal(false)
      expect(wrong.ok ? null : wrong.code).to.equal('wrong-owner')
      expect(grants.path('doc-1', 'window-2').ok).to.equal(false)
      expect(grants.path('doc-1', 'window-1')).to.deep.equal({ ok: true, path: 'C:/work/a.ts' })
    })

    it('refuses a directory and an entry the same way', () => {
      const grants = store(new Clock())
      const directoryId = grants.putDirectory({
        ownerId: 'window-1',
        rootPath: 'C:/work',
        path: 'C:/work/src',
        source: sourceOf('C:/work/a.ts'),
      })
      grants.setDirectoryEntries(directoryId, new Map())

      const wrong = grants.entry(directoryId, 'e1', 'window-2')
      expect(wrong.ok).to.equal(false)
      expect(wrong.ok ? null : wrong.code).to.equal('wrong-owner')
      const missing = grants.entry(directoryId, 'e1', 'window-1')
      expect(missing.ok ? null : missing.code).to.equal('entry-expired')
    })
  })

  const entriesOf = (count: number): Map<string, StoredFileViewerEntry> => new Map(
    Array.from({ length: count }, (_, index) => [`e${index}`, {
      public: {
        entryId: `e${index}`,
        name: `${index}.ts`,
        path: `C:/work/${index}.ts`,
        nodeKind: 'file' as const,
        targetKind: 'file' as const,
        size: 1,
        modifiedAt: null,
        openable: true,
        detail: null,
      },
      path: `C:/work/${index}.ts`,
      targetKind: 'file' as const,
    }]),
  )

  describe('what a closed tab and a closed window take with them', () => {
    /*
     * The directories are the half that was missing until 2026-08-24: a directory grant made from an
     * EXTERNAL document is rooted outside the workspace on that document's own listing alone, so a
     * closed tab left a token still listing and opening files under it for the sliding two hours,
     * while the document token beside it already answered `document-expired`.
     */
    it('takes the document, its resources and the directories it justified', () => {
      const grants = store(new Clock())
      const source = sourceOf('C:/work/a.ts')
      put(grants, 'doc-1', 'window-1', source)
      const resource = grants.putResource({
        ownerId: 'window-1',
        documentId: 'doc-1',
        rootPath: 'C:/work',
        path: 'C:/work/img.png',
        mimeType: 'image/png',
        size: 4,
        contentVersion: 'v1',
      })
      const directoryId = grants.putDirectory({
        ownerId: 'window-1',
        rootPath: 'C:/work',
        path: 'C:/work/src',
        source,
      })

      grants.revokeDocument('doc-1', 'window-1')

      expect(grants.document('doc-1', 'window-1').ok).to.equal(false)
      expect(grants.resource(resource.resourceId)).to.equal(null)
      expect(grants.directory(directoryId, 'window-1').ok).to.equal(false)
    })

    it('leaves alone what another document and another window opened', () => {
      const grants = store(new Clock())
      put(grants, 'doc-1', 'window-1', sourceOf('C:/work/a.ts'))
      put(grants, 'doc-2', 'window-1', sourceOf('C:/work/b.ts'))
      const otherDirectory = grants.putDirectory({
        ownerId: 'window-1',
        rootPath: 'C:/work',
        path: 'C:/work/src',
        source: sourceOf('C:/work/b.ts'),
      })
      const otherDocument = grants.putResource({
        ownerId: 'window-1',
        documentId: 'doc-2',
        rootPath: 'C:/work',
        path: 'C:/work/img.png',
        mimeType: 'image/png',
        size: 4,
        contentVersion: 'v1',
      })

      grants.revokeDocument('doc-1', 'window-1')

      expect(grants.document('doc-2', 'window-1').ok).to.equal(true)
      expect(grants.directory(otherDirectory, 'window-1').ok).to.equal(true)
      expect(grants.resource(otherDocument.resourceId)).to.not.equal(null)
    })

    it('refuses to revoke a document on behalf of the window that does not hold it', () => {
      const grants = store(new Clock())
      put(grants, 'doc-1', 'window-1')

      grants.revokeDocument('doc-1', 'window-2')

      expect(grants.document('doc-1', 'window-1').ok).to.equal(true)
    })

    it('takes everything one window held when that window goes', () => {
      const grants = store(new Clock())
      put(grants, 'doc-1', 'window-1')
      put(grants, 'doc-2', 'window-2')
      const closing = grants.putDirectory({
        ownerId: 'window-1',
        rootPath: 'C:/work',
        path: 'C:/work/src',
        source: sourceOf('C:/work/a.ts'),
      })
      const staying = grants.putDirectory({
        ownerId: 'window-2',
        rootPath: 'C:/work',
        path: 'C:/work/src',
        source: sourceOf('C:/work/b.ts'),
      })
      const closingResource = grants.putResource({
        ownerId: 'window-1',
        documentId: 'doc-1',
        rootPath: 'C:/work',
        path: 'C:/work/img.png',
        mimeType: 'image/png',
        size: 4,
        contentVersion: 'v1',
      })

      grants.revokeOwner('window-1')

      expect(grants.document('doc-1', 'window-1').ok).to.equal(false)
      expect(grants.directory(closing, 'window-1').ok).to.equal(false)
      expect(grants.resource(closingResource.resourceId)).to.equal(null)
      expect(grants.document('doc-2', 'window-2').ok).to.equal(true)
      expect(grants.directory(staying, 'window-2').ok).to.equal(true)
    })
  })

  /*
   * The ceilings are what stops a long-lived window's maps growing without end. They evict the
   * OLDEST use rather than the oldest mint, which is what `touch` re-ordering the map is for.
   */
  describe('the ceilings on how many grants are held at once', () => {
    it('drops the least recently used document once the ceiling is reached', () => {
      const grants = store(new Clock())
      for (let index = 0; index < 256; index += 1) put(grants, `doc-${index}`)

      // Used again, so it is no longer the oldest.
      expect(grants.document('doc-0', 'window-1').ok).to.equal(true)
      put(grants, 'doc-256')

      expect(grants.document('doc-0', 'window-1').ok).to.equal(true)
      expect(grants.document('doc-1', 'window-1').ok).to.equal(false)
      expect(grants.document('doc-256', 'window-1').ok).to.equal(true)
    })

    /*
     * The count ceiling bounds grants, not size: 128 directories of up to 5 000 stored entries each
     * is 640 000 objects held in the main process, refreshed on every touch, long after the panel
     * that asked was closed. An explorer walk mints a new grant per navigation and releases none.
     */
    it('bounds how many directory entries all the grants hold between them', () => {
      const grants = store(new Clock())
      const walked: string[] = []
      // Twelve listings of 5 000 entries: 60 000, over the 50 000 the store holds at once.
      for (let step = 0; step < 12; step += 1) {
        const directoryId = grants.putDirectory({
          ownerId: 'window-1',
          rootPath: 'C:/work',
          path: `C:/work/${step}`,
          source: sourceOf('C:/work/a.ts'),
        })
        walked.push(directoryId)
        grants.setDirectoryEntries(directoryId, entriesOf(5_000))
      }

      // The one just filled in is the one somebody is looking at, and the oldest went first.
      expect(grants.directory(walked.at(-1)!, 'window-1').ok).to.equal(true)
      expect(grants.directory(walked[0]!, 'window-1').ok).to.equal(false)
      const alive = walked.filter((id) => grants.directory(id, 'window-1').ok)
      expect(alive.length).to.be.at.most(10)
    })

    /*
     * A read re-inserts a grant at the end of the map, so the one just filled in is not necessarily
     * the newest ROW - and it is the one somebody is looking at. Evicting it is the one wrong answer
     * the size ceiling can give.
     */
    it('never evicts the directory whose entries were just filled in', () => {
      const grants = store(new Clock())
      const filled: string[] = []
      const mint = (name: string): string => grants.putDirectory({
        ownerId: 'window-1',
        rootPath: 'C:/work',
        path: `C:/work/${name}`,
        source: sourceOf('C:/work/a.ts'),
      })
      for (let step = 0; step < 10; step += 1) {
        const id = mint(`old-${step}`)
        filled.push(id)
        grants.setDirectoryEntries(id, entriesOf(5_000))
      }
      // Minted before the reads below, so the reads leave it FIRST in the map.
      const looking = mint('looking')
      for (const id of filled) expect(grants.directory(id, 'window-1').ok).to.equal(true)

      grants.setDirectoryEntries(looking, entriesOf(5_000))

      expect(grants.directory(looking, 'window-1').ok).to.equal(true)
      expect(grants.directory(filled[0]!, 'window-1').ok).to.equal(false)
    })

    it('bounds the directories and the resources as well', () => {
      const grants = store(new Clock())
      const directories: string[] = []
      for (let index = 0; index < 129; index += 1)
        directories.push(grants.putDirectory({
          ownerId: 'window-1',
          rootPath: 'C:/work',
          path: `C:/work/${index}`,
          source: sourceOf('C:/work/a.ts'),
        }))
      const resources: string[] = []
      for (let index = 0; index < 513; index += 1)
        resources.push(grants.putResource({
          ownerId: 'window-1',
          documentId: 'doc-1',
          rootPath: 'C:/work',
          path: `C:/work/${index}.png`,
          mimeType: 'image/png',
          size: 4,
          contentVersion: 'v1',
        }).resourceId)

      expect(grants.directory(directories[0]!, 'window-1').ok).to.equal(false)
      expect(grants.directory(directories.at(-1)!, 'window-1').ok).to.equal(true)
      expect(grants.resource(resources[0]!)).to.equal(null)
      expect(grants.resource(resources.at(-1)!)).to.not.equal(null)
    })
  })
})
