import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

// Os testes importam os pacotes internos direto do código-fonte, sem precisar de build.
const alias = {
  '@omnisaude/shared': pkg('shared'),
  '@omnisaude/database': pkg('database'),
  '@omnisaude/ai-engine': pkg('ai-engine'),
  '@omnisaude/messaging': pkg('messaging'),
  '@omnisaude/fhir': pkg('fhir'),
  '@omnisaude/accessibility': pkg('accessibility'),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'packages',
          include: ['packages/*/test/**/*.test.ts', 'infra/mocks/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        // A API usa decorators com metadata (injeção de dependência do NestJS): o SWC preserva isso, o esbuild não.
        plugins: [swc.vite({ module: { type: 'es6' } })],
        test: {
          name: 'api',
          include: ['apps/api/test/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
