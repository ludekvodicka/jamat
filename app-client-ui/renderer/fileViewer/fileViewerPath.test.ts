import { describe, expect, it } from 'vitest'

import { FileViewerPath } from './fileViewerPath'

describe('app-client-ui/renderer/fileViewer/fileViewerPath', () => {
  it('normalizes Windows paths and resolves Markdown links without Node APIs', () => {
    expect(FileViewerPath.equal('C:\\Work\\A.ts', 'c:/work/a.ts')).toBe(true)
    expect(FileViewerPath.resolve('C:\\Work\\docs\\index.md', '../src/readme'))
      .toBe('C:\\Work\\src\\readme')
  })

  /**
   * More `..` than there are segments used to produce a RELATIVE string, which the main process then
   * re-anchors in the session root - so a link pointing out of the project did not read as "outside
   * the root", it opened a different file INSIDE it. Handing the reference back untouched lets main
   * answer about the thing that was actually written.
   */
  it('gives a link that climbs past the root back rather than inventing a path inside it', () => {
    expect(FileViewerPath.resolve('C:\\Work\\docs\\index.md', '../../../../../../etc/hosts'))
      .toBe('../../../../../../etc/hosts')
    expect(FileViewerPath.resolve('/home/me/docs/index.md', '../../../../etc/hosts'))
      .toBe('../../../../etc/hosts')
  })

  // The leading separator of an absolute POSIX base was dropped, so every link in a document on
  // macOS or Linux resolved to a relative path.
  it('keeps a POSIX base absolute', () => {
    expect(FileViewerPath.resolve('/home/me/docs/index.md', 'notes.md'))
      .toBe('/home/me/docs/notes.md')
    expect(FileViewerPath.resolve('/home/me/docs/index.md', '../notes.md'))
      .toBe('/home/me/notes.md')
  })
})
