export type MainFinishChanges =
  | { ok: true; vcs: 'svn' | 'git' | null; paths: readonly string[] }
  | { ok: false; detail: string }

/**
 * What the composing process supplies to the Finish of a main-copy session: it owns the file
 * changes, the terminal and the commit reviews. Bound with `SessionManager.setMainFinishPort`.
 */
export interface MainFinishPort {
  /** The files the session's own transcript changed that its working copy still shows changed. */
  changes(sessionId: string): Promise<MainFinishChanges>
  /** The configured line that asks the agent to commit to this VCS. */
  command(vcs: 'svn' | 'git'): string
  /** Puts the line into the agent's composer and proves the submit; the refusal sentence, or null. */
  deliver(sessionId: string, text: string, input: 'typed' | 'paste'): Promise<string | null>
  /** A commit review this session opened is still open. */
  reviewPending(sessionId: string): boolean
}
