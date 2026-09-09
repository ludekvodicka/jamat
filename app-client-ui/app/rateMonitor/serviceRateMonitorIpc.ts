import type { RateMonitor } from '../../../lib-orchestrator/rateMonitor/rateMonitor'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

/**
 * The RateMonitor's share of the named allowlist: what both providers last said, one manual read,
 * and the unreduced view the Debug window draws.
 *
 * Three delegations and nothing composed here, deliberately. Everything a caller could get wrong is
 * already the library's: the floor holds for the manual refresh too, so a widget nobody can stop
 * clicking costs the endpoint one request per floor whatever this service does, and both answers are
 * built field by field over there - a value this class reshaped would be a value that could carry
 * something the wire types have no field for.
 */
export class ServiceRateMonitorIpc
  extends ServiceIpcBase<typeof ServiceRateMonitorIpc.channelsConst> {
  static readonly channelsConst = {
    'rate:get': true,
    'rate:refresh': true,
    'rate:debug-status': true,
  } as const

  constructor(private readonly rateMonitor: RateMonitor) {
    super()
  }

  initialize(): void {
    this.register('rate:get', () => this.rateMonitor.snapshot())
    this.register('rate:refresh', () => this.rateMonitor.refresh())
    this.register('rate:debug-status', () => this.rateMonitor.debugStatus())
    this.assertComplete(ServiceRateMonitorIpc.channelsConst)
  }
}
