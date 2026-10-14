/**
 * Parent transcript lines in the shapes Claude Code 2.1.x writes for background tasks into
 * `<projectDir>/<sessionId>.jsonl`.
 *
 * `realShells` is cut from a session of this project: a `Bash` call moved to the background by its
 * 120 s timeout (no `run_in_background`, the ctrl+b shape) and one started with
 * `run_in_background`, their launches, the interim records and the notifications in their order and
 * with their fields; the environment details are left out and the output root is neutralized.
 */
export class ClaudeShellFixtures {
  static readonly sessionIdConst = '4fe1fc81-0413-4b4e-9587-23be8cd35f2d'
  static readonly outputRootConst = 'D:\\Temp\\claude\\Q--Work-App\\4fe1fc81-0413-4b4e-9587-23be8cd35f2d\\tasks'

  static realShells(): string {
    return [
      ClaudeShellFixtures.bashUse('toolu_018JaJXMzfhYUvD4s84vjfg5', {
        command: 'grep -rn "does not provide an export" skills app-client-cli',
        description: 'Find CLI wrapper and refusal message source',
      }, '2026-10-02T05:37:16.902Z'),
      ClaudeShellFixtures.launch('toolu_018JaJXMzfhYUvD4s84vjfg5', 'b63xl0o9b', '2026-10-02T05:39:17.008Z', {
        movedByTimeout: true,
      }),
      ClaudeShellFixtures.notification('b63xl0o9b', 'completed', '2026-10-02T05:39:26.684Z', {
        toolUseId: 'toolu_018JaJXMzfhYUvD4s84vjfg5',
        summary: 'Background command "Find CLI wrapper and refusal message source" completed (exit code 0)',
      }),
      ClaudeShellFixtures.dequeue('b63xl0o9b', 'completed', '2026-10-02T05:39:28.269Z'),
      ClaudeShellFixtures.bashUse('toolu_014rYLQJk4QFS6GUSR33aeGt', {
        command: 'bash ~/.claude/scripts/commit-svn.sh openwait "Q:/Work/App/skills"\n"[App] Pin the CLI wrapper"',
        description: 'Open Jamat SVN review and wait for result',
        run_in_background: true,
      }, '2026-10-02T06:13:02.110Z'),
      ClaudeShellFixtures.launch('toolu_014rYLQJk4QFS6GUSR33aeGt', 'bk8euh7vf', '2026-10-02T06:13:03.546Z'),
      ClaudeShellFixtures.readUse('toolu_01HecT6pgraCKZRjwudEydcY', `${ClaudeShellFixtures.outputRootConst}\\bk8euh7vf.output`, '2026-10-02T06:13:05.380Z'),
      ClaudeShellFixtures.toolResult('toolu_01HecT6pgraCKZRjwudEydcY', '1\tPROJECT: App', '2026-10-02T06:13:05.441Z'),
      ClaudeShellFixtures.notification('bk8euh7vf', 'completed', '2026-10-02T06:13:24.215Z', {
        toolUseId: 'toolu_014rYLQJk4QFS6GUSR33aeGt',
        summary: 'Background command "Open Jamat SVN review and wait for result" completed (exit code 0)',
      }),
      ClaudeShellFixtures.notificationTurn('bk8euh7vf', 'completed', '2026-10-02T06:13:24.238Z'),
    ].join('')
  }

  static bashUse(toolUseId: string, input: Record<string, unknown>, at: string): string {
    return ClaudeShellFixtures.toolUse(toolUseId, 'Bash', input, at)
  }

  static readUse(toolUseId: string, filePath: string, at: string): string {
    return ClaudeShellFixtures.toolUse(toolUseId, 'Read', { file_path: filePath }, at)
  }

  static monitorUse(toolUseId: string, at: string): string {
    return ClaudeShellFixtures.toolUse(toolUseId, 'Monitor', { command: 'tail -f build.log' }, at)
  }

  /** The `user` record that answers a background `Bash` call with its `b<id>`. */
  static launch(toolUseId: string, shellId: string, at: string, options: { movedByTimeout?: boolean } = {}): string {
    const output = `${ClaudeShellFixtures.outputRootConst}\\${shellId}.output`
    const text = options.movedByTimeout === true
      ? `Command did not complete within its 120s timeout and was moved to the background (ID: ${shellId}). Output is being written to: ${output}. You will be notified when it completes.`
      : `Command running in background with ID: ${shellId}. Output is being written to: ${output}. You will be notified when it completes. To check interim output, use Read on that file path.`
    return ClaudeShellFixtures.line({
      parentUuid: 'p-1',
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: text, is_error: false }] },
      timestamp: at,
      toolUseResult: {
        stdout: '',
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
        backgroundTaskId: shellId,
        ...options.movedByTimeout === true ? { timedOutAfterMs: 120_000 } : {},
      },
      sessionId: ClaudeShellFixtures.sessionIdConst,
    })
  }

  /** A Monitor answers with `taskId`, not `backgroundTaskId`: it is no shell. */
  static monitorLaunch(toolUseId: string, taskId: string, at: string): string {
    return ClaudeShellFixtures.line({
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: `Monitor started (task ${taskId}).` }] },
      timestamp: at,
      toolUseResult: { taskId, timeoutMs: 1_800_000, persistent: false },
    })
  }

  static toolResult(toolUseId: string, text: string, at: string): string {
    return ClaudeShellFixtures.line({
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: text }] },
      timestamp: at,
    })
  }

  /** The `queue-operation` enqueue Claude Code writes when a background task ends. */
  static notification(
    taskId: string,
    status: string,
    at: string,
    options: { toolUseId?: string; summary?: string } = {},
  ): string {
    return ClaudeShellFixtures.line({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: at,
      sessionId: ClaudeShellFixtures.sessionIdConst,
      content: ClaudeShellFixtures.notificationText(taskId, status, options),
    })
  }

  /** The same notification taken off the queue; it repeats the enqueue and is not read. */
  static dequeue(taskId: string, status: string, at: string): string {
    return ClaudeShellFixtures.line({
      type: 'queue-operation',
      operation: 'remove',
      timestamp: at,
      sessionId: ClaudeShellFixtures.sessionIdConst,
      content: ClaudeShellFixtures.notificationText(taskId, status, {}),
      reason: 'absorbed_mid_turn',
    })
  }

  /** The `user` turn that delivers a notification to an idle agent. */
  static notificationTurn(taskId: string, status: string, at: string): string {
    return ClaudeShellFixtures.line({
      type: 'user',
      message: { role: 'user', content: ClaudeShellFixtures.notificationText(taskId, status, {}) },
      timestamp: at,
      origin: { kind: 'task-notification', producer: 'session-task' },
      promptSource: 'system',
    })
  }

  /** A `TaskStop` call and its result, the only end a stopped task gets (worker-agent session, 2026-10-12). */
  static taskStop(toolUseId: string, taskId: string, taskType: string, command: string, at: string): string {
    const result = { message: `Successfully stopped task: ${taskId} (${command})`, task_id: taskId, task_type: taskType, command }
    return ClaudeShellFixtures.toolUse(toolUseId, 'TaskStop', { task_id: taskId }, at)
      + ClaudeShellFixtures.line({
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: JSON.stringify(result) }] },
        timestamp: at,
        toolUseResult: result,
      })
  }

  /** A `TaskStop` that found nothing to stop: its result is an error string. */
  static taskStopRefused(toolUseId: string, taskId: string, at: string): string {
    const text = `Error: Task ${taskId} is not running (status: completed)`
    return ClaudeShellFixtures.toolUse(toolUseId, 'TaskStop', { task_id: taskId }, at)
      + ClaudeShellFixtures.line({
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: text, is_error: true }] },
        timestamp: at,
        toolUseResult: text,
      })
  }

  static assistantText(text: string, at: string): string {
    return ClaudeShellFixtures.line({
      type: 'assistant',
      message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
      timestamp: at,
    })
  }

  /** One record of about `bytes` bytes that names nothing the scan looks for. */
  static filler(bytes: number, at = '2026-10-02T06:00:00.000Z'): string {
    return ClaudeShellFixtures.line({ type: 'progress', data: 'x'.repeat(Math.max(0, bytes - 60)), timestamp: at })
  }

  static notificationText(taskId: string, status: string, options: { toolUseId?: string; summary?: string }): string {
    return [
      '<task-notification>',
      `<task-id>${taskId}</task-id>`,
      ...options.toolUseId === undefined ? [] : [`<tool-use-id>${options.toolUseId}</tool-use-id>`],
      `<output-file>${ClaudeShellFixtures.outputRootConst}\\${taskId}.output</output-file>`,
      `<status>${status}</status>`,
      `<summary>${options.summary ?? `Background command ${status}`}</summary>`,
      '</task-notification>',
    ].join('\n')
  }

  private static toolUse(toolUseId: string, name: string, input: Record<string, unknown>, at: string): string {
    return ClaudeShellFixtures.line({
      parentUuid: 'p-0',
      isSidechain: false,
      type: 'assistant',
      message: {
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name, input, caller: { type: 'direct' } }],
        stop_reason: 'tool_use',
      },
      timestamp: at,
    })
  }

  private static line(record: Record<string, unknown>): string {
    return `${JSON.stringify(record)}\n`
  }
}
