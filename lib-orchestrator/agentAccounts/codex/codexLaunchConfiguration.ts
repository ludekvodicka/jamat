import type { AccountLaunchSettings } from '../agentAccountsApi.types'

export class CodexLaunchConfiguration {
  static of(cwd: string, settings: AccountLaunchSettings = {}): { overrides: string[]; layer: Record<string, unknown> } {
    const overrides: string[] = [], layer: Record<string, unknown> = {}
    if (settings.model !== undefined) {
      overrides.push(`model=${JSON.stringify(settings.model)}`)
      layer.model = settings.model
    }
    if (settings.effort !== undefined) {
      overrides.push(`model_reasoning_effort=${JSON.stringify(settings.effort)}`)
      layer.model_reasoning_effort = settings.effort
    }
    if (settings.yolo) {
      overrides.push('approval_policy="never"', 'sandbox_mode="danger-full-access"',
        `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`)
      Object.assign(layer, { approval_policy: 'never', sandbox_mode: 'danger-full-access', projects: { [cwd]: { trust_level: 'trusted' } } })
    }
    return { overrides, layer }
  }
}
