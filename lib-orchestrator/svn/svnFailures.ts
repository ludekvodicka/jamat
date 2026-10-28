import { XMLParser } from 'fast-xml-parser'

import type { CommandOutcome } from '../shared/commandInvoker.types'
import { JsonShape } from '../shared/jsonShape'
import type { SvnErrorCode } from './svn.types'

export type SvnFailureClass = 'out-of-date' | 'locked' | 'auth' | 'network' | 'conflict' | 'other'

export class SvnFailures {
  static classify(output: string, _exitCode: number | null): SvnFailureClass {
    if (/E155011|E160028|E170004|E160024|E160042|out.of.date/i.test(output)) return 'out-of-date'
    if (/E155004|E155037|is locked/i.test(output)) return 'locked'
    if (/E170001|E215004|E230001|Authentication failed/i.test(output)) return 'auth'
    if (/E170013|E175012|E731001/i.test(output)) return 'network'
    if (/E155015/i.test(output)) return 'conflict'
    return 'other'
  }

  static revisionOf(output: string): number | null {
    const revision = Number(/(?:^|\n)Committed revision (\d+)\.\s*(?:$|\n)/.exec(output)?.[1])
    return Number.isSafeInteger(revision) && revision > 0 ? revision : null
  }

  static infoRevisionOf(xml: string): number | null {
    const parsed = JsonShape.record(new XMLParser({ ignoreAttributes: false }).parse(xml))
    const revision = Number(JsonShape.record(JsonShape.record(parsed?.info)?.entry)?.['@_revision'])
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : null
  }

  static failureOf(outcome: CommandOutcome): { code: SvnErrorCode; detail: string } {
    const output = [outcome.stdout.trim(), outcome.stderr.trim()].filter(Boolean).join('\n') || `svn could not run (${outcome.failure ?? outcome.code})`
    const kind = SvnFailures.classify(output, outcome.code)
    if (outcome.failure === 'command-missing') return { code: 'svn-missing', detail: output }
    switch (kind) {
      case 'out-of-date': case 'locked': return { code: kind, detail: output }
      case 'auth': return { code: 'svn-failed', detail: `svn sign-in needed: open TortoiseSVN and sign in\n${output}` }
      case 'network': case 'conflict': case 'other':
        return { code: /E155007|not a working copy/i.test(output) ? 'not-a-working-copy' : 'svn-failed', detail: output }
      default: throw new Error(`Unknown SVN failure class: ${JSON.stringify(kind satisfies never)}`)
    }
  }
}
