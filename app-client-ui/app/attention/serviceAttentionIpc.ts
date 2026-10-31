import { ServiceIpcBase } from '../shared/serviceIpcBase'
import type { AttentionQueue } from './attentionQueue'

export class ServiceAttentionIpc extends ServiceIpcBase<typeof ServiceAttentionIpc.channelsConst> {
  static readonly channelsConst = {
    'attention:get': true,
    'attention:next': true,
  } as const
  private readonly queue: Pick<AttentionQueue, 'snapshot' | 'next'>

  constructor(queue: Pick<AttentionQueue, 'snapshot' | 'next'>) {
    super()
    this.queue = queue
  }

  initialize(): void {
    this.register('attention:get', () => this.queue.snapshot())
    this.register('attention:next', () => this.queue.next())
    this.assertComplete(ServiceAttentionIpc.channelsConst)
  }
}
