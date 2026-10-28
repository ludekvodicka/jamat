import { OAuth2Client } from 'google-auth-library';
import type { RelayConfig } from './appConfig.js';
import type { AppContext } from './appContext.js';
import { GoogleLogin } from './googleLogin.js';
import { RelayLogin } from './relayLogin.js';
import { PcRelay } from './pcRelay.js';
import { LegacyPc } from './legacyPc.js';
import { JamatPc } from './jamatPc.js';

export class AppHub {
  readonly login: RelayLogin;
  readonly relay: PcRelay;

  constructor(config: RelayConfig, context: AppContext) {
    const google = config.googleClientId && config.googleClientSecret
      ? new GoogleLogin(new OAuth2Client({ clientId: config.googleClientId, clientSecret: config.googleClientSecret,
          transporterOptions: { timeout: 10000, retry: false } }), config.googleClientId, config.origin, config.allowedEmails)
      : undefined;
    this.login = new RelayLogin(config.origin, config.username, config.password, context.loginTemplate, google);
    this.relay = new PcRelay(config.pcs, new Map(config.pcs.map(pc =>
      [pc.id, pc.peer ? new JamatPc(pc, config.peerIdentity!) : new LegacyPc(pc)])), config.wolProxy);
  }
}
