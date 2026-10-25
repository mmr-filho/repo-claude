/*
 * Módulo Transferências Federais: para UMA prefeitura do Tocantins, onde ela perde ou pode ganhar repasses federais
 * (educação, saúde e assistência social), quanto isso vale em reais e o passo a passo para corrigir.
 *
 * Dados (gerados por etl/ e por `npm run analisar`): dados/indice.json (lista), dados/analise/<ibge>.json (achados
 * do motor de regras, com os trechos das normas citadas) e dados/rag/chunks.json (corpus, só na metodologia).
 * Com <main data-api="/api/transferencias">, lista e análise vêm da API do site (com a sessão do usuário), e o
 * parecer do consultor (agente) pode ser gerado. Sem dependências: o site exige script-src 'self'. Texto vindo
 * de fora entra só por textContent.
 */
(() => {
  'use strict';

  const NF0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  const NF1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const NF2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const brl = (v) => (v == null ? '–' : 'R$ ' + NF0.format(Math.round(v)));
  function brlCurto(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return `R$ ${NF1.format(v / 1e6)} ${a >= 2e6 ? 'milhões' : 'milhão'}`;
    if (a >= 1e3) return `R$ ${NF0.format(v / 1e3)} mil`;
    return brl(v);
  }
  const semAcento = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

  const NIVEL = {
    'Crítico': { chip: 'chip chip-fatal', card: 'est-nao', desc: 'Bloqueio ou suspensão' },
    'Alerta': { chip: 'chip chip-alta', card: 'est-andamento', desc: 'Perda de repasse ou de ponderação' },
    'Oportunidade': { chip: 'chip', card: 'tf-oportunidade', desc: 'Incremento' },
  };
  const NATUREZA = {
    perda_de_repasse: 'Repasse em risco',
    ganho_potencial: 'Ganho potencial',
    valor_a_aplicar: 'Valor a aplicar',
    recurso_parado: 'Recurso parado',
  };
  const EIXOS = ['Educação', 'Saúde', 'Assistência Social'];
  const POR_PAGINA = 8;

  // ---------- utilidades ----------

  function h(tag, attrs, ...filhos) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const f of filhos.flat(Infinity)) if (f != null && f !== false) e.append(f.nodeType ? f : document.createTextNode(String(f)));
    return e;
  }

  const guarda = {
    le(k, padrao) { try { const v = localStorage.getItem(k); return v == null ? padrao : JSON.parse(v); } catch (_) { return padrao; } },
    grava(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* sem armazenamento: segue sem lembrar */ } },
  };

  const app = document.getElementById('tf-app');
  // lido a cada uso: o site pode definir data-api depois de carregar o script
  const api = () => app.dataset.api || null;

  async function json(url, init) {
    const r = await fetch(url, Object.assign({ credentials: 'same-origin', headers: { accept: 'application/json' } }, init));
    if (!r.ok) {
      let msg = `${r.status}`;
      try { msg = (await r.json()).erro || msg; } catch (_) { /* corpo sem JSON */ }
      const e = new Error(msg);
      e.status = r.status;
      throw e;
    }
    return r.json();
  }

  const fonte = {
    indice: () => json(api() ? `${api()}/municipios` : 'dados/indice.json'),
    analise: (ibge) => json(api() ? `${api()}/${ibge}` : `dados/analise/${ibge}.json`),
    normas: () => json('dados/rag/chunks.json').then((d) => d.normas),
  };

  // ---------- peças ----------

  function cabecalho(kicker, titulo, sub) {
    return h('div', { class: 'mesa-head' },
      h('div', {},
        h('div', { class: 'kicker' }, kicker),
        h('h1', { class: 'mesa-titulo', tabindex: '-1', id: 'tf-titulo' }, titulo),
        sub ? h('p', { class: 'aviso' }, sub) : null));
  }

  const kpi = (numero, rotulo, tom) => h('div', { class: 'kpi ' + (tom || '') }, h('span', { class: 'kpi-n' }, numero), h('span', { class: 'kpi-r' }, rotulo));

  function secao(titulo, nota, ...corpo) {
    return h('section', { class: 'faixa' },
      h('div', { class: 'section-head' }, h('h2', {}, titulo)),
      h('hr', { class: 'rule' }),
      nota ? h('p', { class: 'faixa-nota' }, nota) : null,
      ...corpo);
  }

  const chipNivel = (n) => h('span', { class: NIVEL[n].chip, title: NIVEL[n].desc }, n);

  function contagem(t) {
    return h('span', { class: 'tf-chips' },
      t.criticos ? h('span', { class: 'chip chip-fatal' }, `${t.criticos} crítico${t.criticos > 1 ? 's' : ''}`) : null,
      t.alertas ? h('span', { class: 'chip chip-alta' }, `${t.alertas} alerta${t.alertas > 1 ? 's' : ''}`) : null,
      t.oportunidades ? h('span', { class: 'chip' }, `${t.oportunidades} oportunidade${t.oportunidades > 1 ? 's' : ''}`) : null);
  }

  // Tabela com páginas de POR_PAGINA linhas (padrão das tabelas do site).
  function tabelaPaginada(cabecas, linhas, rotulo) {
    let pagina = 0;
    const corpo = h('tbody');
    const info = h('span', { 'aria-live': 'polite' });
    const ant = h('button', { type: 'button', class: 'botao-texto', onclick: () => { pagina--; desenha(); } }, '‹ Anterior');
    const prox = h('button', { type: 'button', class: 'botao-texto', onclick: () => { pagina++; desenha(); } }, 'Próxima ›');
    const total = Math.max(1, Math.ceil(linhas.length / POR_PAGINA));
    function desenha() {
      corpo.replaceChildren(...linhas.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA));
      info.textContent = `página ${pagina + 1} de ${total}`;
      ant.disabled = pagina === 0;
      prox.disabled = pagina >= total - 1;
    }
    desenha();
    return h('div', {},
      h('div', { class: 'tabela-rolagem' }, h('table', { class: 'tabela', 'aria-label': rotulo },
        h('thead', {}, h('tr', {}, cabecas.map(([t, num]) => h('th', { class: num ? 'tf-num' : null, scope: 'col' }, t)))), corpo)),
      total > 1 ? h('div', { class: 'tf-paginas tf-nao-imprime' }, ant, info, prox) : null);
  }

  // ---------- gaveta: texto da norma ----------

  const gav = {
    el: document.getElementById('tf-gaveta'),
    fundo: document.getElementById('tf-gaveta-fundo'),
    volta: null,
    abre(t, origem) {
      gav.volta = origem || null;
      document.getElementById('tf-gaveta-kicker').textContent = t.norma;
      document.getElementById('tf-gaveta-titulo').textContent = t.rotulo;
      document.getElementById('tf-gaveta-corpo').replaceChildren(h('div', {},
        t.caminho && t.caminho.length ? h('p', { class: 'tf-norma-caminho' }, t.caminho.join(' › ')) : null,
        t.contexto ? h('p', { class: 'tf-norma-ctx' }, t.contexto) : null,
        h('p', { class: 'tf-norma-texto' }, t.texto),
        h('p', { class: 'aviso' }, 'Texto consolidado do serviço normas.leg.br (Senado Federal), na versão usada pelo módulo. ',
          h('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir a norma completa ↗'))));
      gav.fundo.hidden = false;
      gav.el.hidden = false;
      requestAnimationFrame(() => gav.el.classList.add('aberta'));
      gav.el.focus();
    },
    fecha() {
      if (gav.el.hidden) return;
      gav.el.classList.remove('aberta');
      gav.el.hidden = true;
      gav.fundo.hidden = true;
      if (gav.volta) gav.volta.focus();
    },
  };
  document.getElementById('tf-gaveta-fechar').addEventListener('click', gav.fecha);
  gav.fundo.addEventListener('click', gav.fecha);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') gav.fecha(); });

  // ---------- cartão de um gargalo ----------

  function blocoImpacto(x) {
    const i = x.impacto;
    const anual = i.natureza === 'valor_a_aplicar' || i.natureza === 'recurso_parado' ? brl(i.anual) : `${brl(i.anual)}/ano`;
    return h('div', { class: 'tf-impacto' },
      h('span', { class: 'kicker' }, NATUREZA[i.natureza]),
      i.mensal != null ? h('strong', {}, `${brl(i.mensal)}/mês`) : null,
      h('strong', {}, anual),
      h('span', { class: 'tf-sub' }, `Atual: ${x.atual} · Referência: ${x.parametro}`));
  }

  function cartao(x, a, g) {
    const passos = g ? {
      responsavel: g.passo_a_passo_operacional.responsavel_tecnico,
      sistema: g.passo_a_passo_operacional.sistema_oficial,
      acao: g.passo_a_passo_operacional.acao_corretiva_exata,
      prazo: g.passo_a_passo_operacional.prazo_competencia_limite,
    } : x.passos;
    const citacoes = x.base_legal.map((id) => a.trechos[id]).filter(Boolean);
    return h('article', { class: `est-req tf-card ${NIVEL[x.nivel].card}`, 'data-id': x.id, 'data-eixo': x.eixo, 'data-nivel': x.nivel },
      h('div', { class: 'tf-card-topo' },
        chipNivel(x.nivel),
        h('span', { class: 'chip chip-alta' }, x.eixo),
        x.impacto.confianca !== 'alta' ? h('span', { class: 'chip', title: 'Confiança da estimativa' }, `confiança ${x.impacto.confianca}`) : null),
      h('h3', { class: 'est-req-titulo' }, x.titulo),
      h('p', {}, g ? g.diagnostico_direto : x.diagnostico),
      blocoImpacto(x),
      g ? h('p', { class: 'tf-sub' }, g.impacto_financeiro) : null,
      h('ol', { class: 'tf-passos', 'aria-label': 'Passo a passo operacional' },
        h('li', {}, h('b', {}, 'Responsável técnico: '), passos.responsavel),
        h('li', {}, h('b', {}, 'Sistema oficial: '), passos.sistema),
        h('li', {}, h('b', {}, 'Ação corretiva: '), passos.acao),
        h('li', {}, h('b', {}, 'Prazo ou competência: '), passos.prazo)),
      h('div', { class: 'tf-base' },
        h('span', { class: 'kicker' }, 'Base legal'),
        citacoes.map((t) => h('button', { type: 'button', class: 'botao-texto', onclick: (e) => gav.abre(t, e.currentTarget) }, t.rotulo)),
        x.normas_externas.map((n) => h('span', { class: 'tf-externa', title: n.observacao }, `${n.rotulo} (texto não verificado: a conferir)`))),
      h('details', { class: 'tf-calculo' },
        h('summary', {}, 'Como foi calculado'),
        h('p', {}, x.impacto.metodo),
        h('ul', { class: 'lista-seca' }, x.fontes_dados.map((f) => h('li', {}, f)))));
  }

  // ---------- telas ----------

  function telaEscolha(idx) {
    const ultimo = guarda.le('tf-municipio', null);
    let ordem = 'nome';
    const lista = h('ul', { class: 'lista tf-escolha' });
    const busca = h('input', { type: 'search', placeholder: 'Digite o nome do município', 'aria-label': 'Buscar município', oninput: () => desenha() });
    function desenha() {
      const k = semAcento(busca.value.trim());
      const ms = idx.municipios.filter((m) => !k || semAcento(m.nome).includes(k));
      if (ordem === 'risco') ms.sort((p, q) => q.criticos - p.criticos || q.alertas - p.alertas || q.perda_anual - p.perda_anual);
      lista.replaceChildren(...ms.map((m) => h('li', { class: 'item' },
        h('a', { href: `#/m/${m.ibge}`, class: 'tf-escolha-link' },
          h('span', { class: 'tf-escolha-nome' }, m.nome, h('span', { class: 'tf-sub' }, ` · ${NF0.format(m.populacao)} hab.`)),
          contagem(m),
          h('span', { class: 'tf-escolha-chamada' }, m.chamada)))));
      if (!ms.length) lista.append(h('li', { class: 'item nada' }, 'Nenhum município com esse nome.'));
    }
    const botoes = [['nome', 'Nome'], ['risco', 'Mais críticos primeiro']].map(([k, t]) =>
      h('button', { type: 'button', class: 'filtro', 'aria-pressed': String(k === ordem), onclick: (e) => {
        ordem = k;
        for (const b of botoes) b.setAttribute('aria-pressed', String(b === e.currentTarget));
        desenha();
      } }, t));
    desenha();
    const anterior = ultimo && idx.municipios.find((m) => m.ibge === ultimo);
    const com = idx.municipios.filter((m) => m.criticos).length;
    return h('div', {},
      cabecalho('Transferências federais · Tocantins', 'Escolha o município',
        'Onde a prefeitura perde ou pode ganhar repasses federais em educação, saúde e assistência social, quanto isso vale e o passo a passo para corrigir.'),
      anterior ? h('p', {}, h('a', { class: 'btn btn-inline', href: `#/m/${anterior.ibge}` }, `Continuar com ${anterior.nome} →`)) : null,
      h('p', { class: 'faixa-nota' }, `${idx.municipios.length} prefeituras; ${com} com ao menos um gargalo crítico nos dados do Tesouro consultados em ${dataBr(idx.consultado_em)}.`),
      h('div', { class: 'busca tf-busca' }, busca),
      h('div', { class: 'filtros tf-filtros' }, h('span', { class: 'kicker' }, 'Ordenar'), botoes),
      lista);
  }

  const dataBr = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '–');

  function telaPanorama(a, parecer) {
    const t = a.totais;
    const ref = a.referencia;
    const porId = parecer ? new Map(parecer.gargalos.map((g) => [g.achado_id, g])) : new Map();
    let eixo = guarda.le('tf-eixo', 'Todos');
    if (eixo !== 'Todos' && !EIXOS.includes(eixo)) eixo = 'Todos';
    const cards = h('div', { class: 'est-reqs' });
    function desenha() {
      const xs = a.achados.filter((x) => eixo === 'Todos' || x.eixo === eixo);
      cards.replaceChildren(...xs.map((x) => cartao(x, a, porId.get(x.id))));
      if (!xs.length) cards.append(h('p', { class: 'nada' }, eixo === 'Todos' ? 'Nenhum gargalo encontrado nos dados abertos do Tesouro. Veja abaixo o que depende de outros sistemas.' : `Nenhum gargalo em ${eixo} nos dados abertos.`));
    }
    const filtros = ['Todos', ...EIXOS].map((e) => {
      const n = e === 'Todos' ? a.achados.length : a.achados.filter((x) => x.eixo === e).length;
      return h('button', { type: 'button', class: 'filtro', 'aria-pressed': String(e === eixo), onclick: (ev) => {
        eixo = e;
        guarda.grava('tf-eixo', e);
        for (const b of filtros) b.setAttribute('aria-pressed', String(b === ev.currentTarget));
        desenha();
      } }, e, h('span', { class: 'n' }, n));
    });
    desenha();
    const sub = `${NF0.format(a.populacao)} habitantes · grupo de comparação: ${a.indicadores.fundeb_hab ? a.indicadores.fundeb_hab.grupo : a.faixa}` +
      (ref.caixa_em ? ` · contabilidade enviada ao Tesouro até ${ref.caixa_em}` : '');
    return h('div', {},
      cabecalho('Transferências federais · panorama para o prefeito', a.nome, sub),
      h('div', { class: 'kpis tf-kpis' },
        kpi(brlCurto(t.perda_anual), 'Repasses em risco por ano', t.perda_anual ? 't-perigo' : 't-fraco'),
        kpi(brlCurto(t.ganho_anual), 'A buscar por ano (estimado)', t.ganho_anual ? 't-ok' : 't-fraco'),
        kpi(brlCurto(t.a_aplicar), 'A aplicar nos mínimos legais', t.a_aplicar ? 't-alerta' : 't-fraco'),
        kpi(brlCurto(t.parado), 'Recurso federal parado', t.parado ? 't-alerta' : 't-fraco'),
        kpi(String(t.criticos), t.criticos === 1 ? 'Gargalo crítico' : 'Gargalos críticos', t.criticos ? 't-perigo' : 't-fraco'),
        kpi(String(t.alertas + t.oportunidades), 'Alertas e oportunidades', 't-fraco')),
      api() ? blocoParecer(a, parecer) : null,
      secao('Gargalos e passo a passo',
        'Do mais grave ao menos grave. Os valores vêm do motor de regras, calculados sobre os dados que a prefeitura enviou ao Tesouro (Siconfi); "confiança baixa" é sinal para investigar, não valor devido.',
        h('div', { class: 'filtros tf-filtros tf-nao-imprime' }, h('span', { class: 'kicker' }, 'Eixo'), filtros),
        cards),
      secao('Para completar o diagnóstico',
        'O que os dados abertos do Tesouro não mostram. Com estes dados, o módulo consegue avaliar as regras de ponderação, equipes e índices de gestão.',
        h('div', { class: 'tf-pend' }, a.pendencias.map((p) => h('div', { class: 'painel' },
          h('p', { class: 'kicker' }, p.eixo),
          h('h3', { class: 'est-req-titulo' }, p.tema),
          h('p', {}, p.por_que),
          h('p', { class: 'tf-sub' }, `Onde: ${p.onde} · Quem: ${p.quem}`))))));
  }

  function blocoParecer(a, parecer) {
    const caixa = h('div', { class: 'painel tf-parecer' });
    const estado = h('p', { class: 'aviso', 'aria-live': 'polite' });
    async function gera(refazer) {
      estado.textContent = 'Gerando o parecer: o consultor lê os achados e as normas; pode levar alguns minutos.';
      estado.classList.remove('tf-erro');
      for (const b of caixa.querySelectorAll('button')) b.disabled = true;
      try {
        await json(`${api()}/${a.ibge}/parecer`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ refazer }) });
        rota();
      } catch (e) {
        estado.textContent = e.status === 429 ? 'Limite de pareceres por hora atingido. Tente mais tarde.' : `Não foi possível gerar o parecer (${e.message}).`;
        estado.classList.add('tf-erro');
        for (const b of caixa.querySelectorAll('button')) b.disabled = false;
      }
    }
    if (!parecer) {
      caixa.append(
        h('p', { class: 'kicker' }, 'Parecer do consultor'),
        h('p', {}, 'O consultor (IA) redige o parecer a partir dos achados abaixo e dos trechos das normas, e cada valor em reais é conferido com o motor antes de aparecer aqui.'),
        h('div', { class: 'form-acoes' }, h('button', { type: 'button', class: 'btn btn-inline', onclick: () => gera(false) }, 'Gerar parecer')),
        estado);
      return caixa;
    }
    caixa.append(
      h('p', { class: 'kicker' }, `Parecer do consultor · ${dataBr(parecer.gerado_em)}`),
      h('p', { class: 'tf-resumo' }, parecer.resumo_executivo),
      h('p', { class: 'aviso' }, parecer.origem === 'agente'
        ? 'Redigido pelo consultor (IA) e conferido com o motor de regras: os cartões abaixo mostram esse texto; valores e normas fora do conferido foram trocados pelo texto do motor.'
        : 'Texto do motor de regras (o consultor de IA não estava disponível).'),
      parecer.ajustes && parecer.ajustes.length ? h('details', { class: 'tf-calculo' },
        h('summary', {}, `O que a conferência mudou (${parecer.ajustes.length})`),
        h('ul', { class: 'tf-ajustes lista-seca' }, parecer.ajustes.map((x) => h('li', {}, x)))) : null,
      h('div', { class: 'form-acoes tf-nao-imprime' }, h('button', { type: 'button', class: 'botao-texto', onclick: () => gera(true) }, 'Gerar de novo')),
      estado);
    return caixa;
  }

  const fmtInd = (v, u) => (v == null ? '–' : u === 'R$/hab' ? `R$ ${NF2.format(v)}` : u === 'meses' ? `${NF1.format(v)} meses` : u === '%' ? `${NF2.format(v)}%` : brl(v));

  function telaReceitas(a) {
    const ref = a.referencia;
    const fontes = [...a.receitas_federais].sort((p, q) => (q.ano_base || 0) - (p.ano_base || 0));
    const max = Math.max(1, ...fontes.map((f) => f.ano_base || 0));
    const linhas = fontes.map((f) => {
      const barra = h('span', { class: 'tf-barra', 'aria-hidden': 'true' });
      barra.style.width = `${Math.max(2, Math.round((60 * (f.ano_base || 0)) / max))}px`;
      return h('tr', {},
        h('td', {}, f.fonte),
        h('td', {}, f.rotulo, h('span', { class: 'tf-sub' }, ` · ${f.eixo}`)),
        h('td', { class: 'tf-num' }, brl(f.ano_base), ' ', barra),
        h('td', { class: 'tf-num' }, brl(f.corrente)),
        h('td', { class: 'tf-num' }, brl(f.caixa)));
    });
    const inds = Object.entries(a.indicadores).map(([, i]) => h('tr', {},
      h('td', {}, i.rotulo),
      h('td', { class: 'tf-num' }, fmtInd(i.valor, i.unidade)),
      h('td', { class: 'tf-num' }, fmtInd(i.p25, i.unidade)),
      h('td', { class: 'tf-num' }, fmtInd(i.mediana, i.unidade)),
      h('td', { class: 'tf-num' }, fmtInd(i.p75, i.unidade)),
      h('td', {}, `${i.grupo} (${i.n})`)));
    return h('div', {},
      cabecalho('Transferências federais · receitas', a.nome, 'Receitas federais por fonte de recursos e comparação com as prefeituras do mesmo porte no Tocantins.'),
      secao('Receitas federais por fonte',
        `Receita realizada na contabilidade enviada ao Tesouro (Matriz de Saldos Contábeis): ${ref.ano_base} inteiro e ${ref.ano_corrente || '–'} até o mês ${ref.meses_corrente || '–'}; caixa em ${ref.caixa_em || '–'} (contas de caixa e equivalentes, por fonte).`,
        tabelaPaginada([['Fonte'], ['Recurso'], [`${ref.ano_base} (12 meses)`, true], [`${ref.ano_corrente || 'ano corrente'} (até o mês ${ref.meses_corrente || '–'})`, true], ['Caixa', true]], linhas, 'Receitas federais por fonte')),
      secao('Comparação com as prefeituras do mesmo porte',
        'Valor desta prefeitura e quartis do grupo (25% das prefeituras ficam abaixo do 1º quartil e 25% acima do 3º). Entre parênteses, quantas prefeituras do grupo têm o dado.',
        tabelaPaginada([['Indicador'], ['Prefeitura', true], ['1º quartil', true], ['Mediana', true], ['3º quartil', true], ['Grupo']], inds, 'Comparação com o grupo')));
  }

  function telaRelatorio(a, parecer) {
    const porId = parecer ? new Map(parecer.gargalos.map((g) => [g.achado_id, g])) : new Map();
    const t = a.totais;
    return h('div', { class: 'tf-relatorio' },
      cabecalho('Relatório · transferências federais', a.nome, `Gerado em ${dataBr(new Date().toISOString())} a partir dos dados do Tesouro até ${a.referencia.caixa_em || '–'}.`),
      h('p', { class: 'tf-nao-imprime' }, h('button', { type: 'button', class: 'btn btn-inline', onclick: () => window.print() }, 'Imprimir ou salvar em PDF')),
      parecer ? h('p', { class: 'tf-resumo' }, parecer.resumo_executivo) : null,
      h('p', {}, `Repasses em risco: ${brl(t.perda_anual)} por ano. A buscar (estimado): ${brl(t.ganho_anual)} por ano. A aplicar nos mínimos: ${brl(t.a_aplicar)}. Recurso federal parado: ${brl(t.parado)}.`),
      h('div', { class: 'est-reqs' }, a.achados.map((x) => cartao(x, a, porId.get(x.id)))),
      secao('Para completar o diagnóstico', null, h('ul', { class: 'lista-seca' }, a.pendencias.map((p) => h('li', {}, `${p.eixo}: ${p.tema}. ${p.onde}.`)))));
  }

  function telaMetodologia(normas) {
    return h('div', {},
      cabecalho('Transferências federais · metodologia', 'Como o módulo chega aos números', null),
      secao('As quatro camadas', null,
        h('ol', { class: 'tf-passos' },
          h('li', {}, h('b', {}, 'Dados abertos (ETL). '), 'Para cada prefeitura do Tocantins, o Siconfi (Tesouro Nacional): RREO Anexo 14 (mínimos de educação, FUNDEB e saúde), RGF Anexo 5 (caixa por vinculação no fim do ano) e a Matriz de Saldos Contábeis (receita realizada e caixa por fonte de recursos). Resultado: um perfil por município.'),
          h('li', {}, h('b', {}, 'Motor de regras. '), 'Compara cada número com o parâmetro legal ou com as prefeituras do mesmo porte e estima o impacto em reais por mês e por ano. É determinístico: a mesma entrada dá a mesma saída.'),
          h('li', {}, h('b', {}, 'Normas (RAG). '), 'Leis e decretos do normas.leg.br, fatiados em Lei › Capítulo › Seção › Artigo › Parágrafo. Cada regra cita os trechos exatos; uma busca textual traz o contexto vizinho.'),
          h('li', {}, h('b', {}, 'Consultor (IA). '), 'Redige o parecer a partir dos achados e dos trechos. Antes de aparecer, o texto é conferido: valores em reais, percentuais e normas que não estão nos achados ou nos trechos são trocados pelo texto do motor.'))),
      secao('Limites', null,
        h('ul', { class: 'lista-seca' },
          h('li', {}, 'Os números dependem do que a prefeitura enviou ao Tesouro; classificação contábil errada (fonte de recursos) aparece como gargalo e precisa ser conferida com a contabilidade.'),
          h('li', {}, 'O RREO simplificado não traz os percentuais mínimos no Tesouro: para essas prefeituras, os percentuais ficam como pendência (SIOPE e SIOPS).'),
          h('li', {}, 'Ponderação do Educacenso, equipes do SCNES, cadastros do e-SUS APS e índices do SUAS dependem de sistemas com acesso restrito; o módulo indica onde conferir.'),
          h('li', {}, 'A comparação por habitante é um sinal para investigar: a diferença até a mediana não é valor devido.'),
          h('li', {}, 'Portarias e manuais fora do normas.leg.br (por exemplo, Portaria GM/MS nº 3.493/2024 e Portaria MDS nº 113/2015) aparecem como "a conferir" até entrarem no corpus.'))),
      secao('Normas no corpus', null,
        h('div', { class: 'tabela-rolagem' }, h('table', { class: 'tabela' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Norma'), h('th', {}, 'Texto'), h('th', { class: 'tf-num' }, 'Artigos'), h('th', { class: 'tf-num' }, 'Trechos'))),
          h('tbody', {}, normas.map((n) => h('tr', {},
            h('td', {}, n.url ? h('a', { href: n.url, target: '_blank', rel: 'noopener noreferrer' }, n.rotulo) : n.rotulo),
            h('td', {}, n.texto),
            h('td', { class: 'tf-num' }, n.artigos),
            h('td', { class: 'tf-num' }, n.trechos))))))));
  }

  // ---------- navegação ----------

  function nav(a, aba) {
    const itens = a
      ? [['', 'Panorama'], ['receitas', 'Receitas e pares'], ['relatorio', 'Relatório']].map(([k, t]) => [`#/m/${a.ibge}${k ? '/' + k : ''}`, t, aba === (k || 'panorama')])
      : [];
    itens.push(['#/metodologia', 'Metodologia', aba === 'metodologia']);
    document.getElementById('tf-nav').replaceChildren(...itens.map(([href, t, atual]) => h('a', { class: 'nav-item', href, 'aria-current': atual ? 'page' : null }, t)));
    document.getElementById('tf-contexto').replaceChildren(a ? h('span', {}, a.nome, ' · ', h('a', { href: '#/' }, 'trocar')) : h('a', { href: '#/' }, 'Escolher município'));
  }

  async function parecerSalvo(ibge) {
    if (!api()) return null;
    try {
      return await json(`${api()}/${ibge}/parecer`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  let geracao = 0;
  async function rota() {
    const minha = ++geracao;
    const [nome = '', arg, aba = 'panorama'] = location.hash.replace(/^#\/?/, '').split('/');
    let tela;
    try {
      app.setAttribute('aria-busy', 'true');
      if (nome === 'm' && /^17\d{5}$/.test(arg || '')) {
        const [a, parecer] = await Promise.all([fonte.analise(arg), parecerSalvo(arg)]);
        if (minha !== geracao) return;
        guarda.grava('tf-municipio', a.ibge);
        nav(a, aba);
        tela = aba === 'receitas' ? telaReceitas(a) : aba === 'relatorio' ? telaRelatorio(a, parecer) : telaPanorama(a, parecer);
      } else if (nome === 'metodologia') {
        const normas = await fonte.normas();
        if (minha !== geracao) return;
        nav(null, 'metodologia');
        tela = telaMetodologia(normas);
      } else {
        const idx = await fonte.indice();
        if (minha !== geracao) return;
        nav(null, '');
        tela = telaEscolha(idx);
      }
    } catch (e) {
      tela = h('div', { class: 'plain' }, h('h1', { id: 'tf-titulo', tabindex: '-1' }, e.status === 401 || e.status === 403 ? 'Sem acesso' : 'Não foi possível abrir'),
        h('p', {}, e.status === 403 ? 'Sua conta não tem acesso a esta prefeitura.' : e.message), h('a', { class: 'back', href: '#/' }, '← Escolher município'));
    }
    if (minha !== geracao) return;
    app.removeAttribute('aria-busy');
    app.replaceChildren(tela);
    const t = document.getElementById('tf-titulo');
    if (t) t.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  // ---------- aparência (Terminal, Claro, Escuro, como no site) ----------

  function aparencia() {
    const sel = document.getElementById('tf-aparencia');
    const salva = guarda.le('mm-aparencia', null);
    const padrao = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro';
    const aplica = (v) => {
      const html = document.documentElement;
      html.setAttribute('data-tema', v);
      if (v === 'terminal') html.removeAttribute('data-estilo');
      else html.setAttribute('data-estilo', 'moderno');
      html.style.colorScheme = v === 'claro' ? 'light' : 'dark';
    };
    const inicial = ['terminal', 'claro', 'escuro'].includes(salva) ? salva : padrao;
    sel.value = inicial;
    aplica(inicial);
    sel.addEventListener('change', () => { aplica(sel.value); guarda.grava('mm-aparencia', sel.value); });
  }

  aparencia();
  window.addEventListener('hashchange', rota);
  rota();
})();
