export type FileToolsTab = 'workingTree' | 'fileChanges' | 'directoryExplorer'

export interface PanelFileToolsHandle {
  toggle(): void
  open(tab: FileToolsTab): void
}

export class PanelFileToolsRegistry {
  private readonly handles = new Map<string, PanelFileToolsHandle>()

  register(panelId: string, handle: PanelFileToolsHandle): () => void {
    if (this.handles.has(panelId))
      throw new Error(`File tools are already registered for panel ${panelId}`)
    this.handles.set(panelId, handle)
    return () => {
      if (this.handles.get(panelId) === handle) this.handles.delete(panelId)
    }
  }

  toggle(panelId: string | null): void {
    if (panelId !== null) this.handles.get(panelId)?.toggle()
  }

  openFileChanges(panelId: string | null): void {
    if (panelId !== null) this.handles.get(panelId)?.open('workingTree')
  }

  static tab(value: string | null): FileToolsTab {
    if (value === 'workingTree') return value
    else if (value === 'fileChanges') return value
    else if (value === 'directoryExplorer') return value
    else throw new Error(`Unknown file tools tab: ${JSON.stringify(value)}`)
  }
}
