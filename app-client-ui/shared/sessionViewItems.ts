import { z } from 'zod'
import { RemoteFileResults } from './remoteFileResults'

const text = z.string().min(1).max(256)
export const sessionViewItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), source: RemoteFileResults.document.shape.source }),
  z.strictObject({ kind: z.literal('review'), reviewId: text, vcs: z.enum(['svn', 'git']), scopeRoot: z.string().max(32768) }),
  z.strictObject({ kind: z.literal('task'), task: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('subagent'), subagentId: text }),
    z.strictObject({ kind: z.literal('shell'), shellId: text }),
    z.strictObject({ kind: z.literal('script'), runId: text }),
  ]) }),
  z.strictObject({ kind: z.literal('workflow') }),
])
export const sessionOpenSchema = z.strictObject({
  sequence: z.number().int().positive(), openId: text, sessionId: text, key: z.string().min(1).max(32768),
  title: z.string().min(1).max(400), item: sessionViewItemSchema,
})
export type SessionViewItem = z.infer<typeof sessionViewItemSchema>
export type SessionOpen = z.infer<typeof sessionOpenSchema>
export const sessionOpenPageSchema = z.strictObject({
  epoch: text, revision: z.number().int().nonnegative(), after: z.number().int().nonnegative(),
  next: z.number().int().nonnegative().nullable(), items: z.array(sessionOpenSchema).max(64),
})
export type SessionOpenPage = z.infer<typeof sessionOpenPageSchema>
export interface SessionOpenCursor { after: number; epoch?: string; revision?: number }
