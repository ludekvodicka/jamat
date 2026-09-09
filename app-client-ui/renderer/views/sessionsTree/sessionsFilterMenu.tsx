import { SessionPalette } from '../../../shared/sessionPalette'
import { SessionsFilterState, type SavedSessionsFilter, type SessionsFilterValue } from '../../../shared/sessionsFilterState'
import { ContextMenu, type ContextMenuAction, type ContextMenuEntry, type ContextMenuPosition } from '../../widgets/contextMenu'
import '../../widgets/tabs/tabContextMenu.css'

export function SessionsFilterMenu(props: {
  position: ContextMenuPosition
  savedId: string | null
  filters: SessionsFilterValue
  saved: readonly SavedSessionsFilter[]
  canSave: boolean
  onChange(filters: SessionsFilterValue): void
  onReset(): void
  onClosedRecently(): void
  onSave(): void
  onDelete(id: string): void
  onClose(): void
}): React.JSX.Element {
  function choices<T>(
    key: string,
    values: readonly T[],
    selected: readonly T[],
    label: (value: T) => string,
    change: (values: readonly T[]) => void,
    swatch?: (value: T) => string | undefined,
    toggle: (values: readonly T[], value: T) => readonly T[] = SessionsFilterState.toggle,
  ): readonly ContextMenuAction[] {
    return [{
      key: `${key}:all`, label: 'All', checked: selected.length === 0,
      keepOpenOnSelect: true,
      onSelect: () => change([]), onContextMenu: props.onReset,
    }, ...values.map((value) => ({
      key: `${key}:${value}`, label: label(value), checked: selected.includes(value),
      swatchClassName: swatch?.(value), keepOpenOnSelect: true,
      onSelect: () => change(toggle(selected, value)),
    }))]
  }

  const remove = (saved: SavedSessionsFilter): ContextMenuAction => ({
    key: `delete:${saved.id}`, label: saved.name, disabled: !props.canSave,
    onSelect: () => props.onDelete(saved.id),
  })
  /*
   * The three conditions first, then the shortcuts that stand for a whole set of them. Each of the
   * three opens a submenu and is a place to go rather than a thing to do, so they are what the menu
   * offers first; `All` and `Last 6h closed` are one click that replaces every condition at once,
   * which is a different kind of item and sits below the rule that separates them.
   */
  const items: readonly ContextMenuEntry[] = props.savedId === null ? [
    {
      key: 'colors', label: 'Filter by color',
      children: choices('color', [null, ...SessionPalette.namesConst], props.filters.colors,
        SessionPalette.labelOf, (colors) => props.onChange({ ...props.filters, colors }),
        (color) => color === null ? undefined : SessionPalette.swatchClassOf(color)),
    },
    {
      key: 'states', label: 'Filter by state',
      children: choices('state', Object.keys(SessionsFilterState.stateLabelsConst) as (keyof typeof SessionsFilterState.stateLabelsConst)[],
        props.filters.states, (state) => SessionsFilterState.stateLabelsConst[state],
        (states) => props.onChange({ ...props.filters, states }), undefined, SessionsFilterState.toggleState),
    },
    {
      key: 'agents', label: 'Filter by type',
      children: choices('agent', SessionsFilterState.agentChoicesConst, props.filters.agents,
        (agent) => {
          if (agent === null) return 'Terminal'
          else if (agent === 'claude') return 'Claude'
          else if (agent === 'codex') return 'Codex'
          else throw new Error(`Unknown session filter agent: ${agent}`)
        }, (agents) => props.onChange({ ...props.filters, agents })),
    },
    { kind: 'separator', key: 'shortcuts' },
    { key: 'all', label: 'All', onSelect: props.onReset, onContextMenu: props.onReset },
    {
      key: 'closedRecently',
      label: SessionsFilterState.stateLabelsConst.closedRecently,
      onSelect: props.onClosedRecently,
    },
    { kind: 'separator', key: 'saved' },
    { key: 'save', label: 'Save filter…', disabled: !props.canSave, onSelect: props.onSave },
    ...(props.saved.length === 0 ? [] : [{
      key: 'delete', label: 'Delete saved filter', children: props.saved.map(remove),
    }]),
  ] : props.saved.filter((saved) => saved.id === props.savedId).map((saved) => ({
    ...remove(saved), label: 'Delete filter',
  }))

  return <ContextMenu position={props.position} ariaLabel="Session filters" items={items} onClose={props.onClose} />
}
