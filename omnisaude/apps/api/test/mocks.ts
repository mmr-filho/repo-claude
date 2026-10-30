import { createMockServer } from '@omnisaude/mocks';
import type { AddressInfo } from 'node:net';

/** Sobe o servidor simulado (RNDS/CADSUS, SEFAZ, WhatsApp) numa porta livre. */
export async function startMocks() {
  const server = createMockServer({ log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url, state: server.state, close: () => new Promise<void>((r) => server.close(() => r())) };
}
