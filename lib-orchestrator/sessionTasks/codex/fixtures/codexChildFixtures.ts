import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Child-thread rollout lines in the shapes Codex CLI 0.162 writes into
 * `<codexHome>/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`.
 *
 * Cut from local rollouts: a multi-agent v1 child (`Kuhn`, plaintext task as a user message) and a
 * v2 child (`Jason`, task as an encrypted `agent_message`). Long texts are shortened, account ids,
 * instructions and encrypted payloads replaced.
 */
export class CodexChildFixtures {
  static readonly parentThreadIdConst = '01a12c26-65d1-7ab1-8b4c-74415e5e574a'
  static readonly firstChildIdConst = '01a12c2c-01a9-7f51-886b-bd8d9e366e38'
  static readonly secondChildIdConst = '01a12c2d-3c4a-7c72-980a-4edf7b22a6cc'
  static readonly grandchildIdConst = '01a12c2e-4361-7410-899b-d4c8900cc116'
  static readonly strangerIdConst = '01a12c2f-2beb-73f1-ac39-9696d8012288'
  static readonly cwdConst = 'Q:\\ApplicationsAi\\Plugins'

  /** The `session_meta` line; `parentThreadId` null writes a session the user started. */
  static header(threadId: string, parentThreadId: string | null, nickname: string | null, at: string): string {
    const child = parentThreadId === null
      ? { source: 'cli', thread_source: 'user' }
      : {
        parent_thread_id: parentThreadId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentThreadId,
              depth: 1,
              agent_path: '/root/u15_source_contracts',
              agent_nickname: nickname,
              agent_role: null,
            },
          },
        },
        thread_source: 'subagent',
        agent_nickname: nickname,
      }
    return CodexChildFixtures.line(at, 'session_meta', {
      session_id: parentThreadId ?? threadId,
      id: threadId,
      ...(parentThreadId === null ? {} : { parent_thread_id: parentThreadId }),
      timestamp: at,
      cwd: CodexChildFixtures.cwdConst,
      originator: 'codex-tui',
      cli_version: '0.162.0',
      ...child,
      model_provider: 'openai',
      base_instructions: {
        text: 'You are Codex. A quoted "parent_thread_id":"ffffffff-0000-0000-0000-000000000000" here is no field.',
      },
      multi_agent_version: 'v2',
    })
  }

  static taskStarted(at: string): string {
    return CodexChildFixtures.line(at, 'event_msg', { type: 'task_started', turn_id: 'turn-1' })
  }

  static agentsInstructions(at: string): string {
    return CodexChildFixtures.userMessage('# AGENTS.md instructions\n\n<INSTRUCTIONS>\nGlobal rules\n</INSTRUCTIONS>', at)
  }

  static turnContext(model: string, at: string): string {
    return CodexChildFixtures.line(at, 'turn_context', { turn_id: 'turn-1', cwd: CodexChildFixtures.cwdConst, model })
  }

  /** A v1 task: the parent's prompt as a plain user message. */
  static plainTask(text: string, at: string): string {
    return CodexChildFixtures.userMessage(text, at)
  }

  /** A v2 task: a plaintext envelope around an encrypted payload. */
  static encryptedTask(at: string): string {
    return CodexChildFixtures.line(at, 'response_item', {
      type: 'agent_message',
      author: '/root',
      recipient: '/root/u15_source_contracts',
      content: [
        { type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/u15_source_contracts\nSender: /root\nPayload:\n' },
        { type: 'encrypted_content', encrypted_content: 'gAAAAABqy9Hs2mAETAlV5a48UaDMq4IYJRj7ENsPCSho7a5AFhM6i44e' },
      ],
    })
  }

  static reasoning(at: string): string {
    return CodexChildFixtures.line(at, 'response_item', {
      type: 'reasoning',
      summary: [],
      encrypted_content: 'gAAAAABqyMR42LxXxUk21HwSZXAX0f0dhivRzLy1FcxcKZhKekPjosUMO3txcYhRu',
    })
  }

  static execCall(command: string, at: string): string {
    return CodexChildFixtures.line(at, 'response_item', {
      type: 'custom_tool_call',
      status: 'completed',
      call_id: 'call_1',
      name: 'exec',
      input: `text(await tools.exec_command({cmd:${JSON.stringify(command)},"shell":"powershell"}));\n`,
    })
  }

  static commandDone(command: string, at: string, output = '', exitCode = 0): string {
    return CodexChildFixtures.line(at, 'event_msg', {
      type: 'item_completed',
      item: {
        type: 'CommandExecution',
        id: 'exec-1',
        command: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-Command', command],
        parsed_cmd: [{ type: 'read', cmd: command }],
        status: exitCode === 0 ? 'completed' : 'failed',
        aggregated_output: output,
        exit_code: exitCode,
      },
    })
  }

  /** A patch the current CLI applied: only this item records it, no `patch_apply_end`. */
  static fileChange(changes: Record<string, Record<string, unknown>>, at: string): string {
    return CodexChildFixtures.line(at, 'event_msg', {
      type: 'item_completed',
      item: { type: 'FileChange', id: 'exec-2', changes, status: 'completed', stdout: 'Success.', stderr: '' },
    })
  }

  /** A patch as older CLIs record it. */
  static patchApplyEnd(changes: Record<string, Record<string, unknown>>, success: boolean, at: string): string {
    return CodexChildFixtures.line(at, 'event_msg', { type: 'patch_apply_end', call_id: 'call_2', success, changes })
  }

  static tokenCount(totalTokens: number, at: string): string {
    return CodexChildFixtures.line(at, 'event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: totalTokens * 3, total_tokens: totalTokens * 3 },
        last_token_usage: { input_tokens: totalTokens - 200, output_tokens: 200, total_tokens: totalTokens },
        model_context_window: 258_400,
      },
    })
  }

  /** The child's report to its parent; a v2 child sends it encrypted. */
  static sendMessage(message: string, at: string): string {
    return CodexChildFixtures.line(at, 'response_item', {
      type: 'function_call',
      name: 'send_message',
      namespace: 'collaboration',
      arguments: JSON.stringify({ target: '/root', message }),
      call_id: 'call_3',
    })
  }

  static assistantText(text: string, at: string): string {
    return CodexChildFixtures.line(at, 'response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    })
  }

  static taskComplete(at: string): string {
    return CodexChildFixtures.line(at, 'event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'Done.' })
  }

  static turnAborted(reason: string, at: string): string {
    return CodexChildFixtures.line(at, 'event_msg', { type: 'turn_aborted', turn_id: 'turn-1', reason })
  }

  /** A v1 child that listed a directory and reported back. */
  static plainChild(threadId: string, parentThreadId: string, nickname: string, ending: string | null): string {
    return [
      CodexChildFixtures.header(threadId, parentThreadId, nickname, '2026-10-11T18:14:03.946Z'),
      CodexChildFixtures.taskStarted('2026-10-11T18:14:04.060Z'),
      CodexChildFixtures.agentsInstructions('2026-10-11T18:14:04.100Z'),
      CodexChildFixtures.turnContext('gpt-6-astra', '2026-10-11T18:14:04.120Z'),
      CodexChildFixtures.plainTask('\r\nList the files in docs/architecture and report back.\nKeep it short.', '2026-10-11T18:14:04.150Z'),
      CodexChildFixtures.reasoning('2026-10-11T18:14:05.000Z'),
      CodexChildFixtures.execCall('Get-ChildItem docs/architecture', '2026-10-11T18:14:05.100Z'),
      CodexChildFixtures.commandDone('Get-ChildItem docs/architecture', '2026-10-11T18:14:06.000Z'),
      CodexChildFixtures.assistantText('Twelve files.', '2026-10-11T18:14:07.000Z'),
      ...(ending === null ? [] : [ending]),
    ].join('')
  }

  /** A v1 child that listed a directory, patched two files and reported back, with model and tokens. */
  static workedChild(threadId: string, parentThreadId: string, nickname: string): string {
    return [
      CodexChildFixtures.header(threadId, parentThreadId, nickname, '2026-10-11T18:14:03.946Z'),
      CodexChildFixtures.taskStarted('2026-10-11T18:14:04.060Z'),
      CodexChildFixtures.agentsInstructions('2026-10-11T18:14:04.100Z'),
      CodexChildFixtures.turnContext('gpt-6-astra', '2026-10-11T18:14:04.120Z'),
      CodexChildFixtures.plainTask('\r\nList the files in docs/architecture and report back.\nKeep it short.', '2026-10-11T18:14:04.150Z'),
      CodexChildFixtures.reasoning('2026-10-11T18:14:05.000Z'),
      CodexChildFixtures.execCall('Get-ChildItem docs/architecture', '2026-10-11T18:14:05.100Z'),
      CodexChildFixtures.commandDone('Get-ChildItem docs/architecture', '2026-10-11T18:14:06.000Z', 'Mode  Name\r\n-a--  layout.md\r\n'),
      CodexChildFixtures.tokenCount(24_000, '2026-10-11T18:14:06.100Z'),
      CodexChildFixtures.fileChange({
        'Q:\\ApplicationsAi\\Plugins\\docs\\index.md': {
          type: 'update',
          unified_diff: '@@ -1,2 +1,3 @@\n # Index\n-old line\n+new line\n+added line\n',
          move_path: null,
        },
        'Q:\\ApplicationsAi\\Plugins\\docs\\new.md': { type: 'add', content: 'one\ntwo\n' },
      }, '2026-10-11T18:14:06.500Z'),
      CodexChildFixtures.assistantText('Twelve files.', '2026-10-11T18:14:07.000Z'),
      CodexChildFixtures.tokenCount(25_164, '2026-10-11T18:14:07.100Z'),
      CodexChildFixtures.taskComplete('2026-10-11T18:14:07.200Z'),
    ].join('')
  }

  /** A v2 child whose task arrived encrypted. */
  static encryptedChild(threadId: string, parentThreadId: string, nickname: string): string {
    return [
      CodexChildFixtures.header(threadId, parentThreadId, nickname, '2026-10-11T18:20:00.000Z'),
      CodexChildFixtures.taskStarted('2026-10-11T18:20:00.100Z'),
      CodexChildFixtures.agentsInstructions('2026-10-11T18:20:00.200Z'),
      CodexChildFixtures.turnContext('gpt-6-astra', '2026-10-11T18:20:00.300Z'),
      CodexChildFixtures.encryptedTask('2026-10-11T18:20:00.400Z'),
      CodexChildFixtures.execCall('Get-Content AGENTS.md', '2026-10-11T18:20:01.000Z'),
      CodexChildFixtures.taskComplete('2026-10-11T18:21:00.000Z'),
    ].join('')
  }

  /** Writes one rollout where Codex files it: under the LOCAL date and time it started. */
  static write(codexHome: string, startedAt: Date, threadId: string, content: string): string {
    const pad = (value: number): string => String(value).padStart(2, '0')
    const day = join(
      codexHome,
      'sessions',
      String(startedAt.getFullYear()),
      pad(startedAt.getMonth() + 1),
      pad(startedAt.getDate()),
    )
    mkdirSync(day, { recursive: true })
    const stamp = `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}`
      + `T${pad(startedAt.getHours())}-${pad(startedAt.getMinutes())}-${pad(startedAt.getSeconds())}`
    const file = join(day, `rollout-${stamp}-${threadId}.jsonl`)
    writeFileSync(file, content, 'utf8')
    return file
  }

  private static userMessage(text: string, at: string): string {
    return CodexChildFixtures.line(at, 'response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    })
  }

  private static line(at: string, type: string, payload: Record<string, unknown>): string {
    return `${JSON.stringify({ timestamp: at, type, payload })}\n`
  }
}
