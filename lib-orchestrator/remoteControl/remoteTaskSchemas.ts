import { z } from 'zod'

const id = z.string().min(1).max(256)
export class RemoteTaskSchemas {
  static readonly request = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('list') }),
    z.strictObject({ kind: z.literal('transcript'), subagentId: id, known: id.optional() }),
    z.strictObject({ kind: z.literal('shell'), shellId: id, known: id.optional() }),
    z.strictObject({ kind: z.literal('script'), runId: id }),
  ])
}
