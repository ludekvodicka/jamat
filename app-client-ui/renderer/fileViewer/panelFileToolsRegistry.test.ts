import { describe, expect, it, vi } from 'vitest'

import { PanelFileToolsRegistry } from './panelFileToolsRegistry'

describe('app-client-ui/renderer/fileViewer/panelFileToolsRegistry', () => {
  it('routes tab-scoped commands only to the active panel registration', () => {
    const registry = new PanelFileToolsRegistry()
    const toggle = vi.fn()
    const open = vi.fn()
    const release = registry.register('panel-1', { toggle, open })
    registry.toggle('panel-1')
    registry.openFileChanges('panel-1')
    expect(toggle).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith('workingTree')
    release()
    registry.toggle('panel-1')
    expect(toggle).toHaveBeenCalledOnce()
  })

  it('keeps the old fileChanges key as Changelog and accepts the new product default', () => {
    expect(PanelFileToolsRegistry.tab('workingTree')).toBe('workingTree')
    expect(PanelFileToolsRegistry.tab('fileChanges')).toBe('fileChanges')
    expect(PanelFileToolsRegistry.tab('directoryExplorer')).toBe('directoryExplorer')
  })
})
