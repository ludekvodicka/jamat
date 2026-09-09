export class FileViewerProtocolUrl {
  static readonly scheme = 'jamat-v3-file'

  static resource(resourceId: string): string {
    return `${FileViewerProtocolUrl.scheme}://resource/${encodeURIComponent(resourceId)}`
  }
}
