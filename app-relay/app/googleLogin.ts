import { randomBytes } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';

export interface GoogleFlow {
  nonce: string;
  verifier: string;
}

export class GoogleLogin {
  private readonly client: OAuth2Client;
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly allowedEmails: ReadonlySet<string>;

  constructor(client: OAuth2Client, clientId: string, origin: string, allowedEmails: string[]) {
    this.client = client;
    this.clientId = clientId;
    this.redirectUri = `${origin}/auth/google/callback`;
    this.allowedEmails = new Set(allowedEmails.map(email => email.toLowerCase()));
  }

  async start(state: string): Promise<{ url: string; flow: GoogleFlow }> {
    const verifier = await this.client.generateCodeVerifierAsync();
    const nonce = randomBytes(32).toString('base64url');
    const url = new URL(this.client.generateAuthUrl({
      scope: ['openid', 'email'], response_type: 'code', redirect_uri: this.redirectUri,
      state, prompt: 'select_account', code_challenge: verifier.codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    }));
    url.searchParams.set('nonce', nonce);
    return { url: url.href, flow: { nonce, verifier: verifier.codeVerifier } };
  }

  async finish(code: string, flow: GoogleFlow): Promise<string> {
    const { tokens } = await this.client.getToken({ code, codeVerifier: flow.verifier, redirect_uri: this.redirectUri });
    if (!tokens.id_token)
      throw new Error('Missing Google identity.');
    const ticket = await this.client.verifyIdToken({ idToken: tokens.id_token, audience: this.clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || payload.email_verified !== true || payload.nonce !== flow.nonce ||
        !payload.email || !this.allowedEmails.has(payload.email.toLowerCase()))
      throw new Error('Google account is not permitted.');
    return payload.email.toLowerCase();
  }
}
