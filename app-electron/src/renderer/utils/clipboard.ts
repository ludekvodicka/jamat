/**
 * Renderer clipboard helpers.
 *
 * The packaged app loads the renderer from a `file://` URL, where the async `navigator.clipboard`
 * API is gated by Electron's permission / secure-origin handling and silently rejects — copy/paste
 * then no-ops in production while still "working" in dev (dev serves the renderer over
 * http://localhost, a secure origin where the API is granted). So route through the main-process
 * Electron `clipboard` module (a native API, independent of web security / focus / permissions),
 * exposed on the preload bridge. Fall back to `navigator.clipboard` only where the bridge is absent
 * (e.g. a non-Electron host embedding a component).
 */

export async function copyText(text: string): Promise<void> {
  const api = window.electronAPI
  if (api?.writeClipboard) {
    try { await api.writeClipboard(text); return } catch { /* fall through to navigator */ }
  }
  try { await navigator.clipboard?.writeText(text) } catch { /* clipboard blocked — ignore */ }
}

export async function readClipboard(): Promise<string> {
  const api = window.electronAPI
  if (api?.readClipboard) {
    try { return await api.readClipboard() } catch { /* fall through to navigator */ }
  }
  try { return (await navigator.clipboard?.readText()) ?? '' } catch { return '' }
}
