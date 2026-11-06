import { BrowserWindow, session, type Session } from 'electron'

/**
 * HTML printed to an A4 PDF by Chromium in a hidden window that runs no script and loads nothing
 * but the page itself: the HTML comes from a renderer, so its links and any reference it carries
 * must not reach the network or the disk while it is printed.
 */
export class DocumentPdfPrinter {
  private static readonly partitionConst = 'jamat-document-export'
  private isolated: Session | null = null

  async print(html: string): Promise<Uint8Array> {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { session: this.session(), javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    try {
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', event => event.preventDefault())
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      return await window.webContents.printToPDF({ pageSize: 'A4', printBackground: true,
        margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } })
    } finally {
      window.destroy()
    }
  }

  /** In memory (no `persist:` prefix), and every request except the page's own data URL is cancelled. */
  private session(): Session {
    if (this.isolated === null) {
      this.isolated = session.fromPartition(DocumentPdfPrinter.partitionConst)
      this.isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') }))
    }
    return this.isolated
  }
}
