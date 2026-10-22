// SOMENTE para os testes de interface no navegador (SIGILO_E2E=1). Nunca é usado no app real:
// no navegador não existe Keychain/Keystore, então os testes usam localStorage no lugar.
module.exports = {
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key) => window.localStorage.getItem(key),
  setItemAsync: async (key, value) => void window.localStorage.setItem(key, value),
  deleteItemAsync: async (key) => void window.localStorage.removeItem(key),
};
