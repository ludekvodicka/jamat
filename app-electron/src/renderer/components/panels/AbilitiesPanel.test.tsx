/**
 * AbilitiesPanel: user-level skills/commands/agents/mcp render as flat columns (tagged
 * symlink|local); plugins render as an expandable column — plugin skills are NOT top-level,
 * they appear only when the plugin is expanded, and a child's description shows on click.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor, fireEvent } from '@testing-library/react'
import { AbilitiesPanel } from './AbilitiesPanel'
import type { AbilitiesResult, AbilitiesManageRequest } from '../../../../../core/types/abilities'

const RESULT: AbilitiesResult = {
  skills: [
    { kind: 'skill', name: 'humanizer', description: 'Humanize AI-written text', source: 'user', link: 'symlink', path: 'C:\\skills\\humanizer\\SKILL.md', linkTarget: 'C:\\ext\\skills\\humanizer' },
    { kind: 'skill', name: 'local-skill', description: 'A direct local skill', source: 'user', link: 'local' },
  ],
  commands: [{ kind: 'command', name: 'commit-git', description: 'Open commit dialogs', source: 'user', link: 'symlink' }],
  agents: [],
  mcp: [{ kind: 'mcp', name: 'qmd', description: 'node qmd', source: 'user' }],
  plugins: [
    {
      kind: 'plugin', name: 'superpowers', description: 'Power skills', source: 'user', version: '4.3.0',
      pluginKey: 'superpowers@official', path: 'C:\\cache\\superpowers\\4.3.0',
      scope: { global: true, refs: [] },
      children: {
        skills: [{ kind: 'skill', name: 'tdd', description: 'Test-driven development', source: 'plugin:superpowers', link: 'local' }],
        commands: [{ kind: 'command', name: 'finish-branch', description: 'Finish a branch', source: 'plugin:superpowers', link: 'local' }],
        agents: [],
      },
    },
    {
      kind: 'plugin', name: 'local-plug', description: 'Local only', source: 'user', version: '1.0.0',
      pluginKey: 'local-plug@mp',
      scope: { global: false, refs: [{ kind: 'local', project: 'Q:\\Proj\\Demo' }] },
      children: {
        skills: [{ kind: 'skill', name: 'lp-skill', description: 'A local plugin skill', source: 'plugin:local-plug', link: 'local' }],
        commands: [],
        agents: [],
      },
    },
  ],
  instructions: [
    { kind: 'instruction', name: 'CLAUDE.md', description: 'Super-Global Rules', source: 'user', path: 'C:\\Users\\x\\.claude\\CLAUDE.md', scope: { global: true, refs: [] } },
    { kind: 'instruction', name: 'atomix-v2.md', description: 'Atomix v2 architecture', source: 'user', path: 'C:\\Users\\x\\.claude\\extensions\\instructions\\atomix-v2.md', scope: { global: false, refs: [] } },
  ],
  warnings: [],
  homeDir: 'C:\\Users\\x',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stub(): void { (window as any).electronAPI = { listAbilities: async () => RESULT } }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
afterEach(() => { delete (window as any).electronAPI })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mount = () => render(<AbilitiesPanel {...({} as any)} />)

describe('AbilitiesPanel', () => {
  it('renders 6 columns; user skills tagged symlink/local; plugin skills hidden until expanded', async () => {
    stub()
    const { container } = mount()
    await waitFor(() => expect(container.querySelectorAll('.abilities-col').length).toBe(6))
    // user skills present + link tags rendered
    expect(container.textContent).toContain('humanizer')
    expect(container.textContent).toContain('local-skill')
    expect(container.querySelector('.abilities-link-symlink')).not.toBeNull()
    expect(container.querySelector('.abilities-link-local')).not.toBeNull()
    // plugin row visible, but its bundled skill is NOT shown while collapsed
    expect(container.textContent).toContain('superpowers')
    expect(container.textContent).not.toContain('tdd')
  })

  it('expanding a plugin shows its skills WITH descriptions and its path, all at once', async () => {
    stub()
    const { container } = mount()
    await waitFor(() => expect(container.querySelector('.abilities-plugin-head')).not.toBeNull())
    // collapsed: child + child description + path all hidden
    expect(container.textContent).not.toContain('Test-driven development')
    fireEvent.click(container.querySelector('.abilities-plugin-head') as HTMLElement)
    // one click → child name AND its description AND the plugin local path, no second click
    await waitFor(() => expect(container.textContent).toContain('tdd'))
    expect(container.textContent).toContain('Test-driven development')
    expect(container.querySelector('.abilities-plugin-body .abilities-path')?.textContent).toContain('cache\\superpowers')
  })

  it('flat skill row is clickable: collapsed shows clamped desc, click expands desc + reveals path', async () => {
    stub()
    const { container } = mount()
    await waitFor(() => expect(container.querySelector('.abilities-item')).not.toBeNull())
    const skillsCol = container.querySelector('.abilities-col') as HTMLElement
    const humanizerRow = Array.from(skillsCol.querySelectorAll('.abilities-item')).find((el) => el.textContent?.includes('humanizer')) as HTMLElement
    expect(humanizerRow.className).toContain('clickable') // has description + path → clickable
    // collapsed: description preview present but not expanded, path hidden
    expect(humanizerRow.querySelector('.abilities-desc.expanded')).toBeNull()
    expect(humanizerRow.querySelector('.abilities-path')).toBeNull()
    fireEvent.click(humanizerRow)
    await waitFor(() => expect(humanizerRow.querySelector('.abilities-desc.expanded')).not.toBeNull())
    expect(humanizerRow.querySelector('.abilities-path')?.textContent).toContain('humanizer')
    // symlink target also revealed (humanizer is a symlink)
    expect(humanizerRow.querySelector('.abilities-linktarget')?.textContent).toContain('ext\\skills\\humanizer')
  })

  it('instructions column: global/manual chips + "Open in new window" calls newWindow(path)', async () => {
    const newWindow = vi.fn(async (_p?: string) => {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).electronAPI = { listAbilities: async () => RESULT, newWindow }
    const { container } = mount()
    await waitFor(() => expect(container.textContent).toContain('Instructions'))
    const col = Array.from(container.querySelectorAll('.abilities-col')).find((c) => c.textContent?.includes('Instructions')) as HTMLElement
    expect(col.textContent).toContain('CLAUDE.md')
    expect(col.querySelector('.abilities-scope-global')).not.toBeNull()  // CLAUDE.md = global
    expect(col.querySelector('.abilities-scope-manual')).not.toBeNull()  // atomix = manual
    // right-click CLAUDE.md → Open in new window → newWindow(path)
    const row = Array.from(col.querySelectorAll('.abilities-item')).find((el) => el.textContent?.includes('CLAUDE.md')) as HTMLElement
    fireEvent.contextMenu(row)
    await waitFor(() => expect(container.querySelector('.abilities-ctx')).not.toBeNull())
    const openItem = Array.from(container.querySelectorAll('.abilities-ctx-item')).find((el) => el.textContent === 'Open in new window') as HTMLElement
    fireEvent.click(openItem)
    await waitFor(() => expect(newWindow).toHaveBeenCalledTimes(1))
    expect(newWindow.mock.calls[0][0]).toContain('CLAUDE.md')
  })

  it('whole plugin summary is clickable — clicking the description (not just the name) toggles it', async () => {
    stub()
    const { container } = mount()
    await waitFor(() => expect(container.querySelector('.abilities-plugin-desc')).not.toBeNull())
    expect(container.textContent).not.toContain('Test-driven development') // collapsed
    fireEvent.click(container.querySelector('.abilities-plugin-desc') as HTMLElement)
    await waitFor(() => expect(container.textContent).toContain('Test-driven development'))
  })

  it('plugin filter auto-expands and narrows to matching children', async () => {
    stub()
    const { container } = mount()
    await waitFor(() => expect(container.querySelector('.abilities-col-plugins')).not.toBeNull())
    const filter = container.querySelector('.abilities-col-plugins .abilities-filter') as HTMLInputElement
    fireEvent.change(filter, { target: { value: 'tdd' } })
    // matching child shown (auto-expanded), non-matching sibling command hidden
    await waitFor(() => expect(container.textContent).toContain('tdd'))
    expect(container.textContent).not.toContain('finish-branch')
    // a flat column is unaffected
    expect(container.textContent).toContain('humanizer')
  })

  it('plugin scope chip: global vs local, where-used reveals on click (no body expand)', async () => {
    stub()
    const { container } = mount()
    const pluginsCol = await waitFor(() => {
      const c = container.querySelector('.abilities-col-plugins') as HTMLElement
      expect(c.querySelectorAll('.abilities-plugin').length).toBe(2)
      return c
    })
    // superpowers -> green global chip; local-plug -> amber local chip
    expect(pluginsCol.querySelector('.abilities-scope-global')).not.toBeNull()
    const localChip = pluginsCol.querySelector('.abilities-scope-local') as HTMLElement
    expect(localChip).not.toBeNull()
    // where-used hidden until the local chip is clicked
    expect(pluginsCol.querySelector('.abilities-scope-where')).toBeNull()
    fireEvent.click(localChip)
    await waitFor(() => expect(pluginsCol.querySelector('.abilities-scope-where')).not.toBeNull())
    expect(pluginsCol.querySelector('.abilities-scope-where')?.textContent).toContain('Q:\\Proj\\Demo')
    // clicking the chip must NOT expand the plugin body (stopPropagation): its skill stays hidden
    expect(pluginsCol.textContent).not.toContain('lp-skill')
  })

  it('scope-audit section toggles open and lists every plugin with its scope', async () => {
    stub()
    const { container } = mount()
    await waitFor(() => expect(container.querySelector('.abilities-audit-toggle')).not.toBeNull())
    // collapsed by default
    expect(container.querySelector('.abilities-audit-table')).toBeNull()
    fireEvent.click(container.querySelector('.abilities-audit-toggle') as HTMLElement)
    await waitFor(() => expect(container.querySelector('.abilities-audit-table')).not.toBeNull())
    const rows = container.querySelectorAll('.abilities-audit-table tbody tr')
    expect(rows.length).toBe(2) // superpowers + local-plug
    const auditText = container.querySelector('.abilities-audit-table')?.textContent || ''
    expect(auditText).toContain('local-plug')
    expect(auditText).toContain('Demo') // local plugin's project basename
  })

  it('right-click a plugin → Disable calls manageAbility(disablePlugin) and refetches', async () => {
    const manage = vi.fn(async (_req: AbilitiesManageRequest) => ({ ok: true }))
    const list = vi.fn(async () => RESULT)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).electronAPI = { listAbilities: list, manageAbility: manage }
    const { container } = mount()
    await waitFor(() => expect(container.querySelector('.abilities-plugin-head')).not.toBeNull())
    expect(list).toHaveBeenCalledTimes(1)
    // right-click the first plugin head (superpowers, global → Disable)
    fireEvent.contextMenu(container.querySelector('.abilities-plugin-head') as HTMLElement)
    await waitFor(() => expect(container.querySelector('.abilities-ctx')).not.toBeNull())
    const disable = Array.from(container.querySelectorAll('.abilities-ctx-item')).find((el) => el.textContent === 'Disable') as HTMLElement
    expect(disable).toBeTruthy()
    fireEvent.click(disable)
    await waitFor(() => expect(manage).toHaveBeenCalledTimes(1))
    expect(manage.mock.calls[0][0]).toEqual({ action: 'disablePlugin', name: 'superpowers@official' })
    // refetched once after success, and the menu closed
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(container.querySelector('.abilities-ctx')).toBeNull()
  })

  it('right-click → Remove… requires confirm before manageAbility(removePlugin)', async () => {
    const manage = vi.fn(async (_req: AbilitiesManageRequest) => ({ ok: true }))
    const list = vi.fn(async () => RESULT)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).electronAPI = { listAbilities: list, manageAbility: manage }
    const { container } = mount()
    await waitFor(() => expect(container.querySelector('.abilities-plugin-head')).not.toBeNull())
    fireEvent.contextMenu(container.querySelector('.abilities-plugin-head') as HTMLElement)
    await waitFor(() => expect(container.querySelector('.abilities-ctx')).not.toBeNull())
    const remove = Array.from(container.querySelectorAll('.abilities-ctx-item')).find((el) => el.textContent === 'Remove…') as HTMLElement
    expect(remove).toBeTruthy()
    fireEvent.click(remove)
    // portal confirm modal appears; manage NOT called until confirmed
    await waitFor(() => expect(document.querySelector('.abilities-confirm')).not.toBeNull())
    expect(manage).not.toHaveBeenCalled()
    fireEvent.click(document.querySelector('.abilities-confirm-ok') as HTMLElement)
    await waitFor(() => expect(manage).toHaveBeenCalledTimes(1))
    expect(manage.mock.calls[0][0]).toEqual({ action: 'removePlugin', name: 'superpowers@official' })
  })
})
