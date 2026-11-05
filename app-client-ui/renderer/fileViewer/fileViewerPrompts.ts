import type { MarkdownTaskLine } from '../../../lib-orchestrator/fileViewer/markdownTaskLines'
import type { PromptInsertResult } from '../shell/terminalInputRegistry'

export class FileViewerPrompts {
  static askItem(path: string, item: MarkdownTaskLine): string {
    return `Mám dotaz k ${FileViewerPrompts.clean(path)}:${item.line}${FileViewerPrompts.chapter(item.heading)}, bod „${FileViewerPrompts.quote(item.text)}“: `
  }

  static askSelection(path: string, line: number, heading: string | null, selection: string): string {
    return `Mám dotaz k ${FileViewerPrompts.clean(path)}:${line}${FileViewerPrompts.chapter(heading)}, text „${FileViewerPrompts.quote(selection)}“: `
  }

  static results(path: string, items: readonly MarkdownTaskLine[]): string {
    const open = items.filter((item) => !item.checked)
    const header = `Výsledky testu ${FileViewerPrompts.clean(path)}: potvrzeno ${items.length - open.length}/${items.length}.`
    if (open.length === 0) return header
    let text = `${header}\nNepotvrzeno (neprošlo, nebo nezkoušeno):`
    const groups = new Map<string | null, MarkdownTaskLine[]>()
    for (const item of open) {
      const group = groups.get(item.heading) ?? []
      group.push(item)
      groups.set(item.heading, group)
    }
    let included = 0
    for (const [heading, group] of groups) {
      let title = `\n\n## ${heading === null ? '(před první kapitolou)' : FileViewerPrompts.quote(heading)}`
      for (const item of group) {
        const next = `${title}\n- L${item.line}: ${FileViewerPrompts.quote(item.text)}`
        const more = open.length - included - 1
        const suffix = more > 0 ? `\n… a dalších ${more}, viz soubor` : ''
        if (included === 50 || text.length + next.length + suffix.length > 4000)
          return `${text}\n… a dalších ${open.length - included}, viz soubor`
        text += next
        title = ''
        included++
      }
    }
    return text
  }

  static clean(text: string): string {
    return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
  }

  static refusal(sessionId: string, reason: Extract<PromptInsertResult, { ok: false }>['reason']): string {
    let detail: string
    switch (reason) {
      case 'not-live': detail = 'the session is not live'; break
      case 'no-agent': detail = 'the session is not running Claude or Codex'; break
      case 'agent-waiting': detail = 'the agent is waiting for a choice or permission'; break
      case 'not-writable': detail = 'the terminal does not accept input'; break
      default: throw new Error(`Unknown prompt insert refusal: ${reason satisfies never}`)
    }
    return `Nothing was inserted into session ${sessionId}: ${detail}.`
  }

  static unavailable(sessionId: string): string {
    return `Session ${sessionId} has no local terminal in this window.`
  }

  private static chapter(heading: string | null): string {
    return heading === null ? '' : `, kapitola „${FileViewerPrompts.quote(heading)}“`
  }

  private static quote(text: string): string {
    const collapsed = FileViewerPrompts.clean(text).replace(/\s+/g, ' ').trim()
    return collapsed.length <= 300 ? collapsed : `${collapsed.slice(0, 300)}…`
  }
}
