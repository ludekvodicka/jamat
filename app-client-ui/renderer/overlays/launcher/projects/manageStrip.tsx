import type {
  DeletePreview,
  RelocationReport,
  VirtualFolderDef,
} from '../../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type { DeletePhase, ManageInput, ManageState } from './manageModel'

/**
 * The operation that is open on a project, drawn in the card's own strip above the key line.
 *
 * There is no row of buttons here any more, and no panel under a list row: the four things that can
 * be done to a project are `F6`, `⇧F6`, `F8` and `⇧F8`, named and clickable on that key line. What
 * is left is what an operation ASKS - a new name, which folder, the archive's question, and the
 * delete's enumeration - and it is asked in one place rather than under whichever row it started on.
 *
 * **Every prompt names its project.** Drawn under the row it acted on, the panel's position said
 * which one; from down here nothing else does, and the cursor is at the other end of the card.
 *
 * Every destructive path takes two steps, and the delete shows the file set its token is bound to
 * before it offers the button. There is no yes/no anywhere: the confirmation is a count.
 */
export function ManageStrip(props: {
  manage: ManageState
  /** Every folder the root defines, empty ones included - a folder just created holds nothing. */
  folders: readonly VirtualFolderDef[]
  now: number
  dispatch(input: ManageInput): void
}): React.JSX.Element {
  const { manage, dispatch } = props
  const operation = manage.operation
  const aimed = manage.target?.projectName ?? ''

  return (
    <div className="jamat-launcher-manage jamat-launcher-manage--bar">
      {operation?.op === 'rename' && (
        <div className="jamat-launcher-manage__row">
          <span className="jamat-launcher-manage__ask">{`Rename ${aimed} to`}</span>
          <input
            className="jamat-launcher-manage__edit"
            type="text"
            aria-label="New name"
            autoFocus
            value={operation.name}
            onChange={(event) => dispatch({ input: 'renameChanged', name: event.target.value })}
          />
        </div>
      )}

      {operation?.op === 'movePrefix' && (
        <div className="jamat-launcher-manage__row">
          <span className="jamat-launcher-manage__ask">{`Move ${aimed} to`}</span>
          {/* The title is what the config named the folder; the prefix it renames by is the hint.
              The key carries the index because the prefix is not unique: the configuration tab warns
              about two folders sharing one and saves them, and two buttons under one key is a list
              React draws one button for. */}
          {props.folders.map((folder, index) => (
            <button key={`${index}:${folder.prefix}`}
              className="jamat-launcher-manage__button" type="button"
              title={folder.prefix}
              onClick={() => dispatch({ input: 'movePrefixChosen', targetPrefix: folder.prefix })}>
              {folder.title}
            </button>
          ))}
          <button className="jamat-launcher-manage__button" type="button"
            onClick={() => dispatch({ input: 'movePrefixChosen', targetPrefix: null })}>
            Root (no folder)
          </button>
        </div>
      )}

      {operation?.op === 'archive' && (
        <div className="jamat-launcher-manage__row">
          <span className="jamat-launcher-manage__ask">{`Archive ${aimed}?`}</span>
          <button className="jamat-launcher-manage__button" type="button"
            onClick={() => dispatch({ input: 'archiveStart' })}>Archive</button>
          <button className="jamat-launcher-manage__button" type="button"
            onClick={() => dispatch({ input: 'cancel' })}>Cancel</button>
        </div>
      )}

      {/* Its own name rather than the target's: a delete outlives the cursor, and the whole point of
          the operation carrying its identity is that these two can never name different projects. */}
      {operation?.op === 'delete' && (
        <DeleteBlock
          phase={operation.phase}
          name={operation.name}
          now={props.now}
          dispatch={dispatch}
        />
      )}

      {manage.error !== null && (
        <p className="jamat-launcher-manage__error">
          <span className="jamat-launcher__code">{manage.error.code}</span>
          {` · ${manage.error.detail}`}
        </p>
      )}

      {manage.lastReport !== null && <Report report={manage.lastReport} />}

      {manage.lastDelete !== null && (
        <p className="jamat-launcher-manage__report">
          {`Deleted ${manage.lastDelete.deletedPaths} paths`}
        </p>
      )}
    </div>
  )
}

function DeleteBlock(props: {
  phase: DeletePhase
  name: string
  now: number
  dispatch(input: ManageInput): void
}): React.JSX.Element {
  const phase = props.phase
  if (phase.phase === 'previewing')
    return (
      <p className="jamat-launcher-manage__hint">
        {`Reading what deleting ${props.name} would take…`}
      </p>
    )
  else if (phase.phase === 'preview')
    return <Preview preview={phase.preview} now={props.now} dispatch={props.dispatch} />
  else if (phase.phase === 'executing')
    return <p className="jamat-launcher-manage__hint">{`Deleting ${props.name}…`}</p>
  else if (phase.phase === 'refused')
    return (
      <div className="jamat-launcher-manage__row">
        <span className="jamat-launcher-manage__ask">{phase.detail}</span>
        <span className="jamat-launcher__code">{phase.code}</span>
        <button className="jamat-launcher-manage__button" type="button"
          onClick={() => props.dispatch({ input: 'deleteStart' })}>Preview again</button>
      </div>
    )
  else
    throw new Error(`Unknown delete phase: ${JSON.stringify(phase)}`)
}

/** The enumeration is shown whole: the button below it can then carry a count instead of a question. */
function Preview(props: {
  preview: DeletePreview
  now: number
  dispatch(input: ManageInput): void
}): React.JSX.Element {
  const preview = props.preview
  const total = preview.projectFileCount
    + preview.claude.transcriptFiles.length
    + preview.codex.rolloutFiles.length
  return (
    <div className="jamat-launcher-manage__delete">
      <p className="jamat-launcher-manage__path">{preview.projectPath}</p>
      <div className="jamat-launcher-manage__counts">
        <span>{`${preview.projectFileCount} project files`}</span>
        <span>{`${preview.claude.transcriptFiles.length} Claude transcripts`}</span>
        <span>{`${preview.codex.rolloutFiles.length} Codex rollouts`}</span>
      </div>
      <p className="jamat-launcher-manage__hint">
        {`This cannot be undone. The preview ${ManageText.expiryOf(preview.expiresAt, props.now)
          } and the delete runs against exactly this file set.`}
      </p>
      <div className="jamat-launcher-manage__row">
        <button className="jamat-launcher-manage__button jamat-launcher-manage__button--danger"
          type="button" onClick={() => props.dispatch({ input: 'deleteConfirm' })}>
          {`Delete ${total} files`}
        </button>
        <button className="jamat-launcher-manage__button" type="button"
          onClick={() => props.dispatch({ input: 'cancel' })}>Cancel</button>
      </div>
    </div>
  )
}

function Report(props: { report: RelocationReport }): React.JSX.Element {
  const report = props.report
  return (
    <>
      <p className="jamat-launcher-manage__report">
        {`${report.directoryRenamed ? 'Directory renamed' : 'Directory unchanged'} · Claude ${
          report.providers.claude} · Codex ${report.providers.codex}`}
      </p>
      {report.leftoverCount > 0 && (
        <p className="jamat-launcher-manage__warn">
          {`${report.leftoverCount} files left behind; the startup sweep retries them`}
        </p>
      )}
    </>
  )
}

export class ManageText {
  /**
   * Read at render rather than ticked by a timer: the card redraws on everything the user does, and
   * a countdown of its own would be a clock running behind a surface that is usually idle.
   */
  static expiryOf(expiresAt: number, now: number): string {
    const left = expiresAt - now
    if (left <= 0)
      return 'has expired'
    return `expires in ${Math.ceil(left / 60_000)} min`
  }
}
