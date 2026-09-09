import type {
  FileChangesVcsDetection,
  FileChangesVcsId,
} from '../fileChangesManagerApi.types'
import type {
  FileChangesVcs,
} from './fileChangesVcs.types'

export interface FileChangesVcsSelectionInternal {
  requested: FileChangesVcsId
  selected: { adapter: FileChangesVcs; detection: FileChangesVcsDetection } | null
  available: readonly { adapter: FileChangesVcs; detection: FileChangesVcsDetection }[]
  fallbackReason: string | null
}

export class FileChangesVcsDetector {
  constructor(private readonly adapters: readonly FileChangesVcs[]) {}

  async select(cwd: string, preferred: FileChangesVcsId): Promise<FileChangesVcsSelectionInternal> {
    const detections = await Promise.all(this.adapters.map(async (adapter) => ({
      adapter,
      detection: await adapter.detect(cwd).catch(() => null),
    })))
    const available = detections.flatMap((item) => item.detection === null
      ? []
      : [{ adapter: item.adapter, detection: item.detection }])
    const selected = available.find((item) => item.adapter.id === preferred) ?? available[0] ?? null
    return {
      requested: preferred,
      selected,
      available,
      fallbackReason: selected !== null && selected.adapter.id !== preferred
        ? `${preferred} is not available in ${cwd}; using ${selected.adapter.id}`
        : null,
    }
  }
}
