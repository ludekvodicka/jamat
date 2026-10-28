export type FileMediaMetadata = { kind: 'ready'; mimeType: string; size: number; version: string } | { kind: 'missing' | 'changed' }

export interface FileMediaSource {
  metadata(token: string): Promise<FileMediaMetadata>
  read(token: string, version: string, offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>
}
