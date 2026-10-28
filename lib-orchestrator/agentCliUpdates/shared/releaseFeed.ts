export class ReleaseFeed {
  async text(url: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
    if (!response.ok) throw new Error(`Release check failed: HTTP ${response.status}`)
    const text = await response.text()
    if (text.length > 65_536) throw new Error('Release response is too large')
    return text.trim()
  }
}
