export class FileViewerProtocolUrl {
  static readonly scheme = 'jamat-v3-file'
  static readonly htmlScheme = 'jamat-v3-html'

  static resource(resourceId: string): string {
    return `${FileViewerProtocolUrl.scheme}://resource/${encodeURIComponent(resourceId)}`
  }

  static html(previewId: string): string {
    return `${FileViewerProtocolUrl.htmlScheme}://${encodeURIComponent(previewId)}/`
  }

  static isHtmlUrl(value: string): boolean {
    try {
      const url = new URL(value)
      return url.protocol === `${FileViewerProtocolUrl.htmlScheme}:`
        && url.hostname.length > 0
        && url.pathname === '/'
    } catch {
      return false
    }
  }
}
