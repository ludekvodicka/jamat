export class CodexLaunchPermissions {
  private readonly yolo: boolean
  private pending: boolean

  constructor(yolo: boolean) {
    this.yolo = yolo
    this.pending = yolo
  }

  request(value: unknown): unknown {
    if (!this.yolo || value === null || typeof value !== 'object' || Array.isArray(value)) return value
    const message = value as Record<string, unknown>
    if (!this.pending && message.method !== 'thread/start') return value
    if (typeof message.id !== 'string' && typeof message.id !== 'number') return value
    if (message.method !== 'thread/start' && message.method !== 'thread/resume'
      && message.method !== 'thread/fork') return value
    if (message.params === null || typeof message.params !== 'object' || Array.isArray(message.params)) return value
    const original = message.params as Record<string, unknown>
    if (original.threadSource != null && original.threadSource !== 'user') return value
    const params: Record<string, unknown> = {
      ...original, approvalPolicy: 'never', sandbox: 'danger-full-access',
    }
    // Named profiles and the legacy sandbox field are mutually exclusive in the native protocol.
    delete params.permissions
    return {...message, params}
  }

  confirmed(): void {
    // Later resumes/forks preserve native choices; /new uses this launch's defaults again.
    this.pending = false
  }
}
