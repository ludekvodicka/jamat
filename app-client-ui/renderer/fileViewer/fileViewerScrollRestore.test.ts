import { describe, expect, it } from 'vitest'

import { FileViewerDisclosures, FileViewerPlace } from './fileViewerScrollRestore'

class FileViewerDisclosuresHarness {
  static body(summaries: readonly string[]): HTMLElement {
    const body = document.createElement('div')
    for (const summary of summaries) {
      const details = document.createElement('details')
      details.append(Object.assign(document.createElement('summary'), { textContent: summary }), 'content')
      body.append(details)
    }
    return body
  }

  static open(body: HTMLElement): boolean[] {
    return [...body.querySelectorAll('details')].map((details) => details.open)
  }
}

describe('app-client-ui/renderer/fileViewer/fileViewerScrollRestore', () => {
  it('reopens sections by summary and occurrence after an edit inserts one above them', () => {
    const before = FileViewerDisclosuresHarness.body(['Guide', 'Step', 'Step'])
    before.querySelectorAll('details')[2]!.open = true
    const open = FileViewerDisclosures.of(before)

    const after = FileViewerDisclosuresHarness.body(['New', 'Guide', 'Step', 'Step'])
    FileViewerDisclosures.apply(after, open)

    expect(FileViewerDisclosuresHarness.open(after)).toEqual([false, false, false, true])
  })

  it('closes a section the reader closed and leaves an unknown one as drawn', () => {
    const before = FileViewerDisclosuresHarness.body(['Guide'])
    const open = FileViewerDisclosures.of(before)
    const after = FileViewerDisclosuresHarness.body(['Guide', 'Fresh'])
    for (const details of after.querySelectorAll('details')) details.open = true

    FileViewerDisclosures.apply(after, open)

    expect(FileViewerDisclosuresHarness.open(after)).toEqual([false, true])
  })

  it('keeps no place for the top of a visit and the offset of a reload taken there', () => {
    expect(FileViewerPlace.at(undefined)).toBeUndefined()
    expect(FileViewerPlace.of(null)).toBeUndefined()
    expect(FileViewerPlace.of(FileViewerDisclosuresHarness.body([]))?.scrollTop).toBe(0)
  })
})
