import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PcConfig } from './appConfig.js';
import type { MiniWolClient, MiniWolResult, WakeServiceProblem } from './miniWolClient.js';
import { json } from './http.js';

export class WakeService {
  private readonly pcs: PcConfig[];
  private readonly client: MiniWolClient | undefined;

  constructor(pcs: PcConfig[], client: MiniWolClient | undefined) {
    this.pcs = pcs;
    this.client = client;
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/api/wake-service' && !url.pathname.startsWith('/api/wake-service/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    const match = /^\/api\/wake-service\/([^/]+)\/(launcher|wake|start|invitation)$/.exec(url.pathname);
    if (url.pathname !== '/api/wake-service' && !match) {
      json(res, { error: 'Not found' }, 404);
      return true;
    }
    const action = match?.[2] ?? 'status';
    const method = action === 'status' || action === 'launcher' ? 'GET' : 'POST';
    if (req.method !== method) {
      res.setHeader('Allow', method);
      json(res, { error: 'Method not allowed' }, 405);
      return true;
    }
    const id = match?.[1] ?? '';
    if (match && !this.pcs.some(pc => pc.id === id)) {
      json(res, { error: 'PC not configured' }, 404);
      return true;
    }
    if (!this.client) {
      json(res, { state: 'not-configured' }, action === 'status' ? 200 : 503);
      return true;
    }
    switch (action) {
      case 'status': {
        const [computers, version] = await Promise.all([this.client.computers(), this.client.version()]);
        if (!computers.ok)
          json(res, { state: this.serviceProblem(computers.problem) });
        else if (!version.ok)
          json(res, { state: this.serviceProblem(version.problem) });
        else
          json(res, { state: 'ready', version: version.value.version,
            computers: computers.value.filter(computer => this.pcs.some(pc => pc.id === computer.id)) });
        break;
      }
      case 'launcher': {
        const result = await this.client.launcherStatus(id);
        if (result.ok) json(res, result.value);
        else this.failure(res, result);
        break;
      }
      case 'wake': {
        const result = await this.client.wake(id);
        if (result.ok) json(res, { sent: true }, 202);
        else this.failure(res, result);
        break;
      }
      case 'start': {
        const result = await this.client.start(id);
        if (result.ok) json(res, { state: result.value }, result.value === 'starting' ? 202 : 200);
        else this.failure(res, result);
        break;
      }
      case 'invitation': {
        const result = await this.client.invitation(id);
        if (result.ok) json(res, result.value);
        else this.failure(res, result);
        break;
      }
      default: throw new Error('Unknown wake-service action');
    }
    return true;
  }

  private serviceProblem(problem: WakeServiceProblem) {
    switch (problem) {
      case 'unreachable':
      case 'needs-update':
      case 'key-rejected':
      case 'protocol-error': return problem;
      case 'unknown-computer':
      case 'no-launcher':
      case 'rate-limited':
      case 'wol-send-failed':
      case 'launcher-unavailable': return 'protocol-error';
      default: throw new Error('Unknown wake-service problem');
    }
  }

  private failure(res: ServerResponse, result: Extract<MiniWolResult<unknown>, { ok: false }>): void {
    if (result.retryAfter !== undefined) res.setHeader('Retry-After', String(result.retryAfter));
    let status: number;
    switch (result.problem) {
      case 'rate-limited': status = 429; break;
      case 'unknown-computer': status = 404; break;
      case 'no-launcher': status = 409; break;
      case 'unreachable':
      case 'needs-update':
      case 'key-rejected':
      case 'wol-send-failed':
      case 'launcher-unavailable':
      case 'protocol-error': status = 502; break;
      default: throw new Error('Unknown wake-service problem');
    }
    json(res, { problem: result.problem, ...(result.retryAfter === undefined ? {} : { retryAfter: result.retryAfter }) }, status);
  }
}
