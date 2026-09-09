import { describe, expect, it } from 'vitest'

import { WorktreeSettings } from '../../shared/worktreeSettings'
import { WorktreeSettingsSection } from './worktreeSettingsSection'

describe('app-client-ui/app/worktrees/worktreeSettingsSection', () => {
  it('owns worktrees and accepts exactly the shared model', () => {
    expect(WorktreeSettingsSection.spec.key).toBe('worktrees')
    expect(WorktreeSettingsSection.spec.validate(WorktreeSettings.defaultValue())).toBeNull()
    expect(WorktreeSettingsSection.spec.validate(
      { node: { pnpm: { globalVirtualStore: 'yes' } } } as never,
    )).toContain('globalVirtualStore')
  })

  it('reads a damaged section rather than refusing, so a session can always install', () => {
    const messages: string[] = []
    expect(WorktreeSettingsSection.spec.coerce(
      { node: { pnpm: { globalVirtualStore: 'yes' } } },
      (message) => messages.push(message),
    )).toEqual({ node: { pnpm: { globalVirtualStore: false } } })
    expect(messages).toHaveLength(1)
  })
})
