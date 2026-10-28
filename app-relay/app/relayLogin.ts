import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCookie, stringifySetCookie } from 'cookie';
import { ExpiringStore } from './expiringStore.js';
import { GoogleLogin, type GoogleFlow } from './googleLogin.js';
import { formBody, json, redirect, sameOrigin } from './http.js';

export class RelayLogin {
  private readonly origin: string;
  private readonly username: string;
  private readonly credentialHash: Buffer;
  private readonly google: GoogleLogin | undefined;
  private readonly template: string;
  private readonly sessions = new ExpiringStore<string>(7 * 86400_000);
  private readonly forms = new ExpiringStore<string>(10 * 60_000);
  private readonly googleFlows = new ExpiringStore<{ browser: string; flow?: GoogleFlow }>(10 * 60_000);
  private readonly attempts = new Map<string, { count: number; expires: number }>();
  private readonly secure: boolean;
  private readonly sessionCookie: string;
  private readonly flowCookie: string;

  constructor(origin: string, username: string, password: string, template: string, google?: GoogleLogin) {
    this.origin = origin;
    this.username = username;
    this.credentialHash = createHash('sha256').update(`${username}:${password}`).digest();
    this.template = template;
    this.google = google;
    this.secure = origin.startsWith('https:');
    this.sessionCookie = this.secure ? '__Host-jamat_session' : 'jamat_session';
    this.flowCookie = this.secure ? '__Host-jamat_login' : 'jamat_login';
  }

  async authorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const cookies = parseCookie(req.headers.cookie ?? '');
    const session = this.sessions.get(cookies[this.sessionCookie]);
    if (url.pathname === '/auth/google/callback' && req.method === 'GET') {
      res.setHeader('Referrer-Policy', 'no-referrer');
      const state = url.searchParams.get('state') ?? '';
      const pending = this.googleFlows.get(state);
      this.googleFlows.delete(state);
      if (!pending?.flow || !this.google || pending.browser !== cookies[this.flowCookie]) {
        this.loginPage(req, res, 'Přihlášení vypršelo. Zkuste to znovu.', 400);
        return false;
      }
      try {
        const code = url.searchParams.get('code');
        if (!code || code.length > 4096 || url.searchParams.has('error'))
          throw new Error('Google login cancelled.');
        const user = await this.google.finish(code, pending.flow);
        this.signIn(req, res, user);
      } catch {
        this.loginPage(req, res, 'Google přihlášení se nezdařilo nebo tento účet nemá přístup.', 403);
      }
      return false;
    }
    if (url.pathname === '/login' && req.method === 'GET') {
      if (session)
        redirect(res, '/');
      else
        this.loginPage(req, res);
      return false;
    }
    if (!session && req.method === 'GET' && !url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/relay/') && !url.pathname.startsWith('/auth/')) {
      redirect(res, '/login');
      return false;
    }
    const navigatingToMenu = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' &&
      (url.pathname === '/' || url.pathname === '/index.html');
    if (!sameOrigin(req, this.origin) && !navigatingToMenu) {
      json(res, { error: 'Cross-origin access denied' }, 403);
      return false;
    }
    if ((url.pathname === '/auth/password' || url.pathname === '/auth/google') && req.method === 'POST') {
      if (!this.allowAttempt(req)) {
        res.setHeader('Retry-After', '600');
        this.loginPage(req, res, 'Příliš mnoho pokusů. Zkuste to za 10 minut.', 429);
        return false;
      }
      let body: URLSearchParams;
      try {
        body = await formBody(req);
      } catch {
        json(res, { error: 'Invalid login form' }, 400);
        return false;
      }
      const formId = cookies[this.flowCookie];
      const csrf = this.forms.get(formId);
      this.forms.delete(formId);
      if (!csrf || csrf !== body.get('csrf')) {
        this.loginPage(req, res, 'Přihlašovací formulář vypršel. Zkuste to znovu.', 403);
        return false;
      }
      if (url.pathname === '/auth/password') {
        const candidate = createHash('sha256').update(`${body.get('username') ?? ''}:${body.get('password') ?? ''}`).digest();
        if (timingSafeEqual(candidate, this.credentialHash))
          this.signIn(req, res, this.username);
        else
          this.loginPage(req, res, 'Nesprávné uživatelské jméno nebo heslo.', 401);
      } else if (url.pathname === '/auth/google') {
        if (!this.google) {
          this.loginPage(req, res, 'Přihlášení přes Google zatím není dostupné.', 503);
          return false;
        }
        const browser = randomBytes(32).toString('base64url');
        const pending: { browser: string; flow?: GoogleFlow } = { browser };
        const state = this.googleFlows.create(pending);
        const started = await this.google.start(state);
        pending.flow = started.flow;
        res.setHeader('Set-Cookie', this.cookie(this.flowCookie, browser, 600));
        redirect(res, started.url);
      } else
        throw new Error('Unknown login route.');
      return false;
    }
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      this.sessions.delete(cookies[this.sessionCookie]);
      res.setHeader('Set-Cookie', this.cookie(this.sessionCookie, '', 0));
      redirect(res, '/login');
      return false;
    }
    if (url.pathname.startsWith('/auth/')) {
      json(res, { error: 'Not found' }, 404);
      return false;
    }
    if (!session) {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/relay/'))
        redirect(res, '/login');
      else
        json(res, { error: 'Authentication required', loginUrl: '/login' }, 401);
      return false;
    }
    if (url.pathname === '/api/auth/session' && req.method === 'GET') {
      json(res, { user: session });
      return false;
    }
    return true;
  }

  private signIn(req: IncomingMessage, res: ServerResponse, user: string): void {
    const cookies = parseCookie(req.headers.cookie ?? '');
    this.sessions.delete(cookies[this.sessionCookie]);
    const id = this.sessions.create(user);
    res.setHeader('Set-Cookie', [this.cookie(this.sessionCookie, id, 7 * 86400), this.cookie(this.flowCookie, '', 0)]);
    redirect(res, '/');
  }

  private loginPage(req: IncomingMessage, res: ServerResponse, message = '', status = 200): void {
    this.forms.delete(parseCookie(req.headers.cookie ?? '')[this.flowCookie]);
    const csrf = randomBytes(32).toString('base64url');
    const id = this.forms.create(csrf);
    res.setHeader('Set-Cookie', this.cookie(this.flowCookie, id, 600));
    // Chrome otherwise submits same-origin forms with Origin: null under no-referrer.
    res.setHeader('Referrer-Policy', 'same-origin');
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'" });
    res.end(this.template.replaceAll('{{csrf}}', csrf).replace('{{message}}', message)
      .replace('{{googleDisabled}}', this.google ? '' : 'disabled')
      .replace('{{googleNotice}}', this.google ? '' : 'Přihlášení přes Google zatím není dostupné.'));
  }

  private cookie(name: string, value: string, maxAge: number): string {
    return stringifySetCookie({ name, value, path: '/', httpOnly: true, secure: this.secure, sameSite: 'lax', maxAge });
  }

  private allowAttempt(req: IncomingMessage): boolean {
    const now = Date.now();
    for (const [key, entry] of this.attempts)
      if (entry.expires <= now)
        this.attempts.delete(key);
    // The private listener is reached through nginx, which overwrites X-Real-IP.
    const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? 'unknown');
    const entry = this.attempts.get(ip) ?? { count: 0, expires: now + 600_000 };
    if (!this.attempts.has(ip) && this.attempts.size >= 1000)
      return false;
    this.attempts.set(ip, entry);
    return ++entry.count <= 20;
  }
}
