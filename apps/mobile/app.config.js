// Estende o app.json. Padrão seguro: o Android release só aceita HTTPS.
// Para um APK de TESTE que fale com um servidor HTTP na rede local, compile com SIGILO_ALLOW_CLEARTEXT=1.
module.exports = ({ config }) => ({
  ...config,
  plugins: [
    ...(config.plugins ?? []),
    ...(process.env.SIGILO_ALLOW_CLEARTEXT === '1'
      ? [['expo-build-properties', { android: { usesCleartextTraffic: true } }]]
      : []),
  ],
});
