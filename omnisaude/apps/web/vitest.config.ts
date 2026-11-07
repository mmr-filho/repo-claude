import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const daqui = (caminho: string) => fileURLToPath(new URL(caminho, import.meta.url));

// Testes da lógica da web (app de campo sem internet), em Node e sem build: importam o código-fonte com os mesmos
// atalhos do tsconfig (@/ e o pacote compartilhado). O IndexedDB é simulado em test/fake-indexeddb.ts.
export default defineConfig({
  root: daqui('.'),
  resolve: {
    alias: [
      { find: /^@\//, replacement: daqui('./src/') },
      { find: '@omnisaude/shared', replacement: daqui('../../packages/shared/src/index.ts') },
    ],
  },
  test: {
    name: 'web',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
