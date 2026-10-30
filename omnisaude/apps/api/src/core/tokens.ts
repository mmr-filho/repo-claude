import { Inject, Injectable } from '@nestjs/common';
import { isRole, type Role } from '@omnisaude/shared';
import { jwtVerify, SignJWT } from 'jose';
import { APP_CONFIG, type AppConfig } from './config';

/**
 * Etapas do login: "mfa" (aguardando o código TOTP), "context" (autenticado, escolhendo unidade e papel)
 * e "access" (contexto ativo). Só o token "access" abre a API.
 */
export type TokenStage = 'mfa' | 'context' | 'access';

export interface TokenClaims {
  stage: TokenStage;
  tid: string;
  tslug: string;
  sub: string;
  mfa: boolean;
  unit?: string;
  role?: Role;
  cbo?: string;
}

@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.key = new TextEncoder().encode(config.JWT_SECRET);
  }

  async sign(claims: TokenClaims): Promise<string> {
    const ttl = claims.stage === 'access' ? `${this.config.SESSION_HOURS}h` : '10m';
    const { sub, ...rest } = claims;
    return new SignJWT({ ...rest })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setIssuer('omnisaude')
      .setIssuedAt()
      .setExpirationTime(ttl)
      .sign(this.key);
  }

  async verify(token: string): Promise<TokenClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: 'omnisaude', algorithms: ['HS256'] });
      const stage = payload.stage;
      if (stage !== 'mfa' && stage !== 'context' && stage !== 'access') return null;
      if (typeof payload.tid !== 'string' || typeof payload.sub !== 'string') return null;
      const claims: TokenClaims = {
        stage,
        tid: payload.tid,
        tslug: String(payload.tslug ?? ''),
        sub: payload.sub,
        mfa: payload.mfa === true,
      };
      if (stage === 'access') {
        if (typeof payload.unit !== 'string' || !isRole(payload.role)) return null;
        claims.unit = payload.unit;
        claims.role = payload.role;
        claims.cbo = String(payload.cbo ?? '');
      }
      return claims;
    } catch {
      return null;
    }
  }
}
