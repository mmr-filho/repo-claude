/**
 * Endereço do relé embutido no app. As pessoas não digitam isto: quem cria a rede usa o relé do app, e quem
 * entra com um convite usa o relé que vem dentro do convite.
 *
 * Quando houver um relé no ar, coloque o endereço aqui (HTTPS) — ou defina EXPO_PUBLIC_RELAY_URL ao gerar o app,
 * que tem prioridade. Enquanto estiver vazio, "Criar uma rede" fica indisponível (entrar com convite funciona).
 */
const BUILT_IN_RELAY_URL = '';

export const RELAY_URL: string = (process.env.EXPO_PUBLIC_RELAY_URL ?? '').trim() || BUILT_IN_RELAY_URL;

/** Tamanho mínimo da senha (em caracteres). Senhas curtas são aceitas, mas o app avisa quando são fracas. */
export const MIN_PASSWORD = 6;
