import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('uses injected remote resource grants and retains denied-image sanitization', async () => {
    const html = await FileHtmlPage.of('<img src="good.png"><img src="../denied.png"><script>bad()</script>', 'remote-document', {
      relativeResource: async (_id, reference) => reference === 'good.png'
        ? { ok: true, value: { ok: true, value: { resourceId: 'remote-token', size: 1, contentVersion: 'v', mimeType: 'image/png' } } }
        : { ok: true, value: { ok: false, code: 'outside-root', detail: 'Denied' } },
    })
    expect(html).toContain('jamat-v3-file://resource/remote-token')
    expect(html).not.toContain('../denied.png')
    expect(html).not.toContain('<script')
    expect(asked).toEqual([])
  })

  afterEach(() => {
    cleanup()
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  /** The frame is the whole point: a page's `body { }` would otherwise restyle the app around it. */
  it('draws the page in a sandboxed frame that may do nothing at all', async () => {
    const view = render(
      <FileHtmlView ports={window.appClient.fileViewer} documentId="document-1" name="report.html" source="<h1>Report</h1>" />,
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
      'document-1', window.appClient.fileViewer,
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
      'document-1', window.appClient.fileViewer,
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
        'document-1', window.appClient.fileViewer,
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
      'document-1', window.appClient.fileViewer)

    expect(page).to.not.contain('pictures/plot.png')
    expect(page).to.contain('alt="Plot"')
  })

  it('detects inline scripts and event handlers without mistaking static markup for scripts', () => {
    expect(FileHtmlPage.hasScripts('<h1>Static</h1>')).toBe(false)
    expect(FileHtmlPage.hasScripts('<h1>Page</h1><script>render()</script>')).toBe(true)
    expect(FileHtmlPage.hasScripts('<button onclick="go()">Go</button>')).toBe(true)
  })

  it('keeps inline scripts and handlers when scripted mode is enabled while still stripping network and frame tags', async () => {
    const page = await FileHtmlPage.scripted(
      '<html><head><base href="https://x/"><link rel="stylesheet" href="https://x/a.css">'
      + '<meta charset="utf-8"><meta http-equiv="refresh" content="0;url=https://x/"></head>'
      + '<body><iframe src="https://x/"></iframe><img src="plot.png"><script src="https://x/a.js"></script>'
      + '<script>window.x = 1</script><button onclick="go()">Go</button></body></html>',
      'document-1', window.appClient.fileViewer,
    )

    expect(page).toContain('window.x = 1')
    expect(page).toContain('onclick="go()"')
    expect(page).toContain('src="jamat-v3-file://resource/resource-1"')
    expect(page).toContain('charset="utf-8"')
    expect(page).not.toMatch(/<base|<link|<iframe|http-equiv|https:\/\/x\//i)
  })

  it('shows a scripts-disabled banner when scripts are blocked and switches to an isolated protocol frame when allowed', async () => {
    const registerHtmlPreview = vi.fn(async (_html: string) => ({ ok: true as const, value: 'preview-1' }))
    const releaseHtmlPreview = vi.fn(async (_previewId: string) => ({ ok: true as const, value: undefined }))
    const onAllowScriptsChange = vi.fn()

    const view = render(
      <FileHtmlView
        ports={window.appClient.fileViewer}
        documentId="document-1"
        name="proto.html"
        source="<h1>Proto</h1><script>render()</script>"
        allowScripts={false}
        onAllowScriptsChange={onAllowScriptsChange}
        preview={{ registerHtmlPreview, releaseHtmlPreview }}
      />,
    )

    const staticFrame = await waitFor(() => {
      const found = view.container.querySelector('iframe')
      if (found === null) throw new Error('the frame is not drawn yet')
      return found
    })
    expect(staticFrame.getAttribute('sandbox')).toBe('')
    expect(staticFrame.getAttribute('srcdoc')).not.toContain('<script')
    expect(view.getByText('Scripts are disabled in this preview.')).toBeInTheDocument()

    fireEvent.click(view.getByRole('button', { name: 'Enable scripts' }))
    expect(onAllowScriptsChange).toHaveBeenCalledExactlyOnceWith(true)

    view.rerender(
      <FileHtmlView
        ports={window.appClient.fileViewer}
        documentId="document-1"
        name="proto.html"
        source="<h1>Proto</h1><script>render()</script>"
        allowScripts
        onAllowScriptsChange={onAllowScriptsChange}
        preview={{ registerHtmlPreview, releaseHtmlPreview }}
      />,
    )

    const scriptedFrame = await waitFor(() => {
      const found = view.container.querySelector('iframe')
      if (found === null || !found.getAttribute('src')) throw new Error('scripted frame not ready')
      return found
    })
    expect(registerHtmlPreview).toHaveBeenCalledTimes(1)
    expect(registerHtmlPreview.mock.calls[0]![0]).toContain('<script>render()</script>')
    expect(scriptedFrame.getAttribute('src')).toBe('jamat-v3-html://preview-1/')
    expect(scriptedFrame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin')
    expect(scriptedFrame.hasAttribute('srcdoc')).toBe(false)
    expect(view.queryByText('Scripts are disabled in this preview.')).toBeNull()

    view.unmount()
    expect(releaseHtmlPreview).toHaveBeenCalledExactlyOnceWith('preview-1')
  })

  it('releases a late preview registration when unmounted before main answers', async () => {
    let finish!: (value: { ok: true; value: string }) => void
    const registerHtmlPreview = vi.fn(() => new Promise<{ ok: true; value: string }>((resolve) => { finish = resolve }))
    const releaseHtmlPreview = vi.fn(async () => ({ ok: true as const, value: undefined }))

    const view = render(
      <FileHtmlView
        ports={window.appClient.fileViewer}
        documentId="document-1"
        name="proto.html"
        source="<script>render()</script>"
        allowScripts
        preview={{ registerHtmlPreview, releaseHtmlPreview }}
      />,
    )
    await waitFor(() => expect(registerHtmlPreview).toHaveBeenCalledTimes(1))
    view.unmount()
    await act(async () => finish({ ok: true, value: 'late-preview' }))
    expect(releaseHtmlPreview).toHaveBeenCalledExactlyOnceWith('late-preview')
  })
})
