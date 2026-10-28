import { describe, expect, it, vi } from 'vitest'
import type { SessionDirectoryPorts } from '../../shared/sessionWorkspace'
import type { FileViewerDirectoryEntry, FileViewerDocumentKind } from '../../../lib-orchestrator/fileViewer/fileViewerApi.types'
import { FileImageSource } from './fileImageSource'

const entry: FileViewerDirectoryEntry = { entryId: 'entry', name: 'photo.png', path: 'remote/photo.png',
  nodeKind: 'file', targetKind: 'file', size: 10, modifiedAt: 1, openable: true, detail: null }

function ports(kind: FileViewerDocumentKind) {
  return {
    openEntry: vi.fn(async () => ({ ok: true, value: { ok: true, value: { documentId: 'document', kind } } })),
    mediaResource: vi.fn(async () => ({ ok: true, value: { ok: true, value: { resourceId: 'grant' } } })),
    text: vi.fn(async () => ({ ok: true, value: { ok: true, kind: 'text', text: '<svg xmlns="http://www.w3.org/2000/svg"/>' } })),
    release: vi.fn(async () => ({ ok: true, value: undefined })),
  }
}

describe('fullscreen file sources', () => {
  it.each(['png', 'JPG', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])('offers the image action for .%s', (extension) => {
    expect(FileImageSource.supports({ ...entry, name: `a.${extension}` })).toBe(true)
  })
  it('does not offer image viewing for folders, unavailable files or unrelated extensions', () => {
    expect(FileImageSource.supports({ ...entry, targetKind: 'directory' })).toBe(false)
    expect(FileImageSource.supports({ ...entry, openable: false })).toBe(false)
    for (const name of ['a.png.txt', 'a.md', 'a.mp4', 'a.tiff', 'png'])
      expect(FileImageSource.supports({ ...entry, name })).toBe(false)
  })
  it('uses the provided local or remote grants and retains them until the popup closes', async () => {
    const api = ports({ kind: 'image', mimeType: 'image/png', animated: false })
    const resource = await FileImageSource.directory(api as unknown as SessionDirectoryPorts, 'directory', entry).load()
    expect(api.openEntry).toHaveBeenCalledExactlyOnceWith('directory', 'entry')
    expect(api.mediaResource).toHaveBeenCalledExactlyOnceWith('document')
    expect(resource.url).toBe('jamat-v3-file://resource/grant')
    expect(api.release).not.toHaveBeenCalled()
    resource.release!()
    expect(api.release).toHaveBeenCalledExactlyOnceWith('document')
  })
  it('renders SVG as image data without inserting its document into the application', async () => {
    const api = ports({ kind: 'svg', mimeType: 'image/svg+xml' })
    const resource = await FileImageSource.directory(api as unknown as SessionDirectoryPorts, 'directory', entry).load()
    expect(resource.url).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E')
    expect(api.mediaResource).not.toHaveBeenCalled()
    resource.release!()
    expect(api.release).toHaveBeenCalledOnce()
  })
  it('checks the actual file kind after an extension-based menu hint', async () => {
    const api = ports({ kind: 'text' })
    await expect(FileImageSource.directory(api as unknown as SessionDirectoryPorts, 'directory', entry).load()).rejects.toThrow('not a supported image')
    expect(api.release).toHaveBeenCalledOnce()
  })
  it('releases the document when resource loading fails', async () => {
    const api = ports({ kind: 'image', mimeType: 'image/png', animated: false })
    api.mediaResource.mockRejectedValueOnce(new Error('Remote disconnected'))
    await expect(FileImageSource.directory(api as unknown as SessionDirectoryPorts, 'directory', entry).load()).rejects.toThrow('Remote disconnected')
    expect(api.release).toHaveBeenCalledOnce()
  })
})
