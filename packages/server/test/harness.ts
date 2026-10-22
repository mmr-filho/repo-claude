import type { AddressInfo } from 'node:net';
import { SigiloSession, type ServerEvent } from '@sigilo/core';
import { buildApp } from '../src/app.js';
import { testConfig, type Config } from '../src/config.js';
import { createNetwork } from '../src/services.js';

export const KDF_POLICY = { minN: 1024, maxN: 2 ** 20 };

export async function startServer(overrides: Partial<Config> = {}) {
  const config = testConfig(overrides);
  const { app, ctx } = await buildApp(config);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const sessions: SigiloSession[] = [];

  const track = (s: SigiloSession) => {
    sessions.push(s);
    return s;
  };

  return {
    app,
    ctx,
    baseUrl,
    config,
    /** Cria rede + administrador (como o operador faria pela CLI) e ativa o admin. */
    async network(slug: string, adminUsername = 'admin', password = 'senha-do-admin') {
      const created = createNetwork(ctx.db, config, {
        slug,
        name: `Rede ${slug}`,
        adminUsername,
        adminDisplayName: `Admin ${slug}`,
      });
      const admin = await this.activate(`${adminUsername}@${slug}`, created.activationCode, password);
      return { slug, admin, networkId: created.network.id };
    },
    activate(handle: string, activationCode: string, password: string) {
      return SigiloSession.activate({ baseUrl, handle, activationCode, password, kdfPolicy: KDF_POLICY }).then(track);
    },
    login(handle: string, password: string) {
      return SigiloSession.login({ baseUrl, handle, password, kdfPolicy: KDF_POLICY }).then(track);
    },
    resume(token: string) {
      return SigiloSession.resume({ baseUrl, token, kdfPolicy: KDF_POLICY }).then(track);
    },
    /** Admin cadastra um membro e o membro ativa a conta com a própria senha. */
    async member(admin: SigiloSession, username: string, password = `senha-${username}`, role: 'admin' | 'member' = 'member') {
      const created = await admin.api.createMember({ username, displayName: username.toUpperCase(), role });
      const session = await this.activate(created.member.handle, created.activationCode, password);
      return { session, password, id: created.member.id };
    },
    async close() {
      for (const s of sessions) s.stopRealtime();
      await app.close();
    },
  };
}

/** Coleta eventos de tempo real e permite esperar por um deles. */
export function watch(session: SigiloSession) {
  const events: ServerEvent[] = [];
  const waiters: Array<{ match: (e: ServerEvent) => boolean; resolve: (e: ServerEvent) => void }> = [];
  let readyResolve: () => void;
  const ready = new Promise<void>((r) => (readyResolve = r));
  session.startRealtime(
    (e) => {
      events.push(e);
      if (e.type === 'ready') readyResolve();
      for (const w of [...waiters]) {
        if (w.match(e)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(e);
        }
      }
    },
  );
  return {
    events,
    ready,
    next<T extends ServerEvent['type']>(type: T, timeoutMs = 3000): Promise<Extract<ServerEvent, { type: T }>> {
      const existing = events.find((e) => e.type === type);
      if (existing) {
        events.splice(events.indexOf(existing), 1);
        return Promise.resolve(existing as Extract<ServerEvent, { type: T }>);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Evento ${type} não chegou em ${timeoutMs}ms`)), timeoutMs);
        waiters.push({
          match: (e) => e.type === type,
          resolve: (e) => {
            clearTimeout(timer);
            events.splice(events.indexOf(e), 1);
            resolve(e as Extract<ServerEvent, { type: T }>);
          },
        });
      });
    },
  };
}
