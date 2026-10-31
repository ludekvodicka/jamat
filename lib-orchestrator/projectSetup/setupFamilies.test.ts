import { describe, expect, it } from 'vitest'

import type { SetupToolId } from './projectSetup.types'
import { SetupFamilies } from './setupFamilies'

describe('lib-orchestrator/projectSetup/setupFamilies', () => {
  const everyToolConst: readonly SetupToolId[] = [
    'node-pnpm', 'node-npm', 'node-yarn',
    'python-uv', 'python-poetry',
    'rust-cargo',
    'go-mod',
  ]

  it('has a command for every tool a detector can return', () => {
    for (const toolId of everyToolConst)
      expect(SetupFamilies.commandOf(toolId), toolId).toMatch(/\S/)
  })

  /* The catalog is what the settings window prints, so a tool missing from it is a row the user
     never sees for a command that still runs. */
  it('names every tool in the catalog, and no tool that does not exist', () => {
    const catalogued = SetupFamilies.catalogConst.flatMap((family) => family.tools)
      .map((tool) => tool.toolId)
    expect([...catalogued].sort()).toEqual([...everyToolConst].sort())
  })

  it('throws on a tool it does not know, and says which', () => {
    expect(() => SetupFamilies.commandOf('perl-cpan' as SetupToolId))
      .toThrow('Unknown setup tool: "perl-cpan"')
  })

  /* pnpm reads `pnpm_config_*` and ignores `npm_config_enable_global_virtual_store` (measured, 12.8.1). */
  it('gives pnpm the store variable with the setting on, and gives nothing else any', () => {
    const on = { node: { pnpm: { globalVirtualStore: true } } }
    const off = SetupFamilies.defaultPlatformSettings()
    expect(SetupFamilies.commandOf('node-pnpm')).toBe('pnpm install')
    expect(SetupFamilies.variablesOf('node-pnpm', on)).toEqual({ pnpm_config_enable_global_virtual_store: 'true' })
    expect(SetupFamilies.variablesOf('node-pnpm', off)).toEqual({})
    for (const toolId of everyToolConst.filter((id) => id !== 'node-pnpm'))
      expect(SetupFamilies.variablesOf(toolId, on), toolId).toEqual({})
  })

  /* A shared object would let one caller edit the default out from under the next. */
  it('hands out a fresh default every time', () => {
    const first = SetupFamilies.defaultPlatformSettings()
    first.node.pnpm.globalVirtualStore = true
    expect(SetupFamilies.defaultPlatformSettings().node.pnpm.globalVirtualStore).toBe(false)
  })

  it('gives every family a marker to look for', () => {
    for (const family of SetupFamilies.catalogConst) {
      expect(family.tools.length, family.familyId).toBeGreaterThan(0)
      for (const tool of family.tools)
        expect(tool.marker, tool.toolId).toMatch(/\S/)
    }
  })
})
