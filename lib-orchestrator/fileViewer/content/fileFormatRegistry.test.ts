import { describe, expect, it } from 'vitest'

import { FileFormatRegistry } from './fileFormatRegistry'

describe('fileViewer/content/fileFormatRegistry', () => {
  const text = new TextEncoder().encode('const value = 1\n')
  // What a real PDF opens with: `%PDF-1.7` and then the binary comment line every writer emits so
  // that a transfer treats the file as binary.
  const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xe2, 0xe3, 0xcf, 0xd3])
  const nulByte = Uint8Array.from([65, 0, 66])
  // Text in a single-byte encoding, which is not UTF-8 and is not ours to guess at.
  const latin1 = Uint8Array.from([0x50, 0xf8, 0xed, 0x6c, 0x69, 0x9a])

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
    expect(FileFormatRegistry.classify({ path: 'archive.pdf', exists: true, sample: pdf }))
      .to.deep.equal({ kind: 'hex' })
  })

  /**
   * The extension tables name what gets a RENDERER; they never decided what is TEXT. They used to: a
   * second list held `txt`, `log`, `csv`, `env` and six more, and everything outside it opened as a
   * hex dump - `.pri`, `.gradle`, `.qrc`, `.rc`, `.tex`, and every extension nobody thought of.
   */
  it('reads an unlisted extension as text when its bytes are text', () => {
    for (const path of ['Atlantic18.pri', 'build.gradle', 'app.qrc', 'paper.tex', 'notes.whatever'])
      expect(FileFormatRegistry.classify({ path, exists: true, sample: text }), path)
        .to.deep.equal({ kind: 'text' })
    expect(FileFormatRegistry.classify({ path: '.env-production-eu', exists: true, sample: text }))
      .to.deep.equal({ kind: 'text' })
    expect(FileFormatRegistry.classify({ path: 'server.log', exists: true, sample: text }))
      .to.deep.equal({ kind: 'text' })
  })

  it('still reads an unlisted extension as hex when its bytes are not text', () => {
    expect(FileFormatRegistry.classify({ path: 'level.pak', exists: true, sample: nulByte }))
      .to.deep.equal({ kind: 'hex' })
    expect(FileFormatRegistry.classify({ path: 'notes.txt', exists: true, sample: latin1 }))
      .to.deep.equal({ kind: 'hex' })
    // No NUL and valid UTF-8, which is all a named extension is asked for. A nameless file is asked
    // for more, because here the bytes are the only evidence there is.
    expect(FileFormatRegistry.classify({
      path: 'payload.bin',
      exists: true,
      sample: new Uint8Array(64).fill(7),
    })).to.deep.equal({ kind: 'hex' })
    // What text does use, so a captured log with ANSI colour still opens as one: escape, tab,
    // carriage return and newline.
    expect(FileFormatRegistry.classify({
      path: 'capture.out',
      exists: true,
      sample: Uint8Array.from([0x1b, 0x5b, 0x33, 0x32, 0x6d, 0x6f, 0x6b, 0x09, 0x0d, 0x0a]),
    })).to.deep.equal({ kind: 'text' })
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
    expect(FileFormatRegistry.classify({ path: 'main.ts', exists: true, sample: nulByte }))
      .to.deep.equal({ kind: 'hex' })
    expect(FileFormatRegistry.classify({ path: 'README.md', exists: true, sample: nulByte }))
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
