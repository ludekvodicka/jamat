export interface CodexSessionIdentity {
  schemaVersion: 1
  jamatSessionId: string
  launchId: string
  nativeSessionId: string
  sequence: number
}

export interface CodexSessionCommand {
  command: string
  prefixArgs: string[]
  args: string[]
}

export interface CodexSessionLaunch {
  schemaVersion: 1
  jamatSessionId: string
  launchId: string
  mode: 'new' | 'resume' | 'fork' | 'continue'
  nativeSessionId?: string
  forkParentId?: string
  cwd: string
  receiptFile: string
  yolo?: boolean
  client: CodexSessionCommand
  server: CodexSessionCommand
}
