import { z } from 'zod'

export const worktreeRepositoryReviewSchema = z.object({
  root: z.string().min(1).max(32768), repository: z.string().max(32768), repositoryName: z.string().max(256), expectedPrefix: z.string().max(258),
  paths: z.array(z.string().max(32768)).max(10000), message: z.string().max(100000),
  source: z.enum(['agent-proposal', 'person-local', 'person-remote', 'restored-draft', 'kept-attempt', 'unknown']),
  acknowledged: z.array(z.enum(['empty', 'no-prefix', 'long-first-line', 'chat-opening', 'markdown', 'reused-after-keep'])).max(6),
})
