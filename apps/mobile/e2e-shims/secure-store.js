// SOMENTE para os testes de interface no navegador (SIGILO_E2E=1). Nunca é usado no app real:
// no navegador não existe Keychain/Keystore, então os testes usam localStorage no lugar.
//
// A biometria é SIMULADA (o sensor real só existe no aparelho):
//   - fica disponível se localStorage['e2e.bioAvailable'] === '1'
//   - ler uma chave com `requireAuthentication` "pede a digital": é aprovada, a não ser que window.__e2eBio === 'cancel'
module.exports = {
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  canUseBiometricAuthentication: () => window.localStorage.getItem('e2e.bioAvailable') === '1',
  getItemAsync: async (key, options) => {
    if (options && options.requireAuthentication && window.__e2eBio === 'cancel') throw new Error('User canceled the authentication');
    return window.localStorage.getItem(key);
  },
  setItemAsync: async (key, value) => void window.localStorage.setItem(key, value),
  deleteItemAsync: async (key) => void window.localStorage.removeItem(key),
};
