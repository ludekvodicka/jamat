import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const COLORS = ['red', 'orange', 'amber', 'green', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'magenta', 'rose']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const failure = (detail, extra = {}) => ({ ok: false, error: { code: 'automation-groups', detail, ...extra } })
const sameField = (session, field, value) => (field === 'note' ? session.note ?? '' : session[field]) === value

export class SessionAutomationGroups {
  static presentation(state, activeColor = 'blue') {
    if (!COLORS.includes(activeColor)) throw new Error(`Unknown active color: ${activeColor}`)
    switch (state) {
      case 'working': return { group: 'automation', color: activeColor }
      case 'waiting': return { group: 'waiting', color: 'orange' }
      case 'blocked': return { group: 'blocked', color: 'red' }
      case 'completed': return { group: 'completed', color: 'green' }
      default: throw new Error(`Unknown automation state: ${state}`)
    }
  }

  static apply(client, request) {
    const desired = SessionAutomationGroups.presentation(request.state, request.activeColor)
    if (!UUID.test(request.sessionId ?? '')) return failure('An exact Jamat session UUID is required')
    if (!UUID.test(request.configIdentity ?? '') || !['development', 'production'].includes(request.channel))
      return failure('An exact controller UUID and development/production channel are required')
    if (request.note !== undefined) {
      if (typeof request.note !== 'string' || request.note.length > 4000)
        return failure('The note must be a string of at most 4000 characters')
      desired.note = request.note
    }
    const status = client(['status'])
    if (!status.ok) return status
    const identity = status.value?.identity
    if (identity?.configIdentity !== request.configIdentity || identity?.runtimeChannel !== request.channel)
      return failure('Controller identity mismatch; no session was changed')
    const before = SessionAutomationGroups.read(client, request.sessionId)
    if (!before.ok) return before
    const changed = []
    // Group first: a removed/customized group must fail before color or note is changed.
    for (const [field, value] of Object.entries(desired)) {
      if (sameField(before.value, field, value)) continue
      const result = client(['sessions', field, '--session-id', request.sessionId,
        `--${field}`, value, '--operation-id', randomUUID()])
      if (!result.ok)
        return failure(`${field} was not confirmed: ${result.error?.detail ?? 'CLI failed'}`, {
          changed, failedField: field, observed: SessionAutomationGroups.read(client, request.sessionId),
        })
      changed.push(field)
    }
    const after = SessionAutomationGroups.read(client, request.sessionId)
    if (!after.ok) return failure('Could not verify the resulting session presentation', { changed, observed: after })
    const different = Object.entries(desired).filter(([field, value]) => !sameField(after.value, field, value)).map(([field]) => field)
    if (different.length)
      return failure(`Read-back differs for ${different.join(', ')}`, { changed, observed: after.value })
    return { ok: true, value: { sessionId: request.sessionId, state: request.state, ...desired, changed } }
  }

  static read(client, sessionId) {
    const result = client(['sessions', 'list'])
    if (!result.ok) return result
    const matches = result.value?.sessions?.filter(session => session.sessionId === sessionId) ?? []
    if (matches.length !== 1) return failure(`Session ${sessionId} was not found uniquely; no target was guessed`)
    return { ok: true, value: matches[0] }
  }
}

export function runCli(argv, env = process.env, launch = spawnSync) {
  try {
    const [command, ...args] = argv
    if (!['describe', 'apply'].includes(command)) throw new Error('Use describe|apply --state working|waiting|blocked|completed')
    const options = {}
    const allowed = ['state', 'active-color', 'note', 'note-file', 'session-id', 'config-identity', 'channel', 'jamat-cli']
    for (let index = 0; index < args.length; index++) {
      const name = args[index].replace(/^--/, '')
      if (!args[index].startsWith('--') || ![...allowed, 'self'].includes(name) || name in options)
        throw new Error(`Unknown or repeated option: ${args[index]}`)
      if (name === 'self') options[name] = true
      else {
        const value = args[++index]
        if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${name}`)
        options[name] = value
      }
    }
    const presentation = SessionAutomationGroups.presentation(options.state, options['active-color'])
    if (command === 'describe') {
      if (Object.keys(options).some(key => !['state', 'active-color'].includes(key)))
        throw new Error('describe accepts only --state and --active-color')
      return { ok: true, value: presentation }
    }
    if (options.self && options['session-id']) throw new Error('Use either --self or --session-id')
    if (options.note !== undefined && options['note-file']) throw new Error('Use either --note or --note-file')
    const request = {
      state: options.state, activeColor: options['active-color'],
      sessionId: options.self ? env.JAMAT_V3_SESSION_ID : options['session-id'],
      configIdentity: options['config-identity'] ?? env.JAMAT_V3_SESSION_CONTROLLER,
      channel: options.channel ?? env.JAMAT_V3_SESSION_CHANNEL,
      ...(options['note-file'] ? { note: readFileSync(options['note-file'], 'utf8') }
        : options.note === undefined ? {} : { note: options.note }),
    }
    if (options.self && (request.configIdentity !== env.JAMAT_V3_SESSION_CONTROLLER
      || request.channel !== env.JAMAT_V3_SESSION_CHANNEL))
      throw new Error('--self cannot override its originating controller or channel')
    const wrapper = options['jamat-cli'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../appjamat-v3/scripts/jamat-v3.mjs')
    const client = args => {
      const result = launch(process.execPath, [wrapper, ...args, '--config-identity', request.configIdentity,
        '--channel', request.channel], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30000 })
      let envelope
      try { envelope = JSON.parse(result.stdout ?? '') } catch {}
      if (result.status === 0 && envelope?.ok === true) return envelope
      return failure(envelope?.error?.detail ?? result.error?.message ?? `AppJamatV3 exited ${result.status}`)
    }
    return SessionAutomationGroups.apply(client, request)
  } catch (error) {
    return failure(error.message)
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runCli(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = result.ok ? 0 : 2
}
