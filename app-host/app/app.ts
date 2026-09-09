import { AppConfig } from './appConfig.js'
import { AppContext } from './appContext.js'
import { AppHub } from './appHub.js'
import { HostDescriptorStore } from './hostRuntime/hostDescriptorStore.js'
import { HostProcessLock } from './hostRuntime/hostProcessLock.js'
import { HostOperationError } from './hostTransport/hostOperationError.js'
import { HostOperationRouter } from './hostTransport/hostOperationRouter.js'
import { HostTransport } from './hostTransport/hostTransport.js'
import {
  HostWireConst,
  type HostDescriptor,
  type HostHello,
  type HostStopReq,
} from './wire/hostWire.js'

export class AppHost {
  private static readonly drainTimeoutMsConst = 4_000
  private readonly context: AppContext
  private readonly lock: HostProcessLock
  private readonly descriptor: HostDescriptorStore
  private readonly router = new HostOperationRouter()
  private readonly hub: AppHub
  private readonly transport: HostTransport
  private shuttingDown = false
  private ownsLock = false

  private constructor(private readonly config: AppConfig) {
    this.context = new AppContext(config)
    this.lock = new HostProcessLock(
      config.identity.configIdentity,
      config.runtimeChannel,
      {
        pid: process.pid,
        processStartedAt: this.context.processStartedAt,
        hostInstanceId: this.context.hostInstanceId,
      },
    )
    this.descriptor = new HostDescriptorStore(
      config.identity.configIdentity,
      config.runtimeChannel,
    )
    this.hub = new AppHub(this.context)
    this.transport = new HostTransport(
      this.context.token,
      this.router,
      {
        hello: () => this.hello(),
        onWebSocket: (webSocket) => this.hub.handleWebSocket(webSocket),
      },
      (message) => this.context.log(message),
    )
  }

  static async run(config: AppConfig): Promise<void> {
    const host = new AppHost(config)
    host.installProcessHandlers()
    await host.start()
  }

  /** The lifetime lock is taken before the descriptor exists, so no client can find a losing Host. */
  private async start(): Promise<void> {
    const lock = this.lock.acquire()
    if (!lock.ok) {
      const holder = lock.holder
        ? `pid ${lock.holder.pid}, instance ${lock.holder.hostInstanceId}`
        : 'unknown process'
      throw new Error(
        `Another AppHost is already running for ${
          this.config.identity.configIdentity}/${this.config.runtimeChannel}: ${holder}`,
      )
    }
    this.ownsLock = true
    this.hub.registerOperations(this.router)
    this.router.register('host.stop', (body) => this.stopOperation(body))
    this.router.assertComplete()
    try {
      const port = await this.transport.start()
      this.descriptor.write(this.buildDescriptor(port))
      this.context.log(
        `listening on 127.0.0.1:${port}; instance ${this.context.hostInstanceId}; `
        + `wire ${HostWireConst.protocolMajor}.${HostWireConst.protocolMinor}`,
      )
    } catch (error) {
      this.lock.release()
      this.ownsLock = false
      throw error
    }
  }

  /**
   * Authority and the force guard are both evaluated INSIDE the mutation queue, so a request cannot
   * stop runtimes after its lease was replaced, nor slip past the guard through a concurrent create.
   */
  private async stopOperation(
    body: Record<string, unknown>,
  ): Promise<{ stopping: true; live: number }> {
    const request = body as unknown as HostStopReq
    if (typeof request.controllerLeaseId !== 'string')
      throw new HostOperationError(400, 'controllerLeaseId is required')
    this.requireController(request.controllerLeaseId)
    let live = 0
    await this.hub.stopAllRuntimes(() => {
      this.requireController(request.controllerLeaseId)
      live = this.hub.liveRuntimeCount()
      if (live > 0 && request.force !== true)
        throw new HostOperationError(409, `${live} live runtime(s); pass force:true`)
      this.hub.publish({ kind: 'host-stopping' })
    })
    setTimeout(() => { void this.shutdown(0) }, 10)
    return { stopping: true, live }
  }

  private requireController(controllerLeaseId: string): void {
    try { this.hub.requireController(controllerLeaseId) }
    catch (error) { throw HostOperationError.conflictFrom(error) }
  }

  private async drainAndShutdown(exitCode: number): Promise<void> {
    if (this.shuttingDown) return
    this.hub.publish({ kind: 'host-stopping' })
    await Promise.race([
      this.hub.stopAllRuntimes(),
      new Promise((resolve) => setTimeout(resolve, AppHost.drainTimeoutMsConst)),
    ])
    await this.shutdown(exitCode)
  }

  private async shutdown(exitCode: number): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.hub.destroy()
    await this.transport.stop()
    this.descriptor.remove()
    if (this.ownsLock) {
      this.lock.release()
      this.ownsLock = false
    }
    this.context.log('stopped')
    process.exit(exitCode)
  }

  private hello(): HostHello {
    return {
      app: 'jamat-host',
      protocol: {
        major: HostWireConst.protocolMajor,
        minor: HostWireConst.protocolMinor,
      },
      capabilities: [...this.context.buildInfo.capabilities],
      buildInfo: this.context.buildInfo,
      configIdentity: this.config.identity.configIdentity,
      runtimeChannel: this.config.runtimeChannel,
      hostGeneration: this.context.hostGeneration,
      process: {
        hostInstanceId: this.context.hostInstanceId,
        pid: process.pid,
        processStartedAt: this.context.processStartedAt,
        payloadHash: this.context.buildInfo.payloadHash,
      },
      runtimes: this.hub.runtimeCounts(),
      eventRevision: this.hub.eventRevision(),
    }
  }

  private buildDescriptor(port: number): HostDescriptor {
    return {
      schemaVersion: 1,
      pid: process.pid,
      processStartedAt: this.context.processStartedAt,
      port,
      token: this.context.token,
      protocol: {
        major: HostWireConst.protocolMajor,
        minor: HostWireConst.protocolMinor,
      },
      capabilities: [...this.context.buildInfo.capabilities],
      hostVersion: this.context.buildInfo.buildVersion,
      payloadHash: this.context.buildInfo.payloadHash,
      configIdentity: this.config.identity.configIdentity,
      runtimeChannel: this.config.runtimeChannel,
      hostInstanceId: this.context.hostInstanceId,
      hostGeneration: this.context.hostGeneration,
      startedAt: this.context.health.startedAt,
    }
  }

  private installProcessHandlers(): void {
    const stop = (): void => { void this.drainAndShutdown(0) }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    process.on('unhandledRejection', (reason) => {
      this.context.log(`ERROR unhandled rejection: ${AppHost.describe(reason)}`)
    })
    process.on('uncaughtException', (error) => {
      this.context.log(`ERROR uncaught: ${AppHost.describe(error)}`)
      // every request and event path is individually guarded, so a throw leaves the runtimes usable;
      // only a Host that can no longer be reached has nothing left to keep alive
      if (!this.transport.listening)
        void this.drainAndShutdown(1)
    })
  }

  private static describe(value: unknown): string {
    return value instanceof Error ? value.stack ?? value.message : String(value)
  }
}
