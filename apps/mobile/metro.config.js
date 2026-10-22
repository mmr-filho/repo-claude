const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Nos testes de interface (npm run test:e2e) o app roda no navegador, onde não há Keychain/Keystore.
// Só com SIGILO_E2E=1 e só na plataforma web, dois módulos nativos são trocados por substitutos de teste.
if (process.env.SIGILO_E2E === '1') {
  const shims = {
    'expo-secure-store': path.resolve(__dirname, 'e2e-shims/secure-store.js'),
    'expo-screen-capture': path.resolve(__dirname, 'e2e-shims/screen-capture.js'),
  };
  const original = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) =>
    platform === 'web' && shims[moduleName]
      ? { type: 'sourceFile', filePath: shims[moduleName] }
      : (original ?? context.resolveRequest)(context, moduleName, platform);
}

module.exports = config;
