export class ReleaseFeed {
  async text(url: string, signal: AbortSignal, maxBytes = 65_536): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
    if (!response.ok) throw new Error(`Release check failed: HTTP ${response.status}`)
    const text = await response.text()
    if (text.length > maxBytes) throw new Error('Release response is too large')
    return text.trim()
  }
}
