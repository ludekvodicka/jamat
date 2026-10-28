import { z } from 'zod'
import type { ConfigSectionSpec } from '../../../lib-orchestrator/configStore/configStore.types'
import type { SnapinsSettings } from '../../../lib-orchestrator/snapins/snapinsApi.types'
import { BuiltInSnapins } from '../../../lib-orchestrator/snapins/builtInSnapinsView'
import { JsonShape } from '../../../lib-orchestrator/shared/jsonShape'

const agent = z.enum(['claude', 'codex'])
const kindValues = z.record(z.string(), z.union([z.number().finite(), z.string(), z.record(z.string(), z.string())]))
const schema = z.strictObject({
  limit: z.number().int().min(1).max(32), agents: z.array(agent).refine((values) => new Set(values).size === values.length),
  workerPrompts: z.partialRecord(agent, z.string()), kinds: z.record(z.string(), kindValues),
})

export class SnapinsSettingsSection {
  static readonly spec: ConfigSectionSpec<SnapinsSettings> = {
    key: 'snapins',
    coerce: (value, report) => {
      const raw = JsonShape.record(value) ?? {}
      const parsed = schema.safeParse({ limit: raw.limit ?? 4, agents: raw.agents ?? ['claude'],
        workerPrompts: raw.workerPrompts ?? {}, kinds: raw.kinds ?? {} })
      if (parsed.success) {
        for (const id of agent.options) {
          const prompt = parsed.data.workerPrompts[id]
          if (prompt?.trim() && !prompt.includes('{pass}')) {
            report(`Invalid Snap-ins worker prompt for ${id}: must contain {pass}`)
            delete parsed.data.workerPrompts[id]
          }
        }
        for (const definition of BuiltInSnapins.all()) {
          const invalid = definition.settings.validate(parsed.data.kinds[definition.kind] ?? {})
          if (invalid !== null) {
            report(`Invalid Snap-ins settings for ${definition.title}: ${invalid}`)
            delete parsed.data.kinds[definition.kind]
          }
        }
        return parsed.data
      }
      if (value !== undefined) report(`Invalid Snap-ins settings: ${parsed.error.message}`)
      const kinds = z.record(z.string(), kindValues).safeParse(raw.kinds)
      return SnapinsSettingsSection.spec.coerce({ limit: 4, agents: ['claude'], workerPrompts: {}, kinds: kinds.success ? kinds.data : {} }, report)
    },
    validate: (value) => {
      const parsed = schema.safeParse(value)
      if (!parsed.success) return parsed.error.message
      for (const [id, prompt] of Object.entries(parsed.data.workerPrompts))
        if (prompt?.trim() && !prompt.includes('{pass}')) return `Worker prompt for ${id} must contain {pass}`
      for (const definition of BuiltInSnapins.all()) {
        const error = definition.settings.validate(parsed.data.kinds[definition.kind] ?? {})
        if (error !== null) return `${definition.title}: ${error}`
      }
      return null
    },
  }
}
