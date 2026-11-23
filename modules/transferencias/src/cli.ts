import fs from 'node:fs';
import path from 'node:path';
import { corpus, DADOS, perfis } from './dados';
import { estatisticas } from './pares';
import { analisa, chamada } from './regras';

/*
 * Roda o motor de regras para todas as prefeituras e grava o que a página do módulo lê:
 *   dados/analise/<ibge>.json  diagnóstico de cada prefeitura (achados, pendências, indicadores, trechos citados)
 *   dados/indice.json          lista para a escolha do município, com o resumo de cada um
 *   dados/pares.json           estatísticas por grupo de porte
 *
 *   npm run analisar -w @mm/transferencias
 */
const lista = perfis();
const est = estatisticas(lista);
const c = corpus();
const destino = path.join(DADOS, 'analise');
fs.mkdirSync(destino, { recursive: true });
const indice: {
  ibge: number; nome: string; populacao: number; faixa: string;
  criticos: number; alertas: number; oportunidades: number; perda_anual: number; chamada: string;
}[] = [];
for (const p of lista) {
  const a = analisa(p, est, c.trechos);
  fs.writeFileSync(path.join(destino, `${p.ibge}.json`), JSON.stringify(a));
  indice.push({
    ibge: p.ibge,
    nome: p.nome,
    populacao: p.populacao,
    faixa: p.faixa_populacional,
    criticos: a.totais.criticos,
    alertas: a.totais.alertas,
    oportunidades: a.totais.oportunidades,
    perda_anual: Math.round(a.totais.perda_anual),
    chamada: chamada(a),
  });
}
const datas = lista.map((p) => p.consultado_em).sort();
fs.writeFileSync(
  path.join(DADOS, 'indice.json'),
  JSON.stringify({ consultado_em: datas[datas.length - 1], municipios: indice.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')) }),
);
fs.writeFileSync(path.join(DADOS, 'pares.json'), JSON.stringify(est));
const n = (k: 'criticos' | 'alertas' | 'oportunidades') => indice.reduce((s, m) => s + m[k], 0);
console.log(`${lista.length} prefeituras: ${n('criticos')} críticos, ${n('alertas')} alertas, ${n('oportunidades')} oportunidades`);
