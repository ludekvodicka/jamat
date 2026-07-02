import { useLayoutStore } from '../store/layout-store'

export type Direction = 'left' | 'right' | 'above' | 'below'

export function getDockviewAccessor() {
  const api = useLayoutStore.getState().dockviewApi
  if (!api) return null
  return (api as any).component ?? (api as any)._component ?? (api as any).accessor ?? null
}

export function findAdjacentGroup(currentGroup: any, direction: Direction, groups: any[]) {
  const currentEl = currentGroup.element ?? currentGroup.header?.element?.parentElement
  if (!currentEl) return null
  const currentRect = currentEl.getBoundingClientRect()
  const cx = currentRect.left + currentRect.width / 2
  const cy = currentRect.top + currentRect.height / 2

  let best: any = null
  let bestDist = Infinity

  for (const g of groups) {
    if (g.id === currentGroup.id) continue
    const el = g.element ?? g.header?.element?.parentElement
    if (!el) continue
    const r = el.getBoundingClientRect()
    const gx = r.left + r.width / 2
    const gy = r.top + r.height / 2

    let valid = false
    if (direction === 'left' && gx < cx - 20) valid = true
    if (direction === 'right' && gx > cx + 20) valid = true
    if (direction === 'above' && gy < cy - 20) valid = true
    if (direction === 'below' && gy > cy + 20) valid = true

    if (valid) {
      const dist = Math.abs(gx - cx) + Math.abs(gy - cy)
      if (dist < bestDist) { bestDist = dist; best = g }
    }
  }
  return best
}

export function movePanelInDirection(direction: Direction): void {
  const api = useLayoutStore.getState().dockviewApi
  const component = getDockviewAccessor()
  if (!api?.activePanel || !component?.moveGroupOrPanel) return

  const panel = api.activePanel
  const currentGroup = (panel as any).group
  if (!currentGroup) return

  const adjacent = findAdjacentGroup(currentGroup, direction, api.groups)
  if (adjacent) {
    component.moveGroupOrPanel({
      from: { groupId: currentGroup.id, panelId: panel.id },
      to: { group: adjacent, position: 'center' }
    })
  } else {
    const posMap = { left: 'left', right: 'right', above: 'top', below: 'bottom' } as const
    component.moveGroupOrPanel({
      from: { groupId: currentGroup.id, panelId: panel.id },
      to: { group: currentGroup, position: posMap[direction] }
    })
  }
}

export function resetLayout(): void {
  const api = useLayoutStore.getState().dockviewApi
  const component = getDockviewAccessor()
  if (!api || !component?.moveGroupOrPanel || api.groups.length <= 1) return

  const targetGroup = api.groups[0]
  for (const panel of [...api.panels]) {
    const group = (panel as any).group
    if (group?.id !== targetGroup.id) {
      try {
        component.moveGroupOrPanel({
          from: { groupId: group.id, panelId: panel.id },
          to: { group: targetGroup, position: 'center' }
        })
      } catch {}
    }
  }
}
