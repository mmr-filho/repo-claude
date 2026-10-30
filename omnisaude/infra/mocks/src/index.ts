import { createMockServer } from './server';

export * from './fixtures';
export * from './server';

function main(): void {
  const port = Number(process.env.PORT ?? 4010);
  const server = createMockServer({ log: process.env.MOCK_LOG === '0' ? undefined : (l) => console.log(`[mocks] ${l}`) });
  server.listen(port, () => {
    console.log(`[mocks] RNDS/CADSUS, SEFAZ e WhatsApp simulados em http://0.0.0.0:${port}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

// Só sobe o servidor quando executado diretamente (node dist/index.js / tsx src/index.ts).
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) main();
