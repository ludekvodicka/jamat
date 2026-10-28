export class CommitDraftBuffer {
  static read(identity: string): { message: string; source: 'restored-draft'; at: number } | null {
    const value = localStorage.getItem(`commit-unsent:${identity}`)
    if (value === null) return null
    let message = value
    let at = 0
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed !== null && typeof parsed === 'object' && 'message' in parsed && typeof parsed.message === 'string') {
        message = parsed.message
        if ('at' in parsed && typeof parsed.at === 'number') at = parsed.at
      }
    } catch { /* Older buffers held the text directly. */ }
    return message.length <= 16_384 ? { message, source: 'restored-draft', at } : null
  }

  static write(identity: string, message: string | null): void {
    if (message === null) localStorage.removeItem(`commit-unsent:${identity}`)
    else localStorage.setItem(`commit-unsent:${identity}`, JSON.stringify({ message, source: 'restored-draft', at: Date.now() }))
  }
}
