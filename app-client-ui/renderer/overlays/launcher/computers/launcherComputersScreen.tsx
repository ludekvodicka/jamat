import { Fragment, useState } from 'react'
import type { SessionInfo } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionNodeState } from '../../../views/sessionsTree/sessionNodeState'
import type { TreeNode } from '../../../views/sessionsTree/sessionsTreeModel'
import type { ComputersScreenInput, ComputersScreenState } from './computersScreenModel'
import { ComputersScreenModel } from './computersScreenModel'
import './computers.css'

export function LauncherComputersScreen(props: {
  state: ComputersScreenState
  dispatch(input: ComputersScreenInput): void
}): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const row = props.state.rows[props.state.cursor]
  const nodes = ComputersScreenModel.treeOf(row, filter)
  const sessions = new Map(row?.sessions?.sessions.map((session) => [session.sessionId, session]))
  const toggle = (id: string): void => setCollapsed((previous) => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const renderRows = (entries: readonly TreeNode[], level: number): React.ReactNode => entries.map((node) => {
    const session = node.kind === 'session' ? sessions.get(node.sessionId) : undefined
    const path = directoryOf(node, session)
    const title = node.kind === 'session' ? node.title : node.label
    const branch = node.children.length > 0
    const expanded = branch && !collapsed.has(node.id)
    const selected = node.kind === 'session' && row?.selectedSessionIds.includes(node.sessionId)
    const connect = (): void => {
      if (node.kind === 'session' && !selected)
        props.dispatch({ input: 'selectSession', sessionId: node.sessionId })
    }
    return <Fragment key={node.id}>
      <tr role="row" tabIndex={0} aria-level={level} aria-expanded={branch ? expanded : undefined}
        className={`jamat-launcher-computers__tree-row jamat-launcher-computers__tree-row--${node.kind}`}
        onDoubleClick={() => branch ? toggle(node.id) : connect()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'Tab') return
          event.stopPropagation()
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter') {
            event.preventDefault()
            if (node.kind === 'session') connect()
            else toggle(node.id)
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            if (branch && expanded !== (event.key === 'ArrowRight')) toggle(node.id)
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const rows = [...event.currentTarget.closest('tbody')!.querySelectorAll<HTMLTableRowElement>('tr')]
            const index = rows.indexOf(event.currentTarget)
            rows[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus()
          }
        }}>
        <td role="gridcell">
          <div className="jamat-launcher-computers__tree-name" style={{ paddingLeft: (level - 1) * 16 }}>
            {branch
              ? <button type="button" className="jamat-launcher-computers__twisty"
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${title}`}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={() => toggle(node.id)}>{expanded ? '▾' : '▸'}</button>
              : <span className="jamat-launcher-computers__twisty" />}
            {node.kind === 'session' && <span
              className={`jamat-launcher-computers__glyph jamat-launcher-computers__glyph--${SessionNodeState.paintOf(node.glyph, false)}`}
              title={SessionNodeState.glyphTitleOf(node.glyph, false)}>{SessionNodeState.characterOf(node.glyph, false)}</span>}
            <span className="jamat-launcher-computers__label" title={title}>{title}</span>
          </div>
        </td>
        <td role="gridcell" className="jamat-launcher-computers__directory" title={path}>{path}</td>
        <td role="gridcell" className="jamat-launcher-computers__action">
          {node.kind === 'session' && <button type="button" className="jamat-launcher__start-button"
            disabled={selected} aria-label={`${selected ? 'Connected' : 'Connect'} ${title}`}
            onDoubleClick={(event) => event.stopPropagation()} onClick={connect}>
            {selected ? 'Connected' : 'Connect'}
          </button>}
        </td>
      </tr>
      {expanded && renderRows(node.children, level + 1)}
    </Fragment>
  })
  return (
    <div className="jamat-launcher-computers__sessions">
      <div className="jamat-launcher-computers__filter">
        <input type="search" aria-label="Filter remote sessions" placeholder="Filter sessions or projects"
          value={filter} onChange={(event) => { setFilter(event.currentTarget.value); setCollapsed(new Set()) }} />
        <span>{row?.sessions?.sessions.length ?? 0} sessions</span>
      </div>
      <div className="jamat-launcher-computers__tree-scroll">
        <table role="treegrid" aria-label="Remote sessions" className="jamat-launcher-computers__tree">
          <colgroup><col /><col /><col /></colgroup>
          <thead><tr role="row"><th role="columnheader">Name</th><th role="columnheader">Directory</th><th role="columnheader">Connect</th></tr></thead>
          <tbody>{renderRows(nodes, 1)}</tbody>
        </table>
        {nodes.length === 0 && <p className="jamat-launcher-computers__empty">No sessions found.</p>}
      </div>
      <p className="jamat-launcher-computers__hint">Connect adds only that session to your Remote tree.</p>
    </div>
  )
}

function directoryOf(node: TreeNode, session: SessionInfo | undefined): string {
  switch (node.kind) {
    case 'category': return ''
    case 'project': return node.path
    case 'session': {
      if (!session) return ''
      if (session.worktree) return session.worktree.worktreePath
      switch (session.directory.mode) {
        case 'project': return session.directory.projectPath
        case 'adHoc': return session.directory.path
        case 'default': return ''
        default: throw new Error(`Unknown remote session directory: ${JSON.stringify(session.directory)}`)
      }
    }
    default: throw new Error(`Unknown remote session node: ${JSON.stringify(node)}`)
  }
}
