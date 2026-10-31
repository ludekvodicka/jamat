import { z } from 'zod';
import type { MiniWolConfig } from './appConfig.js';

const launcherSchema = z.enum(['ready', 'stopped', 'starting', 'failed', 'unavailable']);
const targetErrors = ['target-missing', 'target-invalid', 'launch-failed', 'readiness-timeout', 'profile-unavailable'];
const launcherStatusSchema = z.object({ state: launcherSchema, error: z.string().optional() }).transform(value => ({
  state: value.state,
  ...(value.state === 'failed' && value.error && targetErrors.includes(value.error) ? { error: value.error } : {}),
}));
const errorSchema = z.object({ error: z.enum(['unauthorized', 'forbidden', 'bad-request', 'not-found',
  'method-not-allowed', 'unknown-computer', 'no-launcher', 'rate-limited', 'wol-send-failed', 'launcher-unavailable']) });

export type LauncherState = z.infer<typeof launcherSchema>;
export type WakeServiceProblem = 'unreachable' | 'needs-update' | 'key-rejected' | 'unknown-computer'
  | 'no-launcher' | 'rate-limited' | 'wol-send-failed' | 'launcher-unavailable' | 'protocol-error';
export type MiniWolResult<T> = { ok: true; value: T } | { ok: false; problem: WakeServiceProblem; retryAfter?: number };

export class MiniWolClient {
  private readonly config: MiniWolConfig;
  private readonly fetcher: typeof fetch;

  constructor(config: MiniWolConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  computers() {
    return this.request('/api/v1/computers', 'GET', { 200: z.object({ computers: z.array(z.object({
      id: z.string().regex(/^[a-z0-9-]{1,40}$/), hasLauncher: z.boolean(),
    })) }).transform(value => value.computers) });
  }

  version() {
    return this.request('/api/system/version', 'GET', { 200: z.object({ version: z.string().min(1).max(100) }) });
  }

  launcher(id: string) {
    return this.request(`/api/v1/computers/${encodeURIComponent(id)}/launcher`, 'GET', {
      200: z.object({ state: launcherSchema }).transform(value => value.state),
    });
  }

  launcherStatus(id: string) {
    return this.request(`/api/v1/computers/${encodeURIComponent(id)}/launcher`, 'GET', { 200: launcherStatusSchema });
  }

  wake(id: string): Promise<MiniWolResult<void>> {
    return this.request(`/api/v1/computers/${encodeURIComponent(id)}/wake`, 'POST', {
      202: z.object({ sent: z.literal(true) }).transform(() => undefined),
    });
  }

  start(id: string): Promise<MiniWolResult<'starting' | 'ready'>> {
    return this.request<'starting' | 'ready'>(`/api/v1/computers/${encodeURIComponent(id)}/start`, 'POST', {
      200: z.object({ state: z.literal('ready') }).transform(value => value.state),
      202: z.object({ state: z.literal('starting') }).transform(value => value.state),
    });
  }

  invitation(id: string) {
    return this.request(`/api/v1/computers/${encodeURIComponent(id)}/invitation`, 'POST', {
      200: z.object({ invitationUrl: z.string().refine(value =>
        value.startsWith(`${this.config.origin}/#autolauncher=`)
          && /^[0-9a-f]{64}$/.test(value.slice(`${this.config.origin}/#autolauncher=`.length))),
      expiresInSeconds: z.number().int().positive().max(300) }),
    });
  }

  private async request<T>(path: string, method: 'GET' | 'POST', schemas: Record<number, z.ZodType<T>>): Promise<MiniWolResult<T>> {
    const protocolError = { ok: false, problem: 'protocol-error' } as const;
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.config.origin), { method,
        headers: { Authorization: `Bearer ${this.config.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(6000) });
    } catch (error) {
      return error instanceof Error && error.cause instanceof Error && error.cause.message === 'unexpected redirect'
        ? protocolError : { ok: false, problem: 'unreachable' };
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      return response.status === 404 && path.startsWith('/api/v1/')
        ? { ok: false, problem: 'needs-update' } : protocolError;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      const reader = response.body?.getReader();
      if (!reader) return protocolError;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 16 * 1024) {
          await reader.cancel();
          return protocolError;
        }
        chunks.push(chunk.value);
      }
    } catch {
      return { ok: false, problem: 'unreachable' };
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return protocolError; }
    const schema = schemas[response.status];
    if (schema) {
      const parsed = schema.safeParse(body);
      return parsed.success ? { ok: true, value: parsed.data } : protocolError;
    }
    const error = errorSchema.safeParse(body);
    if (!error.success) return protocolError;
    switch (error.data.error) {
      case 'unauthorized': return response.status === 401 ? { ok: false, problem: 'key-rejected' } : protocolError;
      case 'unknown-computer': return response.status === 404 ? { ok: false, problem: 'unknown-computer' } : protocolError;
      case 'no-launcher': return response.status === 409 ? { ok: false, problem: 'no-launcher' } : protocolError;
      case 'wol-send-failed':
      case 'launcher-unavailable':
        return response.status === 502 ? { ok: false, problem: error.data.error } : protocolError;
      case 'rate-limited': {
        const retryAfter = response.headers.get('retry-after') ?? '';
        return response.status === 429 && /^[1-9]\d*$/.test(retryAfter) && Number.isSafeInteger(Number(retryAfter))
          ? { ok: false, problem: 'rate-limited', retryAfter: Number(retryAfter) } : protocolError;
      }
      case 'forbidden':
      case 'bad-request':
      case 'not-found':
      case 'method-not-allowed': return protocolError;
      default: throw new Error('Unknown MiniWol error');
    }
  }
}
