import { describe, expect, it } from 'vitest'

import { FileHtmlPreviewStore } from './fileHtmlPreviewStore'

describe('app-client-ui/app/fileViewer/fileHtmlPreviewStore', () => {
  it('stores UTF-8 HTML per owner and restricts release to that owner', () => {
    const store = new FileHtmlPreviewStore()
    const id = store.register('window-1', '<!doctype html><script>1</script>')
    expect(id).toMatch(/^[0-9a-f-]+$/)
    expect(new TextDecoder().decode(store.read(id)!)).toBe('<!doctype html><script>1</script>')

    store.release('window-2', id)
    expect(store.read(id)).not.toBeNull()

    store.release('window-1', id)
    expect(store.read(id)).toBeNull()
  })

  it('revokes every preview of a departing window without touching other windows', () => {
    const store = new FileHtmlPreviewStore()
    const first = store.register('window-1', '<p>one</p>')
    const second = store.register('window-1', '<p>two</p>')
    const other = store.register('window-2', '<p>other</p>')

    store.revokeOwner('window-1')

    expect(store.read(first)).toBeNull()
    expect(store.read(second)).toBeNull()
    expect(store.read(other)).not.toBeNull()
  })

  it('evicts the oldest entry past capacity and rejects invalid or oversized input', () => {
    const store = new FileHtmlPreviewStore()
    const ids: string[] = []
    for (let index = 0; index <= FileHtmlPreviewStore.maxEntriesConst; index += 1)
      ids.push(store.register('window-1', `<p>${index}</p>`))

    expect(store.read(ids[0]!)).toBeNull()
    expect(store.read(ids.at(-1)!)).not.toBeNull()
    expect(() => store.register('window-1', 123 as unknown as string)).toThrow(/must be a string/)
    expect(() => store.register('window-1', 'a'.repeat(FileHtmlPreviewStore.maxBytesConst + 1)))
      .toThrow(/exceeds/)
  })
})
