import { useEffect } from 'react'
import { useLayoutStore } from '../store/layout-store'
import type { ControlOpenTabPayload } from '../../../../core/types/remote-control'

/**
 * Controlled side: a remote peer asked to open a tab here (payload already
 * server-resolved + path-validated). We create the tab as a local user would,
 * then — for tabs taking an initial command — inject it once the tab is
 * promptable.
 *
 * There's no explicit "PTY ready" signal (only `pty:output`/`pty:exit`), and a
 * claude tab goes shell→menu→Claude before its prompt appears, so a blind delay
 * is unreliable. We wait for output to *settle*: after the first data, ~1s of
 * quiet means the prompt rendered and the program is idle → type the command.
 * Hard cap at 30s. All pending injections are tied to the effect lifecycle so a
 * fast tab-close / unmount can't leak the `pty:output` listener or the timers.
 */
export function useControlOpenTab(): void {
  useEffect(() => {
    if (!window.electronAPI?.onControlOpenTab) return
    const api = window.electronAPI
    const pending = new Set<() => void>()

    const injectWhenReady = (terminalId: string, command: string) => {
      let settle: ReturnType<typeof setTimeout> | null = null
      let hard: ReturnType<typeof setTimeout> | null = null
      let sawData = false
      let remove: () => void = () => {}

      const cleanup = () => {
        pending.delete(cleanup)
        remove()
        if (settle) clearTimeout(settle)
        if (hard) clearTimeout(hard)
      }
      const fire = () => {
        cleanup()
        // Only write if the target tab still exists (user may have closed it).
        if (useLayoutStore.getState().dockviewApi?.getPanel(terminalId)) {
          api.writeTerminal(terminalId, command.endsWith('\n') || command.endsWith('\r') ? command : command + '\r')
        }
      }

      pending.add(cleanup)
      remove = api.onTerminalData((id: string) => {
        if (id !== terminalId) return
        sawData = true
        if (settle) clearTimeout(settle)
        settle = setTimeout(fire, 1000)
      })
      hard = setTimeout(() => { if (sawData) fire(); else cleanup() }, 30000)
    }

    const off = api.onControlOpenTab((payload: ControlOpenTabPayload) => {
      const dock = useLayoutStore.getState().dockviewApi
      if (!dock) return
      // Prefer the caller-chosen id (so the controller can open a viewer for this
      // exact tab immediately); fall back to a generated one.
      const id = payload.terminalId && /^[\w:-]{1,128}$/.test(payload.terminalId) && !dock.getPanel(payload.terminalId)
        ? payload.terminalId
        : `${payload.tabType}-${crypto.randomUUID()}`
      let params: Record<string, unknown>
      let title: string
      // Jamat-opened tabs get `ai-claude-…`/`ai-codex-…` ids. Such a tab is named by its
      // TASK (the controller sends it as `folderName`), shown bare — the 🤖 badge + violet
      // styling that mark it as AI-managed/ephemeral come from CustomTab, keyed on this prefix.
      const isAi = id.startsWith('ai-')

      if (payload.tabType === 'claude') {
        if (payload.cmd === 'resume-fork' && payload.cwd && payload.sessionId) {
          // A forked peer session: resume the parent's transcript under a NEW session id
          // (`claude -r <id> --fork-session`) so the controller can drive it separately from
          // the original. Same restoreMeta path as a local fork (see TerminalSidebarPanel).
          params = { projectDir: payload.cwd, folderName: payload.folderName ?? 'fork', cmd: 'resume-fork', sessionId: payload.sessionId, agent: 'claude' }
          title = isAi ? (payload.folderName ?? 'AI fork') : `${payload.folderName ?? 'Claude'} — fork (remote)`
        } else if (payload.cwd) {
          // restoreMeta path: projectDir + folderName + cmd ∈ {cc,…} launches
          // Claude directly in the chosen project (see TerminalSidebarPanel).
          params = { projectDir: payload.cwd, folderName: payload.folderName ?? 'project', cmd: 'cc', agent: 'claude' }
          title = isAi ? (payload.folderName ?? 'AI task') : `${payload.folderName ?? 'Claude'} — Claude (remote)`
        } else {
          params = {}
          title = isAi ? 'AI task' : 'Claude (remote)'
        }
      } else {
        // Win: honor the requested shell. POSIX has no cmd/powershell → leave command undefined so
        // the main process spawns the default shell; keeping tabType routes it to the plain-shell
        // path (not the Claude menu) — see TerminalSidebarPanel's screenManaged.
        const command = api.platform === 'win32' ? (payload.tabType === 'cmd' ? 'cmd.exe' : 'powershell.exe') : undefined
        params = { tabType: payload.tabType, command, cwd: payload.cwd }
        title = `${payload.tabType === 'cmd' ? 'CMD' : 'PowerShell'} (remote)`
      }

      // `activate === false` → open silently: add the panel inactive so the tab the human
      // (or another session) had active here stays active. Absent/true → focus it (legacy).
      const activate = payload.activate !== false
      // A control-opened tab must launch its PTY IMMEDIATELY, even when added inactive — otherwise the
      // lazy-launch gate (which defers a hidden tab's spawn until it's shown) would leave a silently-
      // opened tab with no PTY, and the remote/AI controller could never drive it (write-keys/
      // scrollback → not_found). `eager` forces the immediate launch; the gate still governs restore.
      params.eager = true
      dock.addPanel({ id, component: 'terminalPanel', title, params, inactive: !activate })
      if (activate) { try { dock.getPanel(id)?.api.setActive() } catch { /* ignore */ } }

      // Inject the initial command only where it lands on a real prompt: a shell
      // tab, or a Claude tab that launched into a project (not the menu).
      const canInject = !!payload.command && (payload.tabType !== 'claude' || !!payload.cwd)
      if (canInject) injectWhenReady(id, payload.command!)
    })

    return () => { off(); for (const c of [...pending]) c() }
  }, [])
}
