import { useEffect, useId, useRef, useState } from 'react'

import { SetupFamilies } from '../../../../../../lib-orchestrator/projectSetup/setupFamilies'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import './worktreesSettings.css'
import {
  WorktreesSettingsEffects,
  type WorktreesSettingsPorts,
} from './worktreesSettingsEffects'
import {
  WorktreesSettingsModel,
  type WorktreesSettingsModelState,
  type WorktreesProjectState,
} from './worktreesSettingsModel'

/**
 * What a session installs after its worktree is cut, and the one tier of it this machine owns.
 *
 * The family table is drawn from `SetupFamilies.catalogConst` rather than written out here, which is
 * the whole reason that class exists: a command typed into this JSX would disagree with the one that
 * actually runs the first time a default moves.
 */
export function WorktreesSettingsTab(props: ConfigurationTabProps): React.JSX.Element {
  const [start] = useState(() => WorktreesSettingsModel.initial())
  const [state, setState] = useState<WorktreesSettingsModelState>(start.state)
  const stateRef = useRef(start.state)
  const reportedDirty = useRef(false)
  const dirtyChange = useRef(props.onDirtyChange)
  const mounted = useRef(true)
  dirtyChange.current = props.onDirtyChange
  const pnpmId = useId()
  // Through a ref so a re-render with a new store object cannot re-run the consume above.
  const intents = useRef(props.worktreeSetupIntents)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const [ports] = useState<WorktreesSettingsPorts>(() => {
    const self: WorktreesSettingsPorts = {
      dispatch: (input) => {
        if (!mounted.current) return
        const step = WorktreesSettingsModel.transition(stateRef.current, input)
        stateRef.current = step.state
        setState(step.state)
        const modified = WorktreesSettingsModel.isModified(step.state)
        if (modified !== reportedDirty.current) {
          reportedDirty.current = modified
          dirtyChange.current(modified)
        }
        for (const effect of step.effects)
          void WorktreesSettingsEffects.run(effect, self)
      },
    }
    return self
  })

  useEffect(() => {
    for (const effect of start.effects)
      void WorktreesSettingsEffects.run(effect, ports)
    // Consumed once, on the mount that followed the right-click: an intent is what ONE click meant.
    const intent = intents.current?.consume() ?? null
    if (intent !== null) ports.dispatch({ input: 'project-opened', intent })
  }, [intents, ports, start.effects])

  const saving = state.saving !== null
  const globalVirtualStore = state.buffer?.node.pnpm.globalVirtualStore ?? false
  return (
    <div className="jamat-configuration-worktrees">
      {state.problem !== null && (
        <p className="jamat-configuration__problem" role="alert">{state.problem}</p>
      )}

      <ConfigurationSection title="What runs after a worktree is cut">
        <ol className="jamat-configuration-worktrees__tiers">
          <li>
            <code>.worktree.json</code> in the project
            <span>travels with the repository, and beats everything</span>
          </li>
          <li>
            this machine
            <span>the switches below</span>
          </li>
          <li>
            the family&apos;s built-in default
            <span>read-only</span>
          </li>
        </ol>
        <p className="jamat-configuration-worktrees__note">
          A project matching no family installs nothing, and its session row says so.
        </p>
      </ConfigurationSection>

      <ConfigurationSection title="Families this build knows">
        <div className="jamat-configuration-worktrees__families">
          <table>
            <thead>
              <tr>
                <th scope="col">Family</th>
                <th scope="col">Installs with</th>
                <th scope="col">Picked by</th>
              </tr>
            </thead>
            <tbody>
              {SetupFamilies.catalogConst.map((family) => (
                <tr key={family.familyId} data-family={family.familyId}>
                  <td>{family.title}</td>
                  <td>
                    {family.tools.map((tool) => <code key={tool.toolId}>{tool.command}</code>)
                      .reduce<React.ReactNode[]>(
                      (all, entry, index) => index === 0 ? [entry] : [...all, ' | ', entry],
                      [],
                    )}
                  </td>
                  <td>{family.tools.map((tool) => tool.marker).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ConfigurationSection>

      <ConfigurationSection title="This machine">
        {state.buffer === null && (
          <p className="jamat-configuration-worktrees__note">Reading config.json…</p>
        )}
        <div className="jamat-configuration-worktrees__row">
          <input
            id={pnpmId}
            type="checkbox"
            disabled={state.buffer === null || saving}
            checked={globalVirtualStore}
            onChange={(event) => ports.dispatch({
              input: 'pnpm-global-virtual-store',
              value: event.currentTarget.checked,
            })}
          />
          <label htmlFor={pnpmId}>
            pnpm: global virtual store
            <span><code>{SetupFamilies.pnpmGlobalVirtualStoreCommandConst}</code></span>
          </label>
        </div>
      </ConfigurationSection>

      {state.project !== null && (
        <ProjectSetupCard project={state.project} ports={ports} />
      )}

      <div className="jamat-configuration__actions">
        <button
          className="jamat-configuration__button"
          type="button"
          disabled={state.buffer === null || saving}
          onClick={() => ports.dispatch({ input: 'reset' })}
        >Reset to default</button>
        <button
          className="jamat-configuration__button jamat-configuration__button--primary"
          type="button"
          disabled={!WorktreesSettingsModel.machineModified(state) || saving}
          onClick={() => ports.dispatch({ input: 'save' })}
        >{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  )
}

/**
 * The project's own `setup`, one command per line. A textarea and not a list of rows: the value is a
 * string array, reordering is what an editor does to lines anyway, and the smaller control is the
 * one that does not invent a second way to say "empty".
 *
 * Its Save is its own, because it writes a different file than the machine card above. Saving here
 * changes the command list a project declares, which withdraws this machine's agreement to run it -
 * the line under the button says so rather than letting the next session surprise anybody.
 */
const newlineConst = '\n'

function ProjectSetupCard(props: {
  project: WorktreesProjectState
  ports: WorktreesSettingsPorts
}): React.JSX.Element {
  const { project, ports } = props
  const saving = project.saving !== null
  const lines = project.buffer === null ? '' : project.buffer.join(newlineConst)
  return (
    <ConfigurationSection title={`This project: ${project.intent.projectName}`}>
      <p className="jamat-configuration-worktrees__note">
        <code>{project.intent.projectPath}</code>
        {' holds the '}
        <code>.worktree.json</code>
        {' this edits.'}
      </p>
      {project.problem !== null && (
        <p className="jamat-configuration__problem" role="alert">{project.problem}</p>
      )}
      {project.buffer === null && !project.readOnly && (
        <p className="jamat-configuration-worktrees__note">Reading .worktree.json…</p>
      )}
      {project.buffer !== null && (
        <>
          <textarea
            className="jamat-configuration-worktrees__setup"
            aria-label="Setup commands, one per line"
            rows={4}
            spellCheck={false}
            disabled={saving}
            value={lines}
            onChange={(event) => ports.dispatch({
              input: 'project-edited',
              // An empty box is an empty array, which is the project saying it needs nothing.
              setup: event.currentTarget.value.split(newlineConst)
                .map((line) => line.trim()).filter((line) => line !== ''),
            })}
          />
          <p className="jamat-configuration-worktrees__note">
            {project.loaded === null
              ? 'This project declares nothing of its own; the family default installs it.'
              : 'Saving changes what this project declares, so the next session in it asks once '
                + 'whether these commands may run.'}
          </p>
          <div className="jamat-configuration__actions">
            <button
              className="jamat-configuration__button jamat-configuration__button--primary"
              type="button"
              disabled={saving}
              onClick={() => ports.dispatch({ input: 'project-save' })}
            >{saving ? 'Saving…' : 'Save .worktree.json'}</button>
          </div>
        </>
      )}
    </ConfigurationSection>
  )
}
