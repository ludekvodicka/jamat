import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { RemoteControlPairing } from '../../lib-orchestrator/remoteControl/remoteControlPairing.js';
import { RemoteControlPeerIdentityValidation } from '../../lib-orchestrator/remoteControl/remoteControlPeerIdentityValidation.js';
import { RemoteControlPeerKeys } from '../../lib-orchestrator/remoteControl/remoteControlPeerKeys.js';
import type { RemoteControlPeerIdentity, RemoteControlPeerPairingBundle } from '../../lib-orchestrator/remoteControl/remoteControlPeerApi.types.js';

export interface RelayPeerIdentity {
  identity: RemoteControlPeerIdentity;
  privateKey: string;
}

export interface PcConfig {
  id: string;
  label: string;
  ip: string;
  agentPort: number;
  token?: string;
  peer?: RemoteControlPeerPairingBundle;
}

export interface MiniWolConfig {
  origin: string;
  apiKey: string;
}

export interface RelayConfig {
  origin: string;
  port: number;
  username: string;
  password: string;
  googleClientId?: string;
  googleClientSecret?: string;
  allowedEmails: string[];
  pcs: PcConfig[];
  peerIdentity?: RelayPeerIdentity;
  miniWol?: MiniWolConfig;
  buildTime: string;
}

export class AppConfig {
  static read(env: NodeJS.ProcessEnv): RelayConfig {
    const origin = new URL(env.JAMAT_V3_RELAY_ORIGIN ?? 'https://jamat.example');
    if (origin.href !== `${origin.origin}/` || origin.username || origin.password ||
        (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))))
      throw new Error('JAMAT_V3_RELAY_ORIGIN must be an HTTPS origin (HTTP is allowed only on loopback).');
    const username = env.JAMAT_V3_RELAY_AUTH_USER;
    const password = env.JAMAT_V3_RELAY_AUTH_PASSWORD;
    if (!username || /[:\s\x00-\x1f\x7f]/.test(username) || !password || password.length < 32)
      throw new Error('Configure JAMAT_V3_RELAY_AUTH_USER and JAMAT_V3_RELAY_AUTH_PASSWORD (at least 32 characters).');
    const googleClientId = env.JAMAT_V3_RELAY_GOOGLE_CLIENT_ID?.trim();
    const googleClientSecret = env.JAMAT_V3_RELAY_GOOGLE_CLIENT_SECRET?.trim();
    const allowedEmails = (env.JAMAT_V3_RELAY_ALLOWED_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    if (Boolean(googleClientId) !== Boolean(googleClientSecret) || (googleClientId && !allowedEmails.length) ||
        allowedEmails.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
      throw new Error('Google login requires both client credentials and an explicit email allowlist.');
    const port = Number(env.JAMAT_V3_RELAY_PORT ?? 8080);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error('Invalid JAMAT_V3_RELAY_PORT.');
    const miniWolUrl = env.JAMAT_V3_RELAY_MINIWOL_URL;
    const miniWolKey = env.JAMAT_V3_RELAY_MINIWOL_API_KEY;
    let miniWol: MiniWolConfig | undefined;
    if (miniWolUrl !== undefined || miniWolKey !== undefined) {
      if (!miniWolKey || !/^[0-9a-f]{64}$/.test(miniWolKey))
        throw new Error('JAMAT_V3_RELAY_MINIWOL_API_KEY must contain 64 lowercase hexadecimal characters.');
      let url: URL;
      try { url = new URL(miniWolUrl ?? ''); } catch {
        throw new Error('JAMAT_V3_RELAY_MINIWOL_URL must be an HTTP IPv4 origin.');
      }
      if (url.protocol !== 'http:' || !isIPv4(url.hostname) || url.href !== `${url.origin}/` || url.username || url.password)
        throw new Error('JAMAT_V3_RELAY_MINIWOL_URL must be an HTTP IPv4 origin.');
      miniWol = { origin: url.origin, apiKey: miniWolKey };
    }
    const registry = JSON.parse(readFileSync(env.JAMAT_V3_RELAY_CONFIG ?? '.private/config-remote.json', 'utf8')) as {
      pcs: PcConfig[]; peerIdentity?: RelayPeerIdentity;
    };
    if (!Array.isArray(registry.pcs) || registry.pcs.some(pc =>
      !pc || typeof pc.id !== 'string' || !/^[\w-]+$/.test(pc.id) || typeof pc.label !== 'string' ||
      typeof pc.ip !== 'string' || !/^[\w.:-]+$/.test(pc.ip) || !Number.isInteger(pc.agentPort) || pc.agentPort < 1 || pc.agentPort > 65535 ||
      (pc.token !== undefined && typeof pc.token !== 'string')) ||
      new Set(registry.pcs.map(pc => pc.id)).size !== registry.pcs.length)
      throw new Error('Invalid relay PC registry.');
    for (const pc of registry.pcs)
      if (pc.peer !== undefined)
        RemoteControlPairing.parse(pc.peer);
    if (registry.pcs.some(pc => pc.peer)) {
      if (!registry.peerIdentity)
        throw new Error('Jamat PCs require a relay peer identity.');
      RemoteControlPeerIdentityValidation.assertPeer(registry.peerIdentity.identity);
      if (RemoteControlPeerKeys.publicFromPrivate(registry.peerIdentity.privateKey) !== registry.peerIdentity.identity.signing.publicKey)
        throw new Error('Relay peer signing key does not match its identity.');
    }
    return { origin: origin.origin, port, username, password, googleClientId, googleClientSecret, allowedEmails,
      pcs: registry.pcs.map(({ id, label, ip, agentPort, token, peer }) => ({ id, label, ip, agentPort, token, peer })),
      peerIdentity: registry.peerIdentity, miniWol, buildTime: env.JAMAT_V3_RELAY_BUILD_TIME ?? 'dev' };
  }
}
