import type { ConfigSections } from '../../../lib-orchestrator/clientApi/configSections.types'
export type { ConfigSections } from '../../../lib-orchestrator/clientApi/configSections.types'
export class ConfigSectionsCache {
  private value: ConfigSections | null
  constructor() { this.value = null }
  update(value: ConfigSections): void { this.value = structuredClone(value) }
  read<K extends keyof ConfigSections>(key: K): ConfigSections[K] {
    if (this.value === null) throw new Error('Configuration sections are not ready')
    return structuredClone(this.value[key])
  }
}
