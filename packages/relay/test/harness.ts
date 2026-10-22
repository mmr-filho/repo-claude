import type { AddressInfo } from 'node:net';
import { LocalNode, MemoryLocalStore, RelayClient, type NodeDeps, type PollResult, type Transport } from '@sigilo/core/v2';
import { buildRelay } from '../src/node-server.js';
import type { NodeRelayStore } from '../src/node-store.js';

export const KDF = { params: { alg: 'scrypt' as const, N: 1024, r: 8, p: 1 }, policy: { minN: 1024, maxN: 2 ** 20 } };

/**
 * Sobe o relé em Node (com acesso ao banco, para conferências extras) ou, com RELAY_URL, usa um relé que já está
 * no ar (por exemplo o Worker rodando no workerd). Os mesmos testes valem para as duas implementações.
 */
export async function startRelay() {
  const external = process.env.RELAY_URL;
  if (external) return { url: external.replace(/\/+$/, ''), store: undefined, close: async () => {} };
  const relay = await buildRelay({ dbPath: ':memory:', rateLimit: false });
  await relay.app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${(relay.app.server.address() as AddressInfo).port}`;
  return { url, store: relay.store as NodeRelayStore | undefined, close: () => relay.app.close() };
}

/** `fetch` que registra o corpo de cada envio, para os testes poderem reapresentar um quadro por "outro meio". */
export function recordingFetch(log: Array<{ path: string; body: Uint8Array }>): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST' && init.body) log.push({ path: new URL(url).pathname, body: new Uint8Array(init.body as Uint8Array) });
    return fetch(input, init);
  };
}

export interface Clock {
  t: number;
}

export function makeDeps(opts: { clock?: Clock; fetch?: typeof fetch; transports?: Transport[]; store?: MemoryLocalStore } = {}): NodeDeps & { store: MemoryLocalStore } {
  return {
    store: opts.store ?? new MemoryLocalStore(),
    relay: new RelayClient({ fetch: opts.fetch }),
    transports: opts.transports,
    now: opts.clock ? () => opts.clock!.t : undefined,
    vault: KDF,
  };
}

/** Cria a rede (aparelho do administrador). */
export function newNetwork(url: string, networkName: string, adminName = 'Admin', clock?: Clock) {
  return LocalNode.createNetwork(makeDeps({ clock }), { password: 'senha-do-admin', adminName, networkName, relayUrl: url });
}

/** O administrador convida, a pessoa entra com o código, o administrador aprova ao abrir o app e a pessoa recebe. */
export async function enroll(admin: LocalNode, name: string, password = `senha-${name}`, clock?: Clock, deps = makeDeps({ clock })) {
  const invite = await admin.createInvite(name);
  const node = await LocalNode.join(deps, { password, inviteCode: invite.code });
  await admin.poll();
  await node.poll();
  return { node, password, deps };
}

/** Todos consultam a caixa postal algumas vezes, até as novidades (listas de contatos, vínculos) chegarem a todos. */
export async function settle(nodes: LocalNode[], rounds = 3): Promise<PollResult[]> {
  const last: PollResult[] = [];
  for (let r = 0; r < rounds; r++) {
    last.length = 0;
    for (const n of nodes) last.push(await n.poll());
  }
  return last;
}

export const boxOf = (n: LocalNode) => n.myBox;
