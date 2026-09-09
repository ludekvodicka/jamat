import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AppClientUiBridge } from '../../shared/appClientUiIpc'
import { FileHtmlPage, FileHtmlView } from './fileHtmlView'

describe('app-client-ui/renderer/fileViewer/fileHtmlView', () => {
  const asked: string[] = []
  let granted: string | null = 'resource-1'

  beforeEach(() => {
    asked.length = 0
    granted = 'resource-1'
    const bridge = {
      fileViewer: {
        relativeResource: (documentId: string, reference: string) => {
          asked.push(`${documentId}:${reference}`)
          return Promise.resolve(granted === null
            ? {
              ok: true as const,
              value: { ok: false as const, code: 'outside-root', detail: 'outside' },
            }
            : {
              ok: true as const,
              value: {
                ok: true as const,
                value: { resourceId: granted, mimeType: 'image/png', size: 1, contentVersion: '1' },
              },
            })
        },
      },
    }
    ;(window as unknown as { appClient: AppClientUiBridge })
      .appClient = bridge as unknown as AppClientUiBridge
  })

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  /** The frame is the whole point: a page's `body { }` would otherwise restyle the app around it. */
  it('draws the page in a sandboxed frame that may do nothing at all', async () => {
    const view = render(
      <FileHtmlView documentId="document-1" name="report.html" source="<h1>Report</h1>" />,
    )

    const frame = await waitFor(() => {
      const found = view.container.querySelector('iframe')
      if (found === null) throw new Error('the frame is not drawn yet')
      return found
    })
    expect(frame.getAttribute('sandbox')).to.equal('')
    expect(frame.getAttribute('class')).to.equal('file-viewer-html')
    expect(frame.getAttribute('srcdoc')).to.contain('<h1>Report</h1>')
  })

  it('answers with a whole document the page cannot re-root or run', async () => {
    const page = await FileHtmlPage.of(
      '<html><head><base href="https://x/"><style>.card{color:red}</style></head>'
      + '<body><script>alert(1)</script><p>Body</p></body></html>',
      'document-1',
    )

    expect(page.startsWith('<!doctype html><html')).to.equal(true)
    expect(page).to.contain('Body')
    expect(page).to.contain('.card{color:red}')
    expect(page).to.not.match(/script|<base/i)
  })

  /**
   * The page's own rules have to win over the ground this puts under it, or a report that styles
   * itself would be drawn on the wrong background - so the base style goes in FIRST, not last.
   */
  it('puts a readable ground under the page and lets the page overrule it', async () => {
    const page = await FileHtmlPage.of(
      '<html><head><style>html{background:teal}</style></head><body>x</body></html>',
      'document-1',
    )

    const base = page.indexOf(FileHtmlPage.baseStyleConst)
    expect(base).to.be.greaterThan(-1)
    expect(base).to.be.lessThan(page.indexOf('html{background:teal}'))
  })

  /**
   * The same grant the markdown renderer takes, so main resolves the reference against the
   * document's own directory and refuses anything outside it. Everything else loses its `src`
   * rather than being fetched: the frame has no network of its own and no page may give it one.
   */
  it('grants a picture beside the file, keeps an embedded one and drops every other source',
    async () => {
      const page = await FileHtmlPage.of(
        '<body><img src="pictures/plot.png"><img src="data:image/png;base64,AAAA">'
        + '<img src="https://example.test/track.png"><img src="a.png" srcset="b.png 2x">'
        + '<video src="clip.mp4"></video></body>',
        'document-1',
      )

      expect(asked).to.deep.equal(['document-1:pictures/plot.png', 'document-1:a.png'])
      expect(page).to.contain('src="jamat-v3-file://resource/resource-1"')
      expect(page).to.contain('src="data:image/png;base64,AAAA"')
      expect(page).to.not.contain('example.test')
      expect(page).to.not.contain('srcset')
      expect(page).to.not.contain('clip.mp4')
    })

  it('drops the picture a refused grant left behind rather than drawing a broken one', async () => {
    granted = null

    const page = await FileHtmlPage.of('<body><img src="pictures/plot.png" alt="Plot"></body>',
      'document-1')

    expect(page).to.not.contain('pictures/plot.png')
    expect(page).to.contain('alt="Plot"')
  })
})
