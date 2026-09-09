import { JsonShape } from '../../shared/jsonShape'
import { JsonNumber } from '../../shared/jsonNumber'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ClaudeConfigHome } from '../../shared/claudeConfigHome'
import { ErrorText } from '../../shared/errorText'

/**
 * What this process may know about the login: a bearer token to spend on one request, and when it
 * stops being one. The file holds a refresh token too; it is never read out of the parsed document,
 * because rotating it would break the authentication of the Claude Code that owns the file.
 */
export type ClaudeCredentialsReading =
  | { kind: 'ok'; accessToken: string; expiresAt: number | null }
  | { kind: 'missing'; reason: string }

/**
 * The OAuth login Claude Code wrote for itself, read and never written. The file belongs to another
 * program: it is created at `/login` and rewritten whenever that program refreshes the token, and
 * this library's whole part in it is to look. Nothing here repairs, migrates or latches it, because
 * a credentials file this process disagreed with would be a login the user then has to redo.
 *
 * Both endings are values. A machine that never logged in, and one logged in with an API key
 * instead, are ordinary states of a monitor and not failures anybody upstack can act on.
 */
export class ClaudeCredentialsReader {
  private static readonly fileNameConst = '.credentials.json'
  /**
   * A bearer token is visible ASCII, and a value that is not one is worth refusing HERE rather than
   * at the request. `fetch` rejects a header holding a NUL or a line break before it sends anything,
   * and its message quotes the WHOLE header value back - which is how a token reaches a `reason`, an
   * IPC message and a tooltip. So the value is checked, and never echoed.
   */
  private static readonly tokenCharsetConst = /^[\x21-\x7E]+$/

  private readonly file: string

  constructor(claudeHome: string = ClaudeConfigHome.resolve()) {
    this.file = join(claudeHome, ClaudeCredentialsReader.fileNameConst)
  }

  async read(): Promise<ClaudeCredentialsReading> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return { kind: 'missing', reason: `no Claude credentials at ${this.file}` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return { kind: 'missing', reason: `${this.file} is not readable JSON (${ErrorText.of(error)})` }
    }
    // Narrowed field by field out of `unknown`, the way every document off a disk is read here: what
    // is in that file is whatever the other program last wrote, not what this type says it is.
    const oauth = JsonShape.record(
      JsonShape.record(parsed)?.['claudeAiOauth'],
    )
    if (oauth === null)
      return {
        kind: 'missing',
        reason: `${this.file} holds no claudeAiOauth section, so this machine is not logged in with `
          + 'a Claude subscription',
      }
    const accessToken = oauth['accessToken']
    if (typeof accessToken !== 'string' || accessToken.length === 0)
      return { kind: 'missing', reason: `${this.file} holds no OAuth access token` }
    if (!ClaudeCredentialsReader.tokenCharsetConst.test(accessToken))
      return {
        kind: 'missing',
        reason: `${this.file} holds an OAuth access token that is not one - the credentials look `
          + 'corrupt, and logging in again with Claude Code rewrites them',
      }
    // Composed field by field. A spread here would carry the refresh token, the scopes and whatever
    // that program decides to keep in there next, out of the one place they belong.
    return {
      kind: 'ok',
      accessToken,
      expiresAt: JsonNumber.finite(oauth['expiresAt']),
    }
  }

}
