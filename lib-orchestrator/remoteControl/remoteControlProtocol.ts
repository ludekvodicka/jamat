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
    'tabs.openFile',
    'tabs.openCommit',
    'sessions.transcript',
    'agents.describe',
  ] as const
  static readonly operations = RemoteControlConst.descriptorOperations
  static readonly mutatingOperations = [
    'sessions.create',
    'sessions.reopen',
    'sessions.finalize',
    'tabs.open',
    'tabs.openFile',
    'tabs.openCommit',
    'tabs.focus',
    'tabs.close',
    'terminal.send',
  ] as const
  static readonly socketOperations = [
    'events.subscribe',
    'terminal.attach',
    'terminal.input',
    'terminal.resize',
    'terminal.active',
    'terminal.detach',
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

export class RemoteControlCapabilities {
  static of(descriptor: {
    operations: readonly string[]
    optionalOperations?: readonly string[]
  }): readonly string[] {
    return [...descriptor.operations, ...(descriptor.optionalOperations ?? [])]
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
