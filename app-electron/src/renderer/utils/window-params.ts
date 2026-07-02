export function getWindowId(): string {
  const match = window.location.hash.match(/windowId=([^&]+)/)
  return match ? match[1] : '0'
}

export function getGroupName(): string | null {
  const match = window.location.hash.match(/groupName=([^&]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

export function getGroupColor(): string | null {
  const match = window.location.hash.match(/groupColor=([^&]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

export function isNewWindow(): boolean {
  return window.location.hash.includes('new=1')
}

/** A file path passed to a freshly-opened window (`file=` hash) — opened as a FileViewerPanel on boot. */
export function getInitialFile(): string | null {
  const match = window.location.hash.match(/file=([^&]+)/)
  return match ? decodeURIComponent(match[1]) : null
}
