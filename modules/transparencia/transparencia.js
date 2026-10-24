/*
 * Módulo Transparência (PNTP/Atricon) para os municípios do Tocantins.
 *
 * Lê dados/transparencia-to.json (gerado por build_dados.py) e desenha tudo no <main id="tr-app">.
 * Sem dependências e sem estilos inline além dos de largura: o site exige script-src 'self'.
 * Todo texto vindo dos dados entra por textContent; nada é interpretado como HTML.
 */
(() => {
  'use strict';

  const META = 0.95; // piso do Diamante
  const ITENS = { D: 'Disponibilidade', A: 'Atualidade', S: 'Série histórica', G: 'Gravação de relatórios', F: 'Filtro de pesquisa' };
  const SELOS = ['Diamante', 'Ouro', 'Prata'];
  const GRUPOS_NIVEL = ['Diamante', 'Ouro', 'Prata', 'Elevado', 'Intermediário', 'Abaixo'];
  const ABAIXO = new Set(['Básico', 'Inicial', 'Inexistente', 'Não Avaliado']);
  const CLASSES = ['Essencial', 'Obrigatória', 'Recomendada'];
  const ORDEM_NIVEL = ['Diamante', 'Ouro', 'Prata', 'Elevado', 'Intermediário', 'Básico', 'Inicial', 'Inexistente', 'Não Avaliado'];

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

  function sv(tag, attrs, ...filhos) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    for (const f of filhos.flat(Infinity)) if (f != null) e.append(f.nodeType ? f : document.createTextNode(String(f)));
    return e;
  }

  const nf = (casas) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
  const NF0 = nf(0), NF1 = nf(1);
  const pct = (x) => (x == null ? '–' : NF1.format(x * 100) + '%');
  const pontos = (x) => (x >= 0 ? '+' : '−') + NF1.format(Math.abs(x)) + ' pt';
  const urlSegura = (u) => (/^https?:\/\//i.test(u || '') ? u : null);
  const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  function link(url, texto, extra) {
    const u = urlSegura(url);
    return u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', ...extra }, texto) : h('span', {}, texto);
  }

  /** Regras da Cartilha PNTP 2026 (tabela 3): o selo exige 100% dos itens essenciais. */
  function classifica(indice, essenciaisOk) {
    if (indice == null) return 'Não Avaliado';
    if (indice >= 0.95 && essenciaisOk) return 'Diamante';
    if (indice >= 0.85 && essenciaisOk) return 'Ouro';
    if (indice >= 0.75 && essenciaisOk) return 'Prata';
    if (indice >= 0.75) return 'Elevado';
    if (indice >= 0.5) return 'Intermediário';
    if (indice >= 0.3) return 'Básico';
    if (indice > 0) return 'Inicial';
    return 'Inexistente';
  }

  const grupoDoNivel = (n) => (ABAIXO.has(n) ? 'Abaixo' : n);

  function chipNivel(n) {
    return h('span', { class: 'chip tr-nivel', 'data-n': n }, n);
  }

  // ---------- dados derivados ----------

  let D, CRIT, ANO, ANT, ANOS;

  function agrupaFalhas(m) {
    const por = new Map();
    for (const [id, cod, ganho, falhando, total] of m.falhas || []) {
      if (!por.has(id)) por.set(id, { id, crit: CRIT.get(id), itens: [], ganho: 0 });
      const g = por.get(id);
      g.itens.push({ cod, ganho, falhando, total });
      g.ganho += ganho;
    }
    return [...por.values()];
  }

  /** Menor lista (gulosa) de critérios a corrigir para chegar ao Diamante: primeiro os essenciais, depois o maior ganho. */
  function caminho(m) {
    const grupos = m.grupos;
    let indice = m.atual.i;
    const passos = grupos.filter((g) => g.crit.exig === 'Essencial');
    for (const g of passos) indice += g.ganho / 100;
    for (const g of grupos.filter((x) => x.crit.exig !== 'Essencial').sort((a, b) => b.ganho - a.ganho)) {
      if (indice >= META) break;
      passos.push(g);
      indice += g.ganho / 100;
    }
    return { passos, projetado: Math.min(indice, 1), alcanca: indice >= META - 1e-9 };
  }

  function prepara(dados) {
    D = dados;
    ANOS = D.meta.ciclos.map(String);
    ANO = String(D.meta.ciclo_atual);
    ANT = ANOS[ANOS.indexOf(ANO) - 1];
    CRIT = new Map(D.criterios.map((c) => [c.id, c]));
    for (const m of D.municipios) {
      m.atual = m.pref[ANO];
      m.anterior = m.pref[ANT];
      m.grupos = agrupaFalhas(m);
      m.essFalta = m.grupos.filter((g) => g.crit.exig === 'Essencial');
      m.caminho = caminho(m);
      m.busca = semAcento(m.nome);
    }
  }

  const contaNiveis = (ano) => {
    const c = {};
    for (const m of D.municipios) {
      const f = m.pref[ano];
      if (f) c[f.n] = (c[f.n] || 0) + 1;
    }
    return c;
  };

  // ---------- peças de interface ----------

  function cabecalho(kicker, titulo, sub) {
    return h('div', { class: 'mesa-head' },
      h('div', {},
        h('div', { class: 'kicker' }, kicker),
        h('h1', { class: 'mesa-titulo', tabindex: '-1', id: 'tr-titulo' }, titulo),
        sub ? h('p', { class: 'aviso' }, sub) : null));
  }

  function kpi(numero, rotulo, tom) {
    return h('div', { class: 'kpi ' + (tom || '') }, h('span', { class: 'kpi-n' }, numero), h('span', { class: 'kpi-r' }, rotulo));
  }

  function secao(titulo, nota, ...corpo) {
    return h('section', { class: 'faixa' },
      h('div', { class: 'section-head' }, h('h2', {}, titulo)),
      h('hr', { class: 'rule' }),
      nota ? h('p', { class: 'faixa-nota' }, nota) : null,
      ...corpo);
  }

  function setaVariacao(m) {
    const a = m.anterior, b = m.atual;
    if (!a || !b || a.i == null || b.i == null) return h('span', { class: 'tr-delta' }, '–');
    const d = (b.i - a.i) * 100;
    const r = ORDEM_NIVEL.indexOf(b.n) - ORDEM_NIVEL.indexOf(a.n);
    const rotulo = r < 0 ? '▲' : r > 0 ? '▼' : '=';
    const tom = r < 0 ? 'tr-sobe' : r > 0 ? 'tr-desce' : '';
    const tit = a.n === b.n ? `Manteve ${b.n}` : `${a.n} → ${b.n}`;
    return h('span', { class: 'tr-delta ' + tom, title: tit }, `${rotulo} ${pontos(d)}`);
  }

  function pilhaNiveis(ano) {
    const c = contaNiveis(ano);
    const total = D.municipios.filter((m) => m.pref[ano]).length;
    const bar = h('div', { class: 'tr-pilha', role: 'img', 'aria-label': `Ciclo ${ano}: ` + ORDEM_NIVEL.filter((n) => c[n]).map((n) => `${c[n]} ${n}`).join(', ') });
    for (const n of ORDEM_NIVEL) {
      if (!c[n]) continue;
      const seg = h('span', { class: 'tr-seg', 'data-n': n, title: `${n}: ${c[n]}` }, c[n] >= 6 ? String(c[n]) : '');
      seg.style.width = (c[n] / total) * 100 + '%';
      bar.append(seg);
    }
    return h('div', { class: 'tr-pilha-linha' }, h('span', { class: 'tr-ano' }, ano), bar);
  }

  function legendaNiveis() {
    return h('ul', { class: 'tr-legenda' }, ORDEM_NIVEL.map((n) => h('li', {}, h('span', { class: 'tr-seg-cor', 'data-n': n }), n)));
  }

  /** Ciclos em que houve prefeitura sem índice (nível "Inexistente", 0%, ou "Não Avaliado"). */
  function notaSemAvaliacao() {
    const partes = ANOS.map((a) => {
      const c = contaNiveis(a);
      const q = [];
      if (c.Inexistente) q.push(`${c.Inexistente} como "Inexistente" (índice 0%)`);
      if (c['Não Avaliado']) q.push(`${c['Não Avaliado']} como "Não Avaliado"`);
      return q.length ? `${a}: ${q.join(' e ')}` : null;
    }).filter(Boolean);
    return h('p', { class: 'aviso' }, partes.length ? 'Prefeituras sem índice válido em ' + partes.join('; ') + '.' : 'Todas as prefeituras tiveram índice em todos os ciclos.');
  }

  /** Critérios que viram essenciais no próximo ciclo e quem, com selo hoje, ainda não os atende. */
  function avisoProximoCiclo() {
    const prox = D.meta.proximo_ciclo;
    if (!prox) return null;
    const novos = prox.essenciais.filter((id) => CRIT.has(id) && CRIT.get(id).exig !== 'Essencial');
    if (!novos.length) return null;
    const expostas = D.municipios.filter((m) => SELOS.includes(m.atual.n) && m.grupos.some((g) => novos.includes(g.id)));
    const total = D.municipios.filter((m) => m.grupos.some((g) => novos.includes(g.id))).length;
    const singular = novos.length === 1;
    return h('div', { class: 'painel tr-aviso' },
      h('p', { class: 'kicker' }, `Atenção ao ciclo ${prox.ano}`),
      h('p', {}, `Na matriz ${prox.ano}, ${singular ? 'o critério abaixo passa' : 'os critérios abaixo passam'} a ser essencia${singular ? 'l' : 'is'} (${prox.essenciais.length} essenciais no total):`),
      h('ul', { class: 'lista-seca' }, novos.map((id) => h('li', {}, `${id} ${CRIT.get(id).texto}`))),
      h('p', {}, `${total} prefeitura(s) ainda não ${total === 1 ? 'atende' : 'atendem'} integralmente ${singular ? 'esse critério' : 'esses critérios'}`,
        expostas.length
          ? [`; ${expostas.length} ${expostas.length === 1 ? 'delas tem' : 'delas têm'} selo hoje e ${expostas.length === 1 ? 'pode' : 'podem'} perdê-lo: `, expostas.map((m, i) => [i ? ', ' : '', h('a', { href: '#/municipio/' + m.ibge }, m.nome)]), '.']
          : '; nenhuma delas tem selo hoje.'));
  }

  // ---------- telas ----------

  function telaPanorama() {
    const ms = D.municipios;
    const n = ms.length;
    const cont = contaNiveis(ANO);
    const selo = SELOS.reduce((s, x) => s + (cont[x] || 0), 0);
    const media = ms.reduce((s, m) => s + (m.atual.i || 0), 0) / n;
    const sobEssencial = ms.filter((m) => m.atual.i >= 0.75 && m.essFalta.length > 0);
    const proximos = ms.filter((m) => m.atual.n !== 'Diamante' && m.caminho.alcanca)
      .sort((a, b) => a.caminho.passos.length - b.caminho.passos.length || b.atual.i - a.atual.i).slice(0, 12);

    const falham = new Map();
    for (const m of ms) for (const g of m.grupos) falham.set(g.id, (falham.get(g.id) || 0) + 1);
    const topFalhas = [...falham.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0])).slice(0, 10);
    const maxFalha = topFalhas[0] ? topFalhas[0][1] : 1;

    return h('div', {},
      cabecalho('Módulo · Transparência', 'Transparência das prefeituras do Tocantins',
        `Programa Nacional de Transparência Pública (Atricon), ciclo ${ANO}: ${n} prefeituras. Selos: Diamante, Ouro e Prata.`),
      h('div', { class: 'kpis' },
        kpi(`${cont.Diamante || 0}`, `Selo Diamante (de ${n})`, 't-ok'),
        kpi(`${selo}`, 'Com selo (Diamante, Ouro ou Prata)', 't-ok'),
        kpi(`${n - selo}`, 'Sem selo', n - selo ? 't-alerta' : 't-ok'),
        kpi(`${sobEssencial.length}`, 'Índice alto, mas com essencial faltando', sobEssencial.length ? 't-perigo' : 't-ok'),
        kpi(pct(media), 'Índice médio das prefeituras', 't-fraco')),
      h('div', { class: 'tr-espaco' }),
      avisoProximoCiclo(),
      secao('Evolução dos níveis', 'Quantas prefeituras estão em cada nível, ciclo a ciclo.',
        ANOS.map(pilhaNiveis), legendaNiveis(),
        notaSemAvaliacao()),
      secao('Mais perto do Diamante', 'Prefeituras que chegam a 95% e a 100% dos essenciais corrigindo menos critérios (estimativa a partir das respostas de ' + ANO + ').',
        h('div', { class: 'tabela-rolagem' }, h('table', { class: 'tabela' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Município'), h('th', {}, 'Nível'), h('th', { class: 'tr-num' }, 'Índice'), h('th', { class: 'tr-num' }, 'Critérios a corrigir'), h('th', { class: 'tr-num' }, 'Essenciais faltando'))),
          h('tbody', {}, proximos.map((m) => h('tr', {},
            h('td', {}, h('a', { href: '#/municipio/' + m.ibge }, m.nome)),
            h('td', {}, chipNivel(m.atual.n)),
            h('td', { class: 'tr-num' }, pct(m.atual.i)),
            h('td', { class: 'tr-num' }, String(m.caminho.passos.length)),
            h('td', { class: 'tr-num' }, String(m.essFalta.length))))))),
        h('p', { class: 'aviso' }, h('a', { href: '#/municipios' }, 'Ver as ' + n + ' prefeituras →'))),
      secao('O que mais falha no estado', `Critérios com mais prefeituras ainda sem atender integralmente (ciclo ${ANO}).`,
        h('ul', { class: 'rel-barras' }, topFalhas.map(([id, q]) => {
          const c = CRIT.get(id);
          const barra = h('span', { class: 'rb-fio' + (c.exig === 'Essencial' ? ' t-perigo' : '') });
          barra.style.width = (q / maxFalha) * 100 + '%';
          return h('li', {},
            h('span', { class: 'rb-rot', title: c.texto }, `${id} ${c.texto}`),
            h('span', { class: 'rb-trilho' }, barra),
            h('span', { class: 'rb-val' }, `${q} de ${ms.length}`, c.exig === 'Essencial' ? h('span', { class: 'rb-nota' }, 'essencial') : null));
        })),
        h('p', { class: 'aviso' }, h('a', { href: '#/criterios' }, 'Ver todos os critérios →'))));
  }

  // ----- lista de municípios -----

  const lista = { q: '', nivel: 'Todos', ordem: 'indice', dir: -1 };

  const ORDENS = {
    nome: (m) => m.busca,
    pop: (m) => m.pop || 0,
    nivel: (m) => ORDEM_NIVEL.indexOf(m.atual.n) * 10 - m.atual.i,
    indice: (m) => m.atual.i ?? -1,
    ess: (m) => m.atual.e ?? -1,
    var: (m) => (m.anterior && m.anterior.i != null && m.atual.i != null ? m.atual.i - m.anterior.i : -9),
  };

  function csv(ms) {
    const cab = ['ibge', 'municipio', 'populacao', 'nivel_' + ANO, 'indice_' + ANO, 'essenciais_' + ANO, 'nivel_' + ANT, 'indice_' + ANT, 'portal'];
    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    return [cab.join(',')].concat(ms.map((m) => [m.ibge, m.nome, m.pop, m.atual.n, m.atual.i, m.atual.e, m.anterior?.n, m.anterior?.i, m.pref.portal].map(q).join(','))).join('\n');
  }

  function telaLista() {
    const corpo = h('tbody');
    const contagem = h('p', { class: 'aviso', 'aria-live': 'polite' });
    const cabecas = [];

    function th(rotulo, chave, num) {
      const b = h('button', { class: 'est-ord-btn' + (num ? ' est-ord-num' : ''), type: 'button', onclick: () => {
        lista.dir = lista.ordem === chave ? -lista.dir : chave === 'nome' ? 1 : -1;
        lista.ordem = chave;
        desenha();
      } }, rotulo, h('span', { class: 'est-ord-ind', 'aria-hidden': 'true' }));
      const t = h('th', { scope: 'col', class: num ? 'tr-num' : '' }, b);
      cabecas.push([chave, t, b]);
      return t;
    }

    function desenha() {
      const q = semAcento(lista.q.trim());
      let ms = D.municipios.filter((m) => (!q || m.busca.includes(q)) && (lista.nivel === 'Todos' || grupoDoNivel(m.atual.n) === lista.nivel));
      const f = ORDENS[lista.ordem];
      ms = ms.slice().sort((a, b) => {
        const x = f(a), y = f(b);
        return (x < y ? -1 : x > y ? 1 : a.busca.localeCompare(b.busca)) * lista.dir;
      });
      corpo.replaceChildren(...ms.map((m) => h('tr', {},
        h('td', {}, h('a', { href: '#/municipio/' + m.ibge }, m.nome)),
        h('td', { class: 'tr-num' }, m.pop ? NF0.format(m.pop) : '–'),
        h('td', {}, chipNivel(m.atual.n)),
        h('td', { class: 'tr-num' }, pct(m.atual.i)),
        h('td', { class: 'tr-num' }, pct(m.atual.e)),
        h('td', { class: 'tr-num' }, setaVariacao(m)),
        h('td', {}, link(m.pref.portal, 'portal ↗')))));
      if (!ms.length) corpo.append(h('tr', {}, h('td', { colspan: '7', class: 'nada' }, 'Nenhum município com esse filtro.')));
      contagem.textContent = `${ms.length} de ${D.municipios.length} prefeituras`;
      for (const [chave, t, b] of cabecas) {
        const ativo = chave === lista.ordem;
        t.setAttribute('aria-sort', ativo ? (lista.dir > 0 ? 'ascending' : 'descending') : 'none');
        b.classList.toggle('ativo', ativo);
        b.lastChild.textContent = ativo ? (lista.dir > 0 ? '▲' : '▼') : '↕';
      }
      for (const b of filtros.querySelectorAll('.filtro')) {
        const on = b.dataset.nivel === lista.nivel;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }

    const busca = h('div', { class: 'busca' }, h('input', {
      type: 'search', placeholder: 'Buscar município', 'aria-label': 'Buscar município', value: lista.q,
      oninput: (e) => { lista.q = e.target.value; desenha(); },
    }));
    const filtros = h('div', { class: 'filtros', role: 'group', 'aria-label': 'Filtrar por nível' },
      ['Todos', ...GRUPOS_NIVEL].map((n) => {
        const q = n === 'Todos' ? D.municipios.length : D.municipios.filter((m) => grupoDoNivel(m.atual.n) === n).length;
        return h('button', { class: 'filtro', type: 'button', 'data-nivel': n, onclick: () => { lista.nivel = n; desenha(); } }, n, h('span', { class: 'n' }, String(q)));
      }));
    const baixar = h('button', { class: 'btn btn-inline', type: 'button', onclick: () => {
      const url = URL.createObjectURL(new Blob(['﻿' + csv(D.municipios)], { type: 'text/csv;charset=utf-8' }));
      const a = h('a', { href: url, download: `pntp-tocantins-prefeituras-${ANO}.csv` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } }, 'Baixar CSV');

    const el = h('div', {},
      cabecalho('Módulo · Transparência', 'Prefeituras', `Nível e índice do ciclo ${ANO}; variação em relação a ${ANT}.`),
      h('div', { class: 'barra-mesa' }, filtros, h('div', { class: 'barra-direita' }, busca, baixar)),
      contagem,
      h('div', { class: 'tabela-rolagem' }, h('table', { class: 'tabela est-tabela' },
        h('thead', {}, h('tr', {},
          th('Município', 'nome'), th('População', 'pop', true), th('Nível ' + ANO, 'nivel'), th('Índice', 'indice', true),
          th('Essenciais', 'ess', true), th('Variação', 'var', true), h('th', { scope: 'col' }, 'Portal'))),
        corpo)));
    desenha();
    return el;
  }

  // ----- ficha do município -----

  function serieIndice(m) {
    const L = 560, A = 210, ex = 46, ey = 22, base = A - 30, folga = 44;
    const xs = (i) => ex + folga + (i * (L - 2 * ex - 2 * folga)) / Math.max(ANOS.length - 1, 1);
    const ys = (v) => ey + (1 - v) * (base - ey);
    const pts = ANOS.map((a, i) => (m.pref[a] && m.pref[a].i != null ? [xs(i), ys(m.pref[a].i), m.pref[a]] : null));
    const caminhoLinha = pts.filter(Boolean).map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    const desc = ANOS.map((a) => `${a}: ${m.pref[a] ? pct(m.pref[a].i) + ' (' + m.pref[a].n + ')' : 'sem avaliação'}`).join('; ');
    return h('div', { class: 'est-serie' }, sv('svg', { viewBox: `0 0 ${L} ${A}`, role: 'img', 'aria-label': 'Índice por ciclo. ' + desc },
      [0, 0.25, 0.5, 0.75, 1].map((v) => sv('g', {},
        sv('line', { class: 'est-grade', x1: ex, x2: L - ex, y1: ys(v), y2: ys(v) }),
        sv('text', { class: 'est-eixo', x: ex - 8, y: ys(v) + 4, 'text-anchor': 'end' }, `${v * 100}%`))),
      sv('line', { class: 'est-meta-linha', x1: ex, x2: L - ex, y1: ys(META), y2: ys(META) }),
      sv('text', { class: 'est-meta-txt', x: ex + 6, y: ys(META) - 6, 'text-anchor': 'start' }, 'Diamante 95%'),
      caminhoLinha ? sv('path', { class: 'est-linha', d: caminhoLinha }) : null,
      pts.map((p, i) => sv('g', {},
        p ? sv('circle', { class: 'est-ponto', cx: p[0], cy: p[1], r: 4.5 }) : null,
        p ? sv('text', { class: 'est-valor', x: p[0], y: p[1] - 11, 'text-anchor': 'middle' }, pct(p[2].i)) : null,
        sv('text', { class: 'est-eixo', x: xs(i), y: A - 8, 'text-anchor': 'middle' }, ANOS[i])))));
  }

  function placar(m) {
    const i = m.atual.i ?? 0;
    const fio = h('span', { class: 'est-placar-fio' });
    fio.style.width = i * 100 + '%';
    const marca = h('span', { class: 'est-placar-marca' }, h('span', {}, 'Diamante'));
    marca.style.left = META * 100 + '%';
    return h('div', { class: 'est-placar' },
      h('div', { class: 'est-selo' }, chipNivel(m.atual.n), ' ', h('strong', {}, pct(m.atual.i)), h('span', { class: 'tr-sub' }, ` · ciclo ${ANO}`)),
      h('div', { class: 'est-placar-linha' },
        h('span', { class: 'est-placar-rot' }, 'Índice de transparência'),
        h('span', { class: 'est-placar-trilho', role: 'img', 'aria-label': `Índice ${pct(i)}; Diamante a partir de 95%` }, fio, marca),
        h('span', { class: 'est-placar-n' }, pct(m.atual.i))),
      h('div', { class: 'est-placar-linha' },
        h('span', { class: 'est-placar-rot' }, 'Itens essenciais atendidos'),
        h('span', { class: 'est-placar-trilho', role: 'img', 'aria-label': `Essenciais ${pct(m.atual.e)}` }, (() => { const f = h('span', { class: 'est-placar-fio' }); f.style.width = (m.atual.e ?? 0) * 100 + '%'; return f; })()),
        h('span', { class: 'est-placar-n' }, pct(m.atual.e))));
  }

  const rotuloItens = (g) => g.itens.map((x) => ITENS[x.cod] + (x.total > 1 ? ` (${x.falhando}/${x.total})` : '')).join(', ');

  function simulador(m) {
    const sel = new Set();
    const resumoEl = h('div', { class: 'tr-sim-linha' });
    const avisoEl = h('p', { class: 'aviso' });
    const btnCaminho = h('button', { class: 'btn btn-inline', type: 'button', onclick: () => {
      sel.clear();
      for (const g of m.caminho.passos) sel.add(g.id);
      if ([...sel].some((id) => !visiveis(false).some((c) => c.querySelector('input').dataset.id === id))) todos = true; // não deixa marcado o que está escondido
      mostra();
    } }, 'Marcar o caminho mais curto');
    const btnLimpar = h('button', { class: 'botao-texto', type: 'button', onclick: () => { sel.clear(); sincroniza(); } }, 'Limpar');
    const caixa = h('div', { class: 'tr-sim painel' },
      h('div', { 'aria-live': 'polite' }, resumoEl, avisoEl),
      h('div', { class: 'form-acoes' }, btnCaminho, btnLimpar));
    const listaEl = h('div', { class: 'est-reqs' });
    const ids = m.grupos.map((g) => g.id);

    function projeta() {
      let indice = m.atual.i ?? 0;
      let falta = 0;
      for (const g of m.grupos) {
        if (sel.has(g.id)) indice += g.ganho / 100;
        else if (g.crit.exig === 'Essencial') falta += 1;
      }
      indice = Math.min(indice, 1);
      return { indice, falta, nivel: classifica(indice, falta === 0) };
    }

    function desenha() {
      const p = projeta();
      const chega = p.nivel === 'Diamante';
      resumoEl.replaceChildren(
        h('span', {}, 'Hoje ', chipNivel(m.atual.n), ' ', h('strong', {}, pct(m.atual.i))),
        h('span', { class: 'tr-seta', 'aria-hidden': 'true' }, '→'),
        h('span', {}, 'Projeção ', chipNivel(p.nivel), ' ', h('strong', {}, pct(p.indice))));
      avisoEl.textContent = `${sel.size} de ${ids.length} critérios marcados · essenciais faltando: ${p.falta}`
        + (chega ? ' · alcança o Diamante' : p.falta ? ' · enquanto houver essencial faltando, o teto é "Elevado"' : ` · faltam ${NF1.format(Math.max(0, (META - p.indice) * 100))} pontos para o Diamante`);
    }

    function sincroniza() {
      for (const cx of listaEl.querySelectorAll('input[type=checkbox]')) cx.checked = sel.has(cx.dataset.id);
      desenha();
    }

    const LIMITE = 12; // essenciais sempre aparecem; dos demais, os de maior ganho
    const ordenados = m.grupos.slice().sort((a, b) => (b.crit.exig === 'Essencial') - (a.crit.exig === 'Essencial') || b.ganho - a.ganho);
    const cartoes = ordenados.map((g) => {
      const ess = g.crit.exig === 'Essencial';
      return h('label', { class: 'est-req ' + (ess ? 'est-nao' : 'est-andamento') },
        h('div', { class: 'tr-crit-topo' },
          h('input', { type: 'checkbox', 'data-id': g.id, onchange: (e) => { e.target.checked ? sel.add(g.id) : sel.delete(g.id); desenha(); } }),
          h('span', { class: 'chip ' + (ess ? 'chip-fatal' : 'chip-alta') }, g.crit.exig),
          h('span', { class: 'chip' }, g.crit.dim),
          h('span', { class: 'tr-ganho' }, '+' + NF1.format(g.ganho) + ' pt')),
        h('p', { class: 'est-req-titulo' }, `${g.id} ${g.crit.texto}`),
        h('p', { class: 'item-meta' }, 'Falta: ' + rotuloItens(g)));
    });
    const visiveis = (todos) => ordenados.map((g, i) => (todos || g.crit.exig === 'Essencial' || i < LIMITE ? cartoes[i] : null)).filter(Boolean);
    let todos = false;
    const mais = h('button', { class: 'btn btn-inline tr-mais', type: 'button', onclick: () => { todos = !todos; mostra(); } });
    function mostra() {
      listaEl.replaceChildren(...visiveis(todos));
      mais.textContent = todos ? 'Mostrar só os principais' : `Mostrar os ${ordenados.length} critérios`;
      mais.hidden = ordenados.length <= visiveis(false).length;
      sincroniza();
    }
    mostra();
    return h('div', {}, caixa, listaEl, mais);
  }

  function blocoCamara(m) {
    const c = m.cam;
    const linha = ANOS.map((a) => (c[a] ? `${a}: ${c[a].n} (${pct(c[a].i)})` : null)).filter(Boolean);
    if (!linha.length) return null;
    return secao('Câmara municipal', 'Avaliada à parte pelo PNTP, com outra matriz de critérios.',
      h('ul', { class: 'lista-seca' }, linha.map((t) => h('li', {}, t))),
      h('p', { class: 'aviso' }, link(c.portal, 'Portal da câmara ↗')));
  }

  function telaFicha(ibge) {
    const m = D.municipios.find((x) => String(x.ibge) === String(ibge));
    if (!m) return h('div', { class: 'plain' }, h('h1', { id: 'tr-titulo', tabindex: '-1' }, 'Município não encontrado'), h('a', { class: 'back', href: '#/municipios' }, '← Prefeituras'));
    const cam = m.caminho;
    const ja = m.atual.n === 'Diamante';
    const resumoCaminho = ja
      ? h('p', { class: 'aviso' }, `Já é Diamante. Ainda há ${m.grupos.length} critério(s) com algum item faltando; corrigi-los dá margem contra a revisão do tribunal.`)
      : h('p', { class: 'aviso' },
        cam.alcanca
          ? `Corrigindo ${cam.passos.length} critério(s) (${m.essFalta.length} essencial(is) e ${cam.passos.length - m.essFalta.length} de maior ganho), a projeção chega a ${pct(cam.projetado)} com todos os essenciais.`
          : 'Mesmo corrigindo todos os critérios com falha, a projeção não chega a 95%. Confira a matriz: pode haver itens da matriz 2026 que não existiam em ' + ANO + '.');
    return h('div', {},
      h('p', { class: 'kicker' }, h('a', { class: 'back', href: '#/municipios' }, '← Prefeituras')),
      cabecalho('Município · ' + (m.pop ? NF0.format(m.pop) + ' habitantes' : 'Tocantins'), m.nome,
        ['Código IBGE ' + m.ibge, m.cnpj ? 'CNPJ ' + m.cnpj : null].filter(Boolean).join(' · ')),
      h('p', { class: 'aviso' }, link(m.pref.portal, 'Portal oficial ↗')),
      placar(m),
      secao('Histórico', 'Índice por ciclo do PNTP.', serieIndice(m)),
      secao('Caminho até o Diamante', 'O Diamante exige 95% ou mais e 100% dos itens essenciais. Marque o que a prefeitura pretende corrigir e veja a projeção.',
        resumoCaminho, m.grupos.length ? simulador(m) : h('p', { class: 'nada' }, 'Nenhum item com falha nas respostas de ' + ANO + '.'),
        h('p', { class: 'aviso' }, 'Projeção aproximada: usa a fórmula da Cartilha PNTP 2026 sobre as respostas de ' + ANO + '. O resultado oficial depende da validação do tribunal de contas e da revisão da Atricon.')),
      blocoCamara(m));
  }

  // ----- critérios -----

  const filtroCrit = { classe: 'Todas', ordem: 'q', dir: -1 };

  function telaCriterios() {
    const n = D.municipios.length;
    const stat = new Map(D.criterios.map((c) => [c.id, { c, q: 0, ganho: 0 }]));
    for (const m of D.municipios) for (const g of m.grupos) { const s = stat.get(g.id); s.q += 1; s.ganho += g.ganho; }
    const corpo = h('tbody');
    const botoes = h('div', { class: 'filtros', role: 'group', 'aria-label': 'Filtrar por classificação' },
      ['Todas', ...CLASSES].map((c) => h('button', { class: 'filtro', type: 'button', 'data-c': c, onclick: () => { filtroCrit.classe = c; desenha(); } }, c)));

    function desenha() {
      const linhas = [...stat.values()].filter((s) => filtroCrit.classe === 'Todas' || s.c.exig === filtroCrit.classe)
        .sort((a, b) => b.q - a.q || a.c.id.localeCompare(b.c.id, 'pt', { numeric: true }));
      corpo.replaceChildren(...linhas.map((s) => h('tr', {},
        h('td', { class: 'nw' }, s.c.id),
        h('td', {}, s.c.texto),
        h('td', {}, s.c.dim),
        h('td', {}, h('span', { class: 'chip ' + (s.c.exig === 'Essencial' ? 'chip-fatal' : 'chip-alta') }, s.c.exig)),
        h('td', { class: 'tr-num' }, `${s.q} (${NF0.format((s.q / n) * 100)}%)`),
        h('td', { class: 'tr-num' }, s.q ? '+' + NF1.format(s.ganho / s.q) + ' pt' : '–'))));
      for (const b of botoes.querySelectorAll('.filtro')) b.setAttribute('aria-pressed', b.dataset.c === filtroCrit.classe ? 'true' : 'false');
    }
    desenha();
    return h('div', {},
      cabecalho('Módulo · Transparência', 'Critérios', `Quantas das ${n} prefeituras ainda não atendem cada critério (ciclo ${ANO}) e quanto o índice sobe, em média, ao corrigi-lo.`),
      h('div', { class: 'barra-mesa' }, botoes),
      h('div', { class: 'tabela-rolagem' }, h('table', { class: 'tabela' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Critério'), h('th', {}, 'Descrição'), h('th', {}, 'Dimensão'), h('th', {}, 'Classe'), h('th', { class: 'tr-num' }, 'Prefeituras com falha'), h('th', { class: 'tr-num' }, 'Ganho médio'))),
        corpo)));
  }

  // ----- metodologia -----

  function telaMetodologia() {
    const regras = [
      ['Diamante', '95% a 100%', '100% dos essenciais'], ['Ouro', '85% a 94%', '100% dos essenciais'], ['Prata', '75% a 84%', '100% dos essenciais'],
      ['Elevado', 'acima de 75%', 'menos de 100% dos essenciais'], ['Intermediário', '50% a 74%', '–'], ['Básico', '30% a 49%', '–'],
      ['Inicial', '1% a 29%', '–'], ['Inexistente', '0%', 'sem sítio oficial próprio ou fora do ar (critério 1.1)'],
    ];
    const ess = D.criterios.filter((c) => c.exig === 'Essencial');
    const dims = Object.entries(D.pesos.dimensao);
    return h('div', {},
      cabecalho('Módulo · Transparência', 'Como ler este painel'),
      secao('De onde vêm os números', null,
        h('ul', { class: 'lista-seca' }, D.meta.fontes.map((f) => h('li', {}, link(f.url, f.nome + ' ↗')))),
        h('p', { class: 'aviso' }, `Dados do ciclo ${ANO}, gerados em ${D.meta.gerado_em}. Os resultados do ciclo 2026 estão previstos para novembro e serão incorporados quando a Atricon os publicar.`)),
      secao('Níveis de transparência', 'Cartilha PNTP 2026, tabela 3.',
        h('div', { class: 'tabela-rolagem' }, h('table', { class: 'tabela' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Nível'), h('th', {}, 'Índice'), h('th', {}, 'Requisito adicional'))),
          h('tbody', {}, regras.map(([n, i, r]) => h('tr', {}, h('td', {}, chipNivel(n)), h('td', {}, i), h('td', {}, r))))))),
      secao('Itens essenciais', `São os da execução orçamentária e financeira. Sem eles não há selo e, pela Lei de Responsabilidade Fiscal (arts. 48, 48-A e 51), o ente fica impedido de receber transferências voluntárias e de contratar operações de crédito. Lista do ciclo ${ANO}${D.meta.proximo_ciclo ? `; em ${D.meta.proximo_ciclo.ano} são ${D.meta.proximo_ciclo.essenciais.length}: ${D.meta.proximo_ciclo.essenciais.join(', ')}` : ''}.`,
        h('ul', { class: 'lista-seca' }, ess.map((c) => h('li', {}, `${c.id} ${c.texto}`)))),
      secao('Como o índice é calculado', 'Peso da dimensão × peso do critério (essencial 2, obrigatório 1,5, recomendado 1) × peso do item de verificação (disponibilidade 30%, atualidade 30%, série histórica 20%, gravação de relatórios 10%, filtro de pesquisa 10%).',
        h('div', { class: 'tabela-rolagem' }, h('table', { class: 'tabela' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Dimensão'), h('th', { class: 'tr-num' }, 'Peso'))),
          h('tbody', {}, dims.map(([d, p]) => h('tr', {}, h('td', {}, d), h('td', { class: 'tr-num' }, String(p)))))))),
      secao('Limites', null,
        h('ul', { class: 'lista-seca' },
          h('li', {}, 'O resultado oficial é o do Radar da Transparência Pública (Atricon). Este painel o reorganiza e simula; não o substitui.'),
          h('li', {}, 'As projeções reproduzem o índice oficial de ' + ANO + ' com erro médio de 0,01 ponto; ainda assim, são estimativas.'),
          h('li', {}, 'Os critérios são os de ' + ANO + (D.meta.proximo_ciclo ? `. A matriz ${D.meta.proximo_ciclo.ano} tem ${D.meta.proximo_ciclo.criterios} critérios para prefeituras (${D.meta.proximo_ciclo.essenciais.length} essenciais) e pode mudar o resultado.` : '.')),
          h('li', {}, 'Não mede se a informação é verdadeira, completa ou atual hoje; mede o que o tribunal validou na avaliação.'))));
  }

  // ---------- navegação ----------

  const ROTAS = {
    '': telaPanorama,
    municipios: telaLista,
    municipio: telaFicha,
    criterios: telaCriterios,
    metodologia: telaMetodologia,
  };

  function rota() {
    const [nome = '', arg] = location.hash.replace(/^#\/?/, '').split('/');
    const tela = ROTAS[nome] || telaPanorama;
    const app = document.getElementById('tr-app');
    app.replaceChildren(tela(arg));
    for (const a of document.querySelectorAll('.nav-item')) {
      const alvo = a.getAttribute('href').replace(/^#\/?/, '');
      if ((alvo === nome) || (nome === 'municipio' && alvo === 'municipios')) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    const t = document.getElementById('tr-titulo');
    if (t) t.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  // ---------- aparência (Terminal, Claro, Escuro) ----------

  function aparencia() {
    let salva = null;
    try { salva = localStorage.getItem('mm-aparencia'); } catch (_) { /* sem armazenamento: segue o sistema */ }
    const sel = document.getElementById('tr-aparencia');
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
    sel.addEventListener('change', () => {
      aplica(sel.value);
      try { localStorage.setItem('mm-aparencia', sel.value); } catch (_) { /* ignora */ }
    });
  }

  async function inicia() {
    aparencia();
    const app = document.getElementById('tr-app');
    try {
      const r = await fetch('dados/transparencia-to.json');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      prepara(await r.json());
    } catch (e) {
      app.replaceChildren(h('div', { class: 'plain' }, h('h1', {}, 'Não foi possível carregar os dados'), h('p', {}, 'Gere dados/transparencia-to.json com build_dados.py. ' + e.message)));
      return;
    }
    window.addEventListener('hashchange', rota);
    rota();
  }

  inicia();
})();
