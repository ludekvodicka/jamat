import type {
  FileChangesVcsDetection,
  FileChangesVcsId,
  FileChangesVcsResult,
} from './fileChangesManagerApi.types'
import type {
  FileChangesVcs,
} from './vcs/fileChangesVcs.types'
import { FileChangesVcsDetector } from './vcs/fileChangesVcsDetector'
import { FileChangesVcsGit } from './vcs/fileChangesVcsGit'
import { FileChangesVcsSvn } from './vcs/fileChangesVcsSvn'

/**
 * The subsystem's second surface, beside the facade and the wire types: which VCS governs a
 * directory, and whether that directory has anything uncommitted. `catalogView.ts` in the project
 * manager is the precedent - a root file that lets another subsystem stop importing `vcs/`
 * internals, without `vcs/` itself moving anywhere.
 *
 * That claim was only half true until 2026-08-23: the two types this hands out and takes back,
 * `FileChangesVcsDetection` and `FileChangesVcsResult`, lived inside `vcs/`, so every consumer had
 * to import the internals anyway to name them. They sit on the wire types now, which is what makes
 * the sentence above check out - `grep` for `fileChangesManager/vcs/` outside this subsystem finds
 * nothing.
 *
 * It owns NOTHING. No timer, no cache, no memo, not even a detection remembered between calls: the
 * facade's written rule is that this subsystem watches nothing and every read is initiated by its
 * caller, and a cache here would be the first thing to break it. How often to ask, and what to
 * remember of the answer, belongs to whoever calls - today `sessionManager/vcsFacts/`.
 */
export class VcsStatusView {
  private readonly adapters: readonly FileChangesVcs[]
  private readonly detector: FileChangesVcsDetector

  constructor(adapters?: readonly FileChangesVcs[]) {
    this.adapters = adapters ?? [new FileChangesVcsGit(), new FileChangesVcsSvn()]
    this.detector = new FileChangesVcsDetector(this.adapters)
  }

  /**
   * Null is "no VCS governs this directory", which is a measurement like any other - the caller is
   * expected to remember it rather than ask again on the next tick.
   */
  async detect(cwd: string, preferred: FileChangesVcsId): Promise<FileChangesVcsDetection | null> {
    const selection = await this.detector.select(cwd, preferred)
    return selection.selected?.detection ?? null
  }

  async dirty(detection: FileChangesVcsDetection): Promise<FileChangesVcsResult<boolean>> {
    const adapter = this.adapters.find((candidate) => candidate.id === detection.id)
    if (adapter === undefined)
      throw new Error(`Unknown VCS id: ${JSON.stringify(detection.id)}`)
    return adapter.dirty(detection)
  }
}
