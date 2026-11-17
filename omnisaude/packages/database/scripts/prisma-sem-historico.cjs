'use strict';
/**
 * Prisma sem histórico de depuração em memória (docs/PRISMA-MEMORIA.md).
 *
 * O utilitário de depuração do Prisma guarda os argumentos das últimas 100 chamadas de `debug()` para anexá-los a
 * relatórios de erro, e grava mesmo com o DEBUG desligado. A API carrega duas cópias dele:
 *  - o runtime do cliente (`@prisma/client/runtime/client.js`, minificado), que recebe o plano de cada consulta (com
 *    todas as linhas de um `createMany`) e o SQL cru com os valores;
 *  - o pacote `@prisma/debug`, por onde o `@prisma/adapter-pg` registra cada SQL enviado ao Postgres, com todos os
 *    parâmetros (inclusive de leituras).
 * Com --max-old-space-size=512 (o heap do container de produção), 30 mil linhas em `createMany` de 500 deixavam 162 MB
 * presos, e 50 mil endereços do CNEFE em lotes de 2000 estouravam o heap.
 *
 * A correção faz a gravação depender da mesma condição que o Prisma usa para imprimir (o DEBUG cobrir o namespace):
 * com o DEBUG desligado nada é guardado; com ele ligado, o comportamento é o original.
 *
 * Roda no `postinstall` da raiz e no Dockerfile:
 *   node packages/database/scripts/prisma-sem-historico.cjs              corrige; se um arquivo obrigatório ficar sem a
 *                                                                         correção, avisa e sai com 0 (a instalação
 *                                                                         segue e o teste prisma-memoria falha)
 *   node packages/database/scripts/prisma-sem-historico.cjs --exigir     corrige e sai com 1 se faltar algum
 *   node packages/database/scripts/prisma-sem-historico.cjs --verificar  só confere, sem gravar (sai com 1 se faltar)
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

/** Marca deixada no código corrigido: torna a correção idempotente e verificável. */
const MARCA = '/*omnisaude:prisma-sem-historico*/';

const ID = '[\\w$]+';
/**
 * O mesmo trecho nas duas formas publicadas pelo Prisma 7.10.1. Grupos: 1 argumentos, 2 histórico, 3 namespace,
 * 4 limite, 5 condição de impressão.
 *  - minificada (runtime do cliente):
 *      if(n.length!==0&&Lt.push([o,...n]),Lt.length>Mu&&Lt.shift(),Vt.enabled(o)||i){
 *  - legível (@prisma/debug/dist):
 *      if (args.length !== 0) { argsHistory.push([namespace2, ...args]); }
 *      if (argsHistory.length > MAX_ARGS_HISTORY) { argsHistory.shift(); }
 *      if (topProps.enabled(namespace2) || enabled) {
 */
const TRECHOS = [
  `if\\((${ID})\\.length!==0&&(${ID})\\.push\\(\\[(${ID}),\\.\\.\\.\\1\\]\\),\\2\\.length>(${ID})&&\\2\\.shift\\(\\),(${ID}\\.enabled\\(\\3\\)\\|\\|${ID})\\)\\{`,
  `if\\s*\\((${ID})\\.length\\s*!==\\s*0\\)\\s*\\{\\s*(${ID})\\.push\\(\\[(${ID}),\\s*\\.\\.\\.\\1\\]\\);?\\s*\\}\\s*` +
    `if\\s*\\(\\2\\.length\\s*>\\s*(${ID})\\)\\s*\\{\\s*\\2\\.shift\\(\\);?\\s*\\}\\s*` +
    `if\\s*\\((${ID}\\.enabled\\(\\3\\)\\s*\\|\\|\\s*${ID})\\)\\s*\\{`,
];

/** Troca cada ocorrência do trecho pela versão que só guarda quando a impressão também aconteceria. */
function corrigirTexto(texto) {
  let trechos = 0;
  let novo = texto;
  for (const fonte of TRECHOS) {
    novo = novo.replace(new RegExp(fonte, 'g'), (_m, args, historico, namespace, limite, condicao) => {
      trechos++;
      return (
        `if(${MARCA}(${condicao})&&(${args}.length!==0&&${historico}.push([${namespace},...${args}]),` +
        `${historico}.length>${limite}&&${historico}.shift(),!0)){`
      );
    });
  }
  return { texto: novo, trechos };
}

/** 'pendente' (ainda há o trecho original), 'aplicado' (só a versão corrigida) ou 'ausente' (o Prisma mudou o código). */
function situacaoDoTexto(texto) {
  if (TRECHOS.some((fonte) => new RegExp(fonte).test(texto))) return 'pendente';
  return texto.includes(MARCA) ? 'aplicado' : 'ausente';
}

function versaoDoPacote(arquivo, nome) {
  for (let dir = path.dirname(arquivo); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    try {
      const pacote = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pacote.name === nome) return pacote.version ?? null;
    } catch {
      // sem package.json neste nível: sobe
    }
  }
  return null;
}

function resolver(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Arquivos a corrigir, resolvidos como o Node os carrega a partir do pacote @omnisaude/database. Obrigatórios são os
 * dois que a API carrega (conferido pelo require.cache); os irmãos ESM e edge são corrigidos quando existem.
 */
function alvos(base = path.join(__dirname, '..')) {
  const req = createRequire(path.join(base, 'package.json'));
  const lista = [];
  const incluir = (pacote, arquivo, obrigatorio) => lista.push({ pacote, versao: arquivo ? versaoDoPacote(arquivo, pacote) : null, arquivo, obrigatorio });

  const runtime = resolver(() => req.resolve('@prisma/client/runtime/client'));
  incluir('@prisma/client', runtime, true);
  if (runtime) {
    for (const irmao of ['client.mjs', 'wasm-compiler-edge.js', 'wasm-compiler-edge.mjs']) {
      const arquivo = path.join(path.dirname(runtime), irmao);
      if (arquivo !== runtime && fs.existsSync(arquivo)) incluir('@prisma/client', arquivo, false);
    }
  }

  // O @prisma/debug que o adaptador usa: adapter-pg → driver-adapter-utils → debug.
  const debug = resolver(() => {
    const adaptador = req.resolve('@prisma/adapter-pg');
    const utilitarios = createRequire(adaptador).resolve('@prisma/driver-adapter-utils');
    return createRequire(utilitarios).resolve('@prisma/debug');
  });
  incluir('@prisma/debug', debug, true);
  if (debug && debug.endsWith('.js') && fs.existsSync(debug.replace(/\.js$/, '.mjs'))) incluir('@prisma/debug', debug.replace(/\.js$/, '.mjs'), false);
  return lista;
}

/**
 * Confere (e, com `gravar`, corrige) cada alvo. `situacao`: aplicado, pendente, ausente, nao-instalado ou erro (com
 * `erro`). Não lança: a instalação e a partida da API decidem o que fazer com o resultado.
 */
function executar({ gravar = true, base } = {}) {
  return alvos(base).map((alvo) => {
    if (!alvo.arquivo) return { ...alvo, situacao: 'nao-instalado', corrigidos: 0 };
    try {
      const texto = fs.readFileSync(alvo.arquivo, 'utf8');
      const situacao = situacaoDoTexto(texto);
      if (!gravar || situacao !== 'pendente') return { ...alvo, situacao, corrigidos: 0 };
      const { texto: novo, trechos } = corrigirTexto(texto);
      // Grava ao lado e renomeia: uma instalação interrompida não deixa o runtime pela metade.
      const temporario = `${alvo.arquivo}.${process.pid}.tmp`;
      fs.writeFileSync(temporario, novo, { mode: fs.statSync(alvo.arquivo).mode });
      fs.renameSync(temporario, alvo.arquivo);
      return { ...alvo, situacao: situacaoDoTexto(novo), corrigidos: trechos };
    } catch (err) {
      return { ...alvo, situacao: 'erro', erro: err instanceof Error ? err.message : String(err), corrigidos: 0 };
    }
  });
}

function verificar(opcoes = {}) {
  return executar({ ...opcoes, gravar: false });
}

/** Explica o que fazer com um alvo obrigatório que ficou sem a correção. */
function orientacao(alvo) {
  const onde = `${alvo.pacote}@${alvo.versao ?? '?'}${alvo.arquivo ? ` (${alvo.arquivo})` : ''}`;
  if (alvo.situacao === 'pendente') return `${onde}: correção não aplicada. Rode: node packages/database/scripts/prisma-sem-historico.cjs`;
  if (alvo.situacao === 'nao-instalado') return `${onde}: pacote não encontrado a partir de packages/database (instalação incompleta?)`;
  if (alvo.situacao === 'erro') return `${onde}: não foi possível conferir ou corrigir (${alvo.erro})`;
  return (
    `${onde}: o trecho do histórico de depuração não foi encontrado; o Prisma mudou o código (atualização?). ` +
    'Confira se o histórico ainda existe e ajuste TRECHOS em packages/database/scripts/prisma-sem-historico.cjs ' +
    '(passo a passo em docs/PRISMA-MEMORIA.md).'
  );
}

module.exports = { MARCA, TRECHOS, corrigirTexto, situacaoDoTexto, alvos, executar, verificar, orientacao };

if (require.main === module) {
  const opcoes = new Set(process.argv.slice(2));
  const resultado = executar({ gravar: !opcoes.has('--verificar') });
  const rotulos = { aplicado: 'ok', pendente: 'pendente', ausente: 'TRECHO NÃO ENCONTRADO', 'nao-instalado': 'não instalado', erro: 'ERRO' };
  for (const alvo of resultado) {
    const rotulo = alvo.corrigidos ? `corrigido (${alvo.corrigidos})` : rotulos[alvo.situacao];
    const arquivo = alvo.arquivo ? path.relative(process.cwd(), alvo.arquivo) : '';
    console.log(`prisma-sem-historico: ${rotulo.padEnd(22)} ${`${alvo.pacote}@${alvo.versao ?? '?'}`.padEnd(22)} ${arquivo}`);
  }
  const faltando = resultado.filter((a) => a.obrigatorio && a.situacao !== 'aplicado');
  if (faltando.length) {
    console.error(
      [
        '',
        'ATENÇÃO: o histórico de depuração do Prisma continua ligado. Cada processo guarda as últimas 100 consultas com',
        'os dados (centenas de MB numa importação grande; o heap da API é de 512 MB).',
        ...faltando.map((a) => `  - ${orientacao(a)}`),
        '',
      ].join('\n'),
    );
    if (opcoes.has('--exigir') || opcoes.has('--verificar')) process.exit(1);
  }
}
