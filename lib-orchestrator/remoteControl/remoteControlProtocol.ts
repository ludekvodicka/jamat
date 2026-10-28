/**
 * The control protocol as VALUES: its name, the operations it admits, which of them mutate, the
 * error codes and the sizes it will read.
 *
 * Beside `remoteControlApi.types.ts` rather than inside it, because a `.types.ts` erases and this
 * does not. Seventeen files imported the protocol name and the operation lists out of a module whose
 * name says it carries no runtime, which is the one thing a reader takes from that suffix.
 *
 * The types derived from these lists stay in the types file and read them back through `import
 * type`, so that file still compiles to nothing.
 */

export class RemoteControlConst {
  static readonly protocol = 'appjamat-v3-control.v1' as const
  static readonly descriptorOperations = [
    'system.hello',
    'system.status',
    'projects.list',
    'sessions.list',
    'sessions.create',
    'sessions.reopen',
    'sessions.finalize',
    'tabs.list',
    'tabs.open',
    'tabs.focus',
    'tabs.close',
    'terminal.peek',
    'terminal.send',
  ] as const
  static readonly optionalOperations = [
    'system.operations',
    'system.calls',
    'system.events',
    'tabs.commitStatus',
    'tabs.cancelCommit',
    'tabs.openFile',
    'tabs.openCommit',
    'sessions.transcript',
    'agents.describe',
    'accounts.list',
    'sessions.color',
    'sessions.group',
    'sessions.note',
    'sessions.setNote',
    'terminal.deliver',
    'sessions.remove',
    'sessions.worktree',
    'sessions.discardWorktree',
    'sessions.retrySetup',
    'sessions.cleanupWorktree',
    'sessions.fork',
    'sessions.restart', 'sessions.switchAccount',
    'sessions.setDetails',
    'sessions.adoptOrphan',
    'sessions.reference',
    'sessions.historyReferences',
    'sessions.openHistory',
    'sessions.nextNumber',
    'sessions.worktreePreview',
    'sessions.allocateNumber',
    'host.status',
    'host.ping',
    'host.start',
    'host.restart',
    'host.stop',
    'projects.config',
    'projects.saveConfig',
    'projects.categories',
    'projects.listing',
    'projects.sessions',
    'projects.create',
    'projects.rename',
    'projects.movePrefix',
    'projects.archive',
    'projects.deletePreview',
    'projects.delete',
    'sessions.scripts',
    'sessions.clearActions',
    'sessions.runScript',
    'sessions.finishWorktree',
    'sessions.updateMain',
    'sessions.worktreeReview',
    'sessions.worktreeResults',
    'sessions.notifies',
    'sessions.children',
    'sessions.acknowledgeWorktreeResult',
    'sessions.proposeCommit',
    'sessions.conflicts',
    'sessions.sync',
    'sessions.resolveConflict',
    'sessions.solveWithAgent',
    'sessions.backToWork',
  ] as const
  static readonly operations = RemoteControlConst.descriptorOperations
  static readonly mutatingOperations = [
    'tabs.cancelCommit',
    'sessions.create',
    'sessions.reopen',
    'sessions.finalize',
    'sessions.remove',
    'sessions.discardWorktree',
    'sessions.retrySetup',
    'sessions.cleanupWorktree',
    'sessions.fork',
    'sessions.restart', 'sessions.switchAccount',
    'sessions.setDetails',
    'sessions.adoptOrphan',
    'sessions.openHistory',
    'sessions.allocateNumber',
    'host.start',
    'host.restart',
    'host.stop',
    'projects.saveConfig',
    'projects.create',
    'projects.rename',
    'projects.movePrefix',
    'projects.archive',
    'projects.deletePreview',
    'projects.delete',
    'sessions.color',
    'sessions.group',
    'sessions.setNote',
    'tabs.open',
    'tabs.openFile',
    'tabs.openCommit',
    'tabs.focus',
    'tabs.close',
    'terminal.send',
    'terminal.deliver',
    'sessions.clearActions',
    'sessions.runScript',
    'sessions.finishWorktree',
    'sessions.updateMain',
    'sessions.worktreeReview',
    'sessions.acknowledgeWorktreeResult',
    'sessions.proposeCommit',
    'sessions.sync',
    'sessions.resolveConflict',
    'sessions.solveWithAgent',
    'sessions.backToWork',
  ] as const
  static readonly socketOperations = [
    'events.subscribe',
    'terminal.attach',
    'terminal.input',
    'terminal.resize',
    'terminal.active',
    'terminal.detach',
    'terminal.pasteImage',
    'terminal.pasteFile',
  ] as const
  /**
   * Every failure this protocol can name. The LIST is the source and the type is read off it, so a
   * new code cannot be added to one and forgotten in the others: the validator that accepts codes,
   * the HTTP status map and the CLI exit map all fail to compile until each names it.
   */
  static readonly errorCodes = [
    'invalid-request',
    'protocol-mismatch',
    'forbidden',
    'not-found',
    'conflict',
    'unavailable',
    'timeout',
    'operation-failed',
  ] as const
}

/**
 * The bounds of one `terminal.deliver`. The typed cap keeps a wrapped draft inside the composer
 * reader's 16-row window at 80 columns; a paste collapses to a placeholder and has no such limit.
 */
export class RemoteControlDeliverConst {
  static readonly textLengthConst = 800
  static readonly readyTimeoutMillisecondsConst = 45_000
  static readonly readyTimeoutMinimumMillisecondsConst = 1_000
  static readonly readyTimeoutMaximumMillisecondsConst = 120_000
  static readonly submitTimeoutMillisecondsConst = 10_000
  static readonly submitTimeoutMinimumMillisecondsConst = 1_000
  static readonly submitTimeoutMaximumMillisecondsConst = 60_000
  static readonly composeTimeoutMillisecondsConst = 5_000
}

/**
 * The bounds of one `terminal.pasteImage`. The image rides in one sealed peer frame as base64, and
 * the frame's plaintext is capped at 1 MiB (`RemoteControlPeerConst.maximumPlaintextBytes`), so the
 * sender shrinks a larger image to fit rather than splitting it.
 */
export class RemoteControlPasteImageConst {
  static readonly bytesMaxConst = 720 * 1_024
  static readonly base64LengthMaxConst = Math.ceil(RemoteControlPasteImageConst.bytesMaxConst / 3) * 4
}

/**
 * The bounds of `terminal.pasteFile`. A file larger than one sealed peer frame goes as chunks, sent
 * one at a time from offset 0; past the file limit nothing is sent and the local path is pasted.
 */
export class RemoteControlPasteFileConst {
  static readonly bytesMaxConst = 20 * 1_024 * 1_024
  static readonly chunkBytesConst = 512 * 1_024
  static readonly chunkBase64LengthMaxConst = Math.ceil(RemoteControlPasteFileConst.chunkBytesConst / 3) * 4
  static readonly fileNameLengthConst = 255
  static readonly uploadIdLengthConst = 64
}

export class RemoteControlCapabilities {
  static of(descriptor: {
    operations: readonly string[]
    optionalOperations?: readonly string[]
    registryOperations?: readonly string[]
  }): readonly string[] {
    return [...descriptor.operations, ...(descriptor.optionalOperations ?? []), ...(descriptor.registryOperations ?? [])]
  }

  /**
   * The optional operations of a list that this build knows, in order. A newer client may offer more;
   * this build cannot call them, so they are dropped rather than refusing the client that offers them.
   */
  static known(names: readonly string[]): string[] {
    const known: readonly string[] = RemoteControlConst.optionalOperations
    return names.filter((name) => known.includes(name))
  }
}

export class RemoteControlLocalConst {
  static readonly operations = [
    'remote.computers.list',
    'remote.pairing.export',
    'remote.pairing.import',
  ] as const
  static readonly mutatingOperations = ['remote.pairing.import'] as const
}
