import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RemoteControlPeerClient } from '../../lib-orchestrator/remoteControl/remoteControlPeerClient.js';
import { RemoteControlPeerChannel } from '../../lib-orchestrator/remoteControl/remoteControlPeerChannel.js';
import { RemoteControlPeerKeys } from '../../lib-orchestrator/remoteControl/remoteControlPeerKeys.js';
import { RemoteControlPairing } from '../../lib-orchestrator/remoteControl/remoteControlPairing.js';
import type { RemoteControlPeerProfile } from '../../lib-orchestrator/remoteControl/remoteControlPeerApi.types.js';
import type { RemoteControlRequestUnion, RemoteControlResponse } from '../../lib-orchestrator/remoteControl/remoteControlApi.types.js';
import type { RelayPeerIdentity, PcConfig } from './appConfig.js';
import type { PcEndpoint, PcStatus } from './pcEndpoint.js';
import { json, jsonBody } from './http.js';
import { SessionLaunch, type SessionLaunchOptions } from './sessionLaunch.js';

export class JamatPc implements PcEndpoint {
  private readonly id: string;
  private readonly profile: RemoteControlPeerProfile;
  private readonly client: RemoteControlPeerClient;
  private channel: RemoteControlPeerChannel | undefined;
  private connecting: Promise<RemoteControlPeerChannel> | undefined;
  private closed = false;

  constructor(pc: PcConfig, credentials: RelayPeerIdentity) {
    if (!pc.peer)
      throw new Error('Missing Jamat pairing');
    this.id = pc.id;
    this.profile = RemoteControlPairing.profile(pc.peer, { profileId: pc.id });
    this.client = new RemoteControlPeerClient(credentials.identity,
      payload => RemoteControlPeerKeys.sign(credentials.privateKey, payload), { connectTimeoutMilliseconds: 3000 });
  }

  async status(): Promise<PcStatus> {
    const response = await this.call({ protocol: 'appjamat-v3-control.v1', requestId: randomUUID(), operation: 'system.status', body: {} });
    if (!response.ok)
      return { online: false, detail: response.error.detail };
    return { online: true, detail: 'Jamat online', href: `/computer.html?pc=${encodeURIComponent(this.id)}` };
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const url = new URL(path, 'http://relay.invalid');
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      await this.create(req, res);
      return;
    }
    if (req.method !== 'GET') {
      json(res, { error: 'Method not allowed' }, 405);
      return;
    }
    if (url.pathname === '/api/launch-options') {
      await this.launchOptions(res);
      return;
    }
    const envelope = { protocol: 'appjamat-v3-control.v1' as const, requestId: randomUUID() };
    let request: RemoteControlRequestUnion;
    if (url.pathname === '/api/status')
      request = { ...envelope, operation: 'system.status', body: {} };
    else if (url.pathname === '/api/sessions')
      request = { ...envelope, operation: 'sessions.list', body: {} };
    else if (url.pathname === '/api/transcript' || url.pathname === '/api/terminal') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId || !/^[a-f0-9-]{36}$/i.test(sessionId)) {
        json(res, { error: 'Invalid session ID' }, 400);
        return;
      }
      request = url.pathname === '/api/transcript'
        ? { ...envelope, operation: 'sessions.transcript', body: { session: { kind: 'sessionId', sessionId } } }
        : { ...envelope, operation: 'terminal.peek', body: { session: { kind: 'sessionId', sessionId }, cols: 120, rows: 40 } };
    } else {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    const result = await this.call(request);
    json(res, result.ok ? result.value : { error: result.error.detail }, result.ok ? 200 : 503);
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
  }

  private async launchOptions(res: ServerResponse): Promise<void> {
    try {
      const channel = await this.connection();
      const envelope = { protocol: 'appjamat-v3-control.v1' as const, body: {} };
      const [projects, agents] = await Promise.all([
        channel.control({ ...envelope, requestId: randomUUID(), operation: 'projects.list' }),
        channel.transport.capabilities.includes('control:agents.describe')
          ? channel.control({ ...envelope, requestId: randomUUID(), operation: 'agents.describe' }) : null,
      ]);
      if (!projects.ok) throw new Error(projects.error.detail);
      if (agents && !agents.ok) throw new Error(agents.error.detail);
      if (projects.operation !== 'projects.list' || (agents && agents.operation !== 'agents.describe'))
        throw new Error('Unexpected launcher response');
      const options: SessionLaunchOptions = { projects: projects.value as SessionLaunchOptions['projects'],
        agents: (agents?.value ?? null) as SessionLaunchOptions['agents'],
        createAvailable: channel.transport.capabilities.includes('control:sessions.create') };
      json(res, options);
    } catch (error) {
      json(res, { error: error instanceof Error ? error.message : 'Nelze načíst projekty.' }, 503);
    }
  }

  private async create(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let request: ReturnType<typeof SessionLaunch.request>;
    try {
      request = SessionLaunch.request(await jsonBody(req));
    } catch (error) {
      json(res, { error: error instanceof Error ? error.message : 'Neplatný požadavek.', uncertain: false }, 400);
      return;
    }
    let channel: RemoteControlPeerChannel;
    try {
      channel = await this.connection();
    } catch (error) {
      json(res, { error: error instanceof Error ? error.message : 'Jamat nedostupný.', uncertain: false }, 503);
      return;
    }
    if (!channel.transport.capabilities.includes('control:sessions.create') ||
        (request.body.spec.agent?.model !== undefined && !channel.transport.capabilities.includes('control:agents.describe'))) {
      json(res, { error: 'Tento Jamat nepodporuje zvolené spuštění. Aktualizujte desktop.', uncertain: false }, 409);
      return;
    }
    const result = await channel.control(request);
    if (result.ok)
      json(res, result.value, 201);
    else {
      const uncertain = ['timeout', 'unavailable', 'operation-failed'].includes(result.error.code);
      json(res, { error: result.error.detail, code: result.error.code, operationId: request.operationId, uncertain }, uncertain ? 503 : 400);
    }
  }

  private async call(request: RemoteControlRequestUnion): Promise<RemoteControlResponse> {
    try {
      return await (await this.connection()).control(request);
    } catch (error) {
      return { protocol: request.protocol, requestId: request.requestId, operation: request.operation,
        operationId: null, ok: false, error: { code: 'unavailable', detail: error instanceof Error ? error.message : 'Jamat nedostupný' } };
    }
  }

  private async connection(): Promise<RemoteControlPeerChannel> {
    if (this.closed)
      throw new Error('Relay is stopping');
    if (this.channel?.transport.isOpen())
      return this.channel;
    if (this.connecting)
      return this.connecting;
    this.connecting = this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(): Promise<RemoteControlPeerChannel> {
    const result = await this.client.connect(this.profile);
    if (!result.ok)
      throw new Error('Jamat není připojený. Ověřte, že běží, a potvrďte zařízení „Jamat web“ v Jamatu.');
    if (this.closed) {
      result.value.close();
      throw new Error('Relay is stopping');
    }
    this.channel = new RemoteControlPeerChannel(result.value);
    return this.channel;
  }
}
