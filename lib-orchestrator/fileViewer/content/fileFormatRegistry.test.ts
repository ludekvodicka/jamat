import { describe, expect, it } from 'vitest'

import { FileFormatRegistry } from './fileFormatRegistry'

describe('fileViewer/content/fileFormatRegistry', () => {
  const text = new TextEncoder().encode('const value = 1\n')

  it('classifies the supported document families', () => {
    expect(FileFormatRegistry.classify({ path: 'README.md', exists: true, sample: text }))
      .to.deep.equal({ kind: 'markdown', flavor: 'markdown' })
    expect(FileFormatRegistry.classify({ path: 'design.mdext', exists: true, sample: text }))
      .to.deep.equal({ kind: 'markdown', flavor: 'mdext' })
    expect(FileFormatRegistry.classify({ path: 'main.cpp', exists: true, sample: text }))
      .to.deep.equal({ kind: 'code', language: 'cpp' })
    expect(FileFormatRegistry.classify({ path: 'photo.jpg', exists: true, sample: text }))
      .to.deep.equal({ kind: 'image', mimeType: 'image/jpeg', animated: false })
    expect(FileFormatRegistry.classify({ path: 'clip.webm', exists: true, sample: text }))
      .to.deep.equal({ kind: 'video', mimeType: 'video/webm' })
    expect(FileFormatRegistry.classify({ path: 'archive.pdf', exists: true, sample: text }))
      .to.deep.equal({ kind: 'hex' })
  })

  /**
   * The language table knows `html` as a language, so a page classified as `code` and opened as its
   * own highlighted source. It is a page: `rendered` draws it, and the source is what `raw` is for.
   */
  it('classifies a page as a page rather than as its own source', () => {
    expect(FileFormatRegistry.classify({ path: 'report.html', exists: true, sample: text }))
      .to.deep.equal({ kind: 'html' })
    expect(FileFormatRegistry.classify({ path: 'INDEX.HTM', exists: true, sample: text }))
      .to.deep.equal({ kind: 'html' })
    expect(FileFormatRegistry.classify({
      path: 'report.html',
      exists: true,
      sample: Uint8Array.from([60, 0, 62]),
    })).to.deep.equal({ kind: 'hex' })
  })

  it('uses content gates for formats that claim to be text', () => {
    const binary = Uint8Array.from([65, 0, 66])
    expect(FileFormatRegistry.classify({ path: 'main.ts', exists: true, sample: binary }))
      .to.deep.equal({ kind: 'hex' })
    expect(FileFormatRegistry.classify({ path: 'README.md', exists: true, sample: binary }))
      .to.deep.equal({ kind: 'hex' })
  })

  it('recognizes special source filenames and missing documents', () => {
    expect(FileFormatRegistry.classify({ path: 'Dockerfile', exists: true, sample: text }))
      .to.deep.equal({ kind: 'code', language: 'dockerfile' })
    expect(FileFormatRegistry.classify({ path: 'gone.ts', exists: false, sample: new Uint8Array() }))
      .to.deep.equal({ kind: 'missing' })
  })

  it('maps common source, image and video extensions', () => {
    const languages: Readonly<Record<string, string>> = {
      'main.js': 'javascript',
      'main.ts': 'typescript',
      'main.tsx': 'tsx',
      'main.c': 'c',
      'main.cpp': 'cpp',
      'main.cs': 'csharp',
      'main.java': 'java',
      'main.py': 'python',
      'main.go': 'go',
      'main.rs': 'rust',
      'query.sql': 'sql',
      'build.ps1': 'powershell',
    }
    for (const [path, language] of Object.entries(languages))
      expect(FileFormatRegistry.classify({ path, exists: true, sample: text }), path)
        .to.deep.equal({ kind: 'code', language })
    const images: Readonly<Record<string, string>> = {
      png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
      bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
    }
    for (const [extension, mimeType] of Object.entries(images)) {
      const kind = FileFormatRegistry.classify({
        path: `image.${extension}`,
        exists: true,
        sample: text,
      })
      expect(kind, extension).to.deep.equal({
        kind: 'image',
        mimeType,
        animated: extension === 'gif',
      })
    }
    const videos: Readonly<Record<string, string>> = {
      mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
    }
    for (const [extension, mimeType] of Object.entries(videos))
      expect(FileFormatRegistry.classify({
        path: `video.${extension}`,
        exists: true,
        sample: text,
      }), extension).to.deep.equal({ kind: 'video', mimeType })
  })

  it('returns only modes valid for a document kind', () => {
    // `hex` is last on every text kind: the kind is decided from a 64 KiB sample and the read
    // refuses the whole file for a NUL anywhere in it, so without this a log with one NUL past the
    // sample had no mode left that could show it.
    expect(FileFormatRegistry.modes({ kind: 'markdown', flavor: 'mdext' }, true))
      .to.deep.equal(['rendered', 'raw', 'diff', 'hex'])
    expect(FileFormatRegistry.modes({ kind: 'html' }, true))
      .to.deep.equal(['rendered', 'raw', 'diff', 'hex'])
    // A page is read whole to be drawn, so the same ceiling the other text kinds carry applies.
    expect(FileFormatRegistry.modes({ kind: 'html' }, false, 2 * 1024 * 1024 + 1))
      .to.deep.equal(['hex'])
    expect(FileFormatRegistry.modes({ kind: 'text' }, false)).to.deep.equal(['raw', 'hex'])
    expect(FileFormatRegistry.modes({ kind: 'image', mimeType: 'image/png', animated: false }, true))
      .to.deep.equal(['preview', 'hex'])
    expect(FileFormatRegistry.modes({ kind: 'missing' }, false)).to.deep.equal([])
    expect(FileFormatRegistry.modes(
      { kind: 'code', language: 'typescript' },
      true,
      2 * 1024 * 1024 + 1,
    )).to.deep.equal(['hex', 'diff'])
  })

  /**
   * The maps are plain object literals and the key is an extension off a filename, so a file called
   * `x.constructor` used to answer with a function - which passed the truthiness test, became a
   * `mimeType` typed as `string`, and then could not cross IPC at all, because structured cloning
   * refuses a function. The panel said "An object could not be cloned" instead of showing the file.
   */
  it('reads nothing off the prototype for a filename that names one of its members', () => {
    for (const name of ['x.constructor', 'x.toString', 'x.__proto__', 'constructor', 'toString']) {
      const kind = FileFormatRegistry.classify({
        exists: true,
        path: `Q:/work/${name}`,
        sample: Buffer.from('plain text\n'),
      })

      expect(JSON.stringify(kind), name).to.be.a('string')
      for (const value of Object.values(kind))
        expect(typeof value, `${name} -> ${String(value)}`).to.not.equal('function')
    }
  })
})
