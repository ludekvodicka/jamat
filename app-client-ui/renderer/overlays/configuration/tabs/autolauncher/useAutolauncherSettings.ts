import { useEffect, useRef, useState } from 'react'

import type { IpcResult } from '../../../../../shared/appClientUiIpc'
import { AppClientUiReport } from '../../../../../shared/appClientUiReport'
import type { AutolauncherResult, AutolauncherSnapshot } from '../../../../../shared/autolauncher'
import { IpcSnapshotReader } from '../../../../ipc/ipcSnapshotReader'

type AutolauncherCommand = 'enable' | 'disable'

interface AutolauncherSettingsState {
  snapshot: AutolauncherSnapshot | null
  invitation: string
  pending: AutolauncherCommand | null
  failedCommand: AutolauncherCommand | null
  problem: string | null
  readProblem: string | null
  outcome: string | null
}

interface AutolauncherSettingsLifetime {
  revision: number
  reader: IpcSnapshotReader<{ snapshot: AutolauncherSnapshot; revision: number }>
}

export function useAutolauncherSettings(onDirtyChange: (dirty: boolean) => void) {
  const [state, setState] = useState<AutolauncherSettingsState>({
    snapshot: null,
    invitation: '',
    pending: null,
    failedCommand: null,
    problem: null,
    readProblem: null,
    outcome: null,
  })
  const stateRef = useRef(state)
  const lifetime = useRef<AutolauncherSettingsLifetime | null>(null)
  const dirtyChange = useRef(onDirtyChange)
  dirtyChange.current = onDirtyChange

  function update(change: Partial<AutolauncherSettingsState>): void {
    stateRef.current = { ...stateRef.current, ...change }
    setState(stateRef.current)
  }

  useEffect(() => {
    dirtyChange.current(state.invitation.trim().length > 0 && state.pending === null)
  }, [state.invitation, state.pending])

  useEffect(() => {
    const current: AutolauncherSettingsLifetime = {
      revision: 0,
      reader: new IpcSnapshotReader(
        {
          subject: 'The Autolauncher status',
          read: async () => {
            const revision = current.revision
            try {
              const answer = await window.appClient.autolauncher.get()
              if (!answer.ok)
                return { ok: false, error: 'The main process did not answer' }
              return { ok: true, value: { snapshot: answer.value, revision } }
            } catch {
              return { ok: false, error: 'The main process did not answer' }
            }
          },
          subscribe: (onChanged) => window.appClient.onAutolauncherChanged((snapshot) => {
            if (lifetime.current !== current) return
            current.revision += 1
            update({ snapshot })
            onChanged()
          }),
          reportError: (message) => AppClientUiReport.error(message),
        },
        (answer) => {
          // A push or command may have overtaken the read before it answered.
          if (lifetime.current === current && answer.revision === current.revision)
            update({ snapshot: answer.snapshot })
        },
        (readProblem) => {
          if (lifetime.current === current)
            update({ readProblem })
        },
      ),
    }
    lifetime.current = current
    const dispose = current.reader.start()
    return () => {
      lifetime.current = null
      dispose()
    }
  }, [])

  async function run(command: AutolauncherCommand, reuseSavedConnection = false): Promise<void> {
    const current = lifetime.current
    const { snapshot, pending, invitation } = stateRef.current
    if (current === null || snapshot === null || !snapshot.supported
      || pending !== null || snapshot.operation !== 'idle') return
    if (command === 'enable') {
      if (!snapshot.connectionReady && invitation.trim().length === 0) return
      if (reuseSavedConnection && !snapshot.connectionReady) return
    } else if (command === 'disable') {
      if (!snapshot.installed || !snapshot.installedForThisProfile) return
    } else throw new Error('Unknown Autolauncher command')

    current.revision += 1
    const revision = current.revision
    update({ pending: command, failedCommand: null, problem: null, outcome: null })
    try {
      let answer: IpcResult<AutolauncherResult>
      let outcome: string
      if (command === 'enable') {
        answer = await window.appClient.autolauncher.enable(
          !reuseSavedConnection && invitation.trim().length > 0 ? invitation : null,
        )
        outcome = 'Autolauncher enabled for this Jamat.'
      } else if (command === 'disable') {
        answer = await window.appClient.autolauncher.disable()
        outcome = 'Autolauncher disabled.'
      } else throw new Error('Unknown Autolauncher command')
      if (lifetime.current !== current) return
      if (!answer.ok)
        update({ failedCommand: command, problem: 'The main process did not answer. Refresh the status before trying again.' })
      else if (!answer.value.ok)
        update({ failedCommand: command, problem: safeProblem(answer.value.problem, invitation) })
      else {
        update({
          ...(revision === current.revision ? { snapshot: answer.value.snapshot } : {}),
          ...(command === 'enable' ? { invitation: '' } : {}),
          outcome,
        })
      }
    } catch {
      if (lifetime.current === current)
        update({ failedCommand: command, problem: 'The main process did not answer. Refresh the status before trying again.' })
    } finally {
      if (lifetime.current === current) {
        // Also invalidate reads started during a command, including commands that failed.
        current.revision += 1
        update({ pending: null })
        current.reader.refresh()
      }
    }
  }

  return {
    state,
    setInvitation: (invitation: string): void => {
      if (stateRef.current.pending === null)
        update({ invitation, failedCommand: null, problem: null, outcome: null })
    },
    enable: (): void => { void run('enable') },
    retrySavedConnection: (): void => { void run('enable', true) },
    disable: (): void => { void run('disable') },
    refresh: (): void => lifetime.current?.reader.refresh(),
  }
}

function safeProblem(problem: string, invitation: string): string {
  if (invitation.trim().length > 0 && problem.includes(invitation.trim()))
    return 'Autolauncher setup failed. Check the invitation and try again.'
  return problem
}
