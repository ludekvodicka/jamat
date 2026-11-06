import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentExport } from './documentExport'

describe('DocumentExport', () => {
  const roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

  it('names the export after the source, beside it, and refuses to overwrite the source itself', () => {
    expect(DocumentExport.target(join('C:', 'work', 'notes.md'), 'pdf')).toBe(join('C:', 'work', 'notes.pdf'))
    expect(DocumentExport.target(join('C:', 'work', 'Makefile'), 'html')).toBe(join('C:', 'work', 'Makefile.html'))
    expect(() => DocumentExport.target(join('C:', 'work', 'page.html'), 'html')).toThrow('The document is itself a .html file')
  })

  it('writes HTML as given and PDF as printed, replacing an earlier export', async () => {
    const root = await mkdtemp(join(tmpdir(), 'document-export-'))
    roots.push(root)
    const print = vi.fn(async () => new Uint8Array([37, 80, 68, 70]))
    const exporter = new DocumentExport({ print })
    const source = join(root, 'notes.md')
    await writeFile(join(root, 'notes.html'), 'old')
    expect(await exporter.write(source, 'html', '<p>new</p>')).toBe(join(root, 'notes.html'))
    expect(await readFile(join(root, 'notes.html'), 'utf8')).toBe('<p>new</p>')
    expect(await exporter.write(source, 'pdf', '<p>new</p>')).toBe(join(root, 'notes.pdf'))
    expect(print).toHaveBeenCalledWith('<p>new</p>')
    expect([...await readFile(join(root, 'notes.pdf'))]).toEqual([37, 80, 68, 70])
  })
})
