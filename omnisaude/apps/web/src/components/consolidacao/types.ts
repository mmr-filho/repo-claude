/**
 * Tipos das abas da consolidação (VIG-1c). Os contratos da API vêm de @omnisaude/shared (api-importacao,
 * api-diagrama e api-surto-negativa). Rótulos e tons de cada aba ficam no arquivo da própria aba, para as frentes
 * da web não editarem este arquivo ao mesmo tempo.
 */
export type AbaConsolidacao = 'importacao' | 'conciliacao' | 'diagrama' | 'contingencia' | 'surtos' | 'negativa';
