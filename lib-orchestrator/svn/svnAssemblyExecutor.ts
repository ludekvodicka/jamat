import type { SvnAssembly } from './svnAssembly'

/**
 * Where an assembly read runs. `SvnAssemblyReader` reads in the caller's thread; AppClientUI runs it
 * in a worker thread, because spawning svn and hashing every file of a worktree held its main thread
 * for seconds at a time during every Finish.
 */
export interface SvnAssemblyExecutor {
  read(root: string, freshness: boolean, progress?: (mount: string, files: number) => void): Promise<SvnAssembly>
}
