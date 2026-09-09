import { describe, expect, it } from 'vitest'

import { FileViewerZoom } from './fileViewerZoom'

describe('app-client-ui/renderer/fileViewer/fileViewerZoom', () => {
  it('walks the ladder and stops at both ends', () => {
    expect(FileViewerZoom.larger(100)).to.equal(110)
    expect(FileViewerZoom.smaller(100)).to.equal(90)
    expect(FileViewerZoom.larger(300)).to.equal(300)
    expect(FileViewerZoom.smaller(50)).to.equal(50)
    expect(FileViewerZoom.isLargest(300)).to.equal(true)
    expect(FileViewerZoom.isSmallest(50)).to.equal(true)
    expect(FileViewerZoom.isLargest(100)).to.equal(false)
  })

  it('snaps a value between two rungs instead of dropping it to the default', () => {
    // A layout may be edited by hand, and someone who wrote 130 asked for a bigger document, not
    // for the size they already had.
    expect(FileViewerZoom.read(130)).to.equal(125)
    expect(FileViewerZoom.read(1000)).to.equal(300)
    expect(FileViewerZoom.larger(130)).to.equal(150)
    expect(FileViewerZoom.smaller(130)).to.equal(110)
  })

  it('reads anything that is not a number as the configured size', () => {
    expect(FileViewerZoom.read(undefined)).to.equal(100)
    expect(FileViewerZoom.read('150')).to.equal(100)
    expect(FileViewerZoom.read(Number.NaN)).to.equal(100)
    expect(FileViewerZoom.scaleOf(100)).to.equal('1')
    expect(FileViewerZoom.scaleOf(150)).to.equal('1.5')
  })
})
