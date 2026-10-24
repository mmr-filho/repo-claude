/*
 * Módulo Transparência (PNTP/Atricon): situação de UMA prefeitura e o plano de ação até o selo.
 *
 * Dados (gerados pelas ferramentas da pasta): dados/municipios.json (lista), dados/criterios.json (matriz-alvo
 * com a orientação da Cartilha), dados/m/<ibge>.json (um por município) e, opcionais, dados/siconfi.json
 * (entregas de RREO e RGF ao Tesouro) e dados/sonda.json (verificação automática das capas dos portais).
 * O acompanhamento do plano fica no navegador ou, se <main data-api="..."> for definido, na API do site.
 * Sem dependências: o site exige script-src 'self'. Texto vindo de fora entra só por textContent/value.
 */
(() => {
  'use strict';

  const SELOS = { Prata: 0.75, Ouro: 0.85, Diamante: 0.95 };
  // Itens de verificação, resumidos da Cartilha PNTP 2026 (seção "Itens de verificação")
  const ITEM = {
    D: ['Disponibilidade', 'a informação precisa estar no portal, com todos os dados mínimos que o critério pede'],
    A: ['Atualidade', 'dados recentes (em geral, de até 30 dias) e com a data de atualização à vista; a data automática da página não vale'],
    S: ['Série histórica', 'histórico dos três anos anteriores à avaliação'],
    G: ['Gravação de relatórios', 'permitir baixar em formato editável (planilha, CSV, TXT, DOC); PDF sozinho em geral não basta'],
    F: ['Filtro de pesquisa', 'filtro próprio para refinar a consulta dentro do critério; dispensado se tudo cabe numa página'],
  };
  // Sugestão de setor responsável por dimensão (nomes como na matriz 2026)
  const SETOR = {
    'Informações Prioritárias': 'Comunicação e TI',
    'Informações Institucionais': 'Gabinete e Administração',
    'Receita': 'Finanças e Tributação',
    'Despesa': 'Finanças e Contabilidade',
    'Convênios e Transferências': 'Planejamento e Convênios',
    'Recursos Humanos': 'Administração e RH',
    'Diárias': 'Administração e Finanças',
    'Licitações': 'Licitações e Compras',
    'Contratos': 'Licitações e Compras',
    'Obras': 'Obras e Infraestrutura',
    'Planejamento e Prestação de contas': 'Planejamento, Contabilidade e Controle Interno',
    'Serviço de Informação ao Cidadão - SIC': 'Controle Interno e Ouvidoria',
    'Acessibilidade': 'Comunicação e TI',
    'Ouvidorias': 'Ouvidoria',
    'Lei Geral de Proteção de Dados (LGPD) e Governo Digital': 'TI e Jurídico',
    'Renúncias de Receitas': 'Finanças e Tributação',
    'Emendas Parlamentares': 'Planejamento e Finanças',
    'Saúde': 'Secretaria de Saúde',
    'Educação e Assistência Social': 'Educação e Assistência Social',
  };
  const SITUACOES = { pendente: 'Pendente', andamento: 'Em andamento', concluida: 'Concluída' };
  // O que a sonda procura na capa, e o critério a que se refere
  const SINAIS = [
    ['transparencia', 'Link para o portal da transparência', '1.3'],
    ['radar', 'Botão do Radar da Transparência', '2.9'],
    ['sic', 'Acesso ao SIC (pedido de informação)', '12'],
    ['ouvidoria', 'Ouvidoria', '14'],
    ['lgpd', 'Proteção de dados (LGPD)', '15'],
    ['acessibilidade', 'Recursos de acessibilidade', '13'],
  ];

  // ---------- utilidades ----------

  function h(tag, attrs, ...filhos) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'value') e.value = v;
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

  const NF0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  const NF1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const pct = (x) => (x == null ? '–' : NF1.format(x * 100) + '%');
  const pts = (x) => NF1.format(x) + (Math.abs(x) < 1.95 ? ' ponto' : ' pontos'); // em português, plural a partir de 2
  const urlSegura = (u) => (/^https?:\/\/\S+$/i.test(u || '') ? u : null);
  const semAcento = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const dataBr = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');
  const hojeIso = () => new Date().toISOString().slice(0, 10);
  const soma = (xs) => xs.reduce((s, a) => s + a.ganho, 0);
  const porGanho = (a, b) => b.ganho - a.ganho || a.id.localeCompare(b.id, 'pt', { numeric: true });
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const nomeArquivo = (s) => semAcento(s).replace(/[^a-z0-9]+/g, '-');

  function link(url, texto) {
    const u = urlSegura(url);
    return u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, texto) : null;
  }

  function baixa(nome, tipo, texto) {
    const url = URL.createObjectURL(new Blob([texto], { type: tipo }));
    const el = h('a', { href: url, download: nome });
    document.body.append(el); el.click(); el.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const guarda = {
    le(k, padrao) { try { const v = localStorage.getItem(k); return v == null ? padrao : JSON.parse(v); } catch (_) { return padrao; } },
    grava(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
  };

  /** Regras da Cartilha PNTP 2026 (tabela 3): selo exige 100% dos essenciais. */
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

  const chipNivel = (n) => h('span', { class: 'chip tr-nivel', 'data-n': n }, n);
  const chipClasse = (c) => h('span', { class: 'chip ' + (c === 'Essencial' ? 'chip-fatal' : c === 'Obrigatória' ? 'chip-alta' : '') }, c);

  // ---------- dados ----------

  let IDX, CAT, CATMETA;
  const cache = new Map();

  async function json(url) {
    if (!cache.has(url)) {
      const p = fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); });
      p.catch(() => cache.delete(url)); // falhou: deixa tentar de novo na próxima navegação
      cache.set(url, p);
    }
    return cache.get(url);
  }

  const opcional = (url) => json(url).catch(() => null);

  async function catalogo() {
    if (!CAT) {
      CATMETA = await json('dados/criterios.json');
      CAT = new Map(CATMETA.criterios.map((x) => [x.id, x]));
    }
    return CAT;
  }

  /** Ações do município: cada critério da matriz-alvo que não atende (ou que não foi avaliado no ciclo das respostas). */
  function deriva(m) {
    if (m._d) return m._d;
    const acoes = (m.pendencias || []).map((p) => {
      const c = CAT.get(p.id);
      return { ...p, c, novo: p.itens.every((x) => x[1] == null), essencial: c.classe === 'Essencial', setor: SETOR[c.dim] || 'A definir' };
    });
    m._d = { acoes, base: m.estimativa, essPend: acoes.filter((a) => a.essencial), incerto: soma(acoes.filter((a) => a.novo)) };
    return m._d;
  }

  /** Plano por etapas para uma meta: essenciais, o menor caminho até a meta, critérios novos a conferir, o resto. */
  function monta(m, meta) {
    const { acoes, base } = deriva(m);
    const alvo = SELOS[meta];
    const ess = acoes.filter((a) => a.essencial).sort(porGanho);
    let x = base + soma(ess) / 100;
    const caminho = [];
    const tenta = (lista) => { for (const a of lista) { if (x >= alvo - 1e-9) break; caminho.push(a); x += a.ganho / 100; } };
    tenta(acoes.filter((a) => !a.essencial && !a.novo).sort(porGanho));
    tenta(acoes.filter((a) => !a.essencial && a.novo).sort(porGanho)); // só se ainda faltar
    const usados = new Set([...ess, ...caminho].map((a) => a.id));
    return {
      alcanca: x >= alvo - 1e-9,
      projetado: Math.min(x, 1),
      usados,
      caminho: ess.length + caminho.length,
      etapas: [
        { titulo: 'Itens essenciais', acoes: ess,
          nota: 'Sem eles não há selo, qualquer que seja o índice. E, pela Lei de Responsabilidade Fiscal (arts. 48, 48-A e 51), sem essas informações o município fica impedido de receber transferências voluntárias e de contratar operações de crédito.' },
        { titulo: `Para chegar ao ${meta}`, acoes: caminho,
          nota: `Os critérios que mais sobem o índice, na ordem, até ${NF0.format(alvo * 100)}%.` },
        { titulo: 'Conferir os critérios novos', acoes: acoes.filter((a) => a.novo && !usados.has(a.id)).sort(porGanho),
          nota: `Entraram na matriz ${CATMETA.ano} e não foram avaliados em ${IDX.meta.ciclo_respostas}. A estimativa os conta como pendentes; se o portal já atende, marque como concluído.` },
        { titulo: 'Demais pendências', acoes: acoes.filter((a) => !a.novo && !usados.has(a.id)).sort(porGanho),
          nota: 'Margem de segurança: a validação do tribunal e a revisão da Atricon costumam derrubar alguns itens.' },
      ],
    };
  }

  /** Etapas com ações, numeradas na ordem em que aparecem. */
  const etapasVisiveis = (plano) => plano.etapas.filter((e) => e.acoes.length).map((e, i) => ({ ...e, titulo: `Etapa ${i + 1} · ${e.titulo}` }));

  function fraseMeta(plano, meta) {
    if (!plano.caminho) return plano.alcanca ? `A estimativa já está no nível da meta (${meta}).` : '';
    return plano.alcanca
      ? `Para o ${meta}: ${plural(plano.caminho, 'ação leva', 'ações levam')} a estimativa a ${pct(plano.projetado)}.`
      : `Mesmo com ${plural(plano.caminho, 'ação', 'ações')} de essenciais e de maior ganho, a estimativa fica em ${pct(plano.projetado)}: o ${meta} depende também das demais pendências.`;
  }

  /** Índice e nível estimados se as ações do conjunto forem concluídas. */
  function projeta(m, feitas) {
    const d = deriva(m);
    let x = d.base;
    for (const a of d.acoes) if (feitas.has(a.id)) x += a.ganho / 100;
    const falta = d.essPend.filter((a) => !feitas.has(a.id)).length;
    x = Math.min(x, 1);
    return { x, falta, nivel: classifica(x, falta === 0) };
  }

  function veredito(m) {
    const ano = String(IDX.meta.ciclo_atual);
    const o = m.ciclos[ano];
    const { essPend, base, incerto } = deriva(m);
    if (!o || o.i == null) return `Sem avaliação válida em ${ano}.`;
    const frases = [];
    if (o.n === 'Diamante') frases.push(`A prefeitura tem o Selo Diamante, o nível máximo do programa (índice ${pct(o.i)} em ${ano}).`);
    else if (o.n === 'Ouro' || o.n === 'Prata') frases.push(`A prefeitura tem o Selo ${o.n} (índice ${pct(o.i)} em ${ano}). Para o Diamante faltaram ${pts((0.95 - o.i) * 100)}.`);
    else if (o.n === 'Elevado') frases.push(`O índice é alto (${pct(o.i)} em ${ano}), mas a prefeitura ficou sem selo porque há item essencial não atendido.`);
    else frases.push(`A prefeitura ficou no nível ${o.n} (índice ${pct(o.i)} em ${ano}), sem selo. O primeiro selo, Prata, exige 75% e todos os itens essenciais.`);
    if (essPend.length) frases.push(`Pelas regras de ${CATMETA.ano}, ${plural(essPend.length, 'critério essencial está pendente', 'critérios essenciais estão pendentes')}: é a primeira providência.`);
    if (base != null) {
      frases.push(`Nas regras de ${CATMETA.ano}, a estimativa é de ${pct(base)}` + (incerto > 0.05 ? `, contando como pendentes ${pts(incerto)} de critérios novos ainda não avaliados.` : '.'));
      const piso = SELOS[o.n];
      if (piso && base < piso - 1e-9) {
        frases.push(base + incerto >= piso - 1e-9
          ? `Isso fica abaixo dos ${NF0.format(piso * 100)}% do ${o.n}: publicar o que os critérios novos pedem é o que garante o selo.`
          : `Isso fica abaixo dos ${NF0.format(piso * 100)}% do ${o.n}: o plano de ação mostra o que corrigir para manter o selo.`);
      }
    }
    return frases.join(' ');
  }

  // ---------- acompanhamento do plano ----------
  // Estado: { versao: 1, acoes: { <critério>: { s: situação, resp, prazo: 'AAAA-MM-DD', evid: URL, em: ISO } } }
  // Sem data-api, fica no navegador (localStorage). Com data-api="/caminho", GET e PUT em /caminho/<ibge>,
  // na mesma origem e com a sessão do site (o servidor decide quem pode editar cada prefeitura).

  const acomp = {
    api: () => document.getElementById('tr-app').dataset.api || '',
    normaliza(x, ids) {
      const out = { versao: 1, acoes: {} };
      const ac = x && typeof x === 'object' && x.acoes && typeof x.acoes === 'object' ? x.acoes : {};
      const texto = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
      for (const [id, v] of Object.entries(ac)) {
        if (!ids.has(id) || !v || typeof v !== 'object') continue;
        out.acoes[id] = {
          s: SITUACOES[v.s] ? v.s : 'pendente',
          resp: texto(v.resp, 120),
          prazo: /^\d{4}-\d{2}-\d{2}$/.test(v.prazo || '') ? v.prazo : '',
          evid: texto(v.evid, 500),
          em: texto(v.em, 30),
        };
      }
      return out;
    },
    async le(ibge, ids) {
      const api = this.api();
      if (api) {
        const r = await fetch(`${api}/${ibge}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (r.status === 404) return { estado: this.normaliza(null, ids), onde: 'servidor' };
        if (!r.ok) throw new Error(`acompanhamento: HTTP ${r.status}`);
        return { estado: this.normaliza(await r.json(), ids), onde: 'servidor' };
      }
      let x = guarda.le(`tr-acomp-${ibge}`, null);
      const antigo = x ? null : guarda.le(`tr-plano-${ibge}`, null); // versão anterior: lista de concluídas
      if (Array.isArray(antigo)) x = { acoes: Object.fromEntries(antigo.map((id) => [id, { s: 'concluida' }])) };
      return { estado: this.normaliza(x, ids), onde: 'navegador' };
    },
    async grava(ibge, estado) {
      const api = this.api();
      if (api) {
        const r = await fetch(`${api}/${ibge}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(estado) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return;
      }
      if (!guarda.grava(`tr-acomp-${ibge}`, estado)) throw new Error('o navegador não permitiu gravar');
    },
  };

  const situacao = (estado, id) => (estado.acoes[id] && estado.acoes[id].s) || 'pendente';
  const concluidas = (estado) => new Set(Object.entries(estado.acoes).filter(([, v]) => v.s === 'concluida').map(([id]) => id));
  const atrasada = (v) => v && v.prazo && v.s !== 'concluida' && v.prazo < hojeIso();

  // ---------- verificações (Siconfi e sonda) ----------

  const RELATORIO = { rreo: 'RREO', rgf: 'RGF' };
  const CRITERIO_RELATORIO = { '11.5': 'rgf', '11.6': 'rreo' };

  function ultimoRelatorio(sic, tipo) {
    const l = (sic && sic[tipo]) || [];
    return l.length ? l[l.length - 1] : null;
  }

  const anosSiconfi = (ext) => (ext.siconfi && ext.siconfi.anos ? ext.siconfi.anos.join(' e ') : 'na consulta');

  function descreveRelatorio(e, tipo) {
    const periodo = tipo === 'rreo' ? 'bimestre' : e.periodicidade === 'S' ? 'semestre' : 'quadrimestre';
    return `${RELATORIO[tipo]}${e.simplificado ? ' simplificado' : ''} do ${e.periodo}º ${periodo} de ${e.ano} (registro em ${dataBr(e.data)})`;
  }

  /** "Último RREO …" ou "Nenhum RREO registrado em …". */
  function fraseRelatorio(sic, tipo, ext) {
    const e = ultimoRelatorio(sic, tipo);
    return e ? `Último ${descreveRelatorio(e, tipo)}` : `Nenhum ${RELATORIO[tipo]} registrado em ${anosSiconfi(ext)}`;
  }

  /** Frase sobre o site, a partir da sonda; positivo é confiável, "não encontrado" não indica falha. */
  function situacaoSite(s) {
    if (!s) return null;
    if (!s.status && /^HTTP \d+$/.test(s.erro || '')) s = { ...s, status: Number(s.erro.slice(5)) }; // sonda antiga
    if (s.status && s.status < 400) return { tom: 'ok', texto: `O site respondeu em ${NF1.format(s.tempo)} s${s.https ? ', com HTTPS' : ', sem HTTPS'}.` };
    if (s.status === 404) return { tom: 'erro', texto: 'O endereço do portal registrado na avaliação respondeu "página não encontrada" (404). Confira o endereço informado ao tribunal: site fora do ar ou endereço errado na avaliação zera o índice (critério 1.1).' };
    if (s.status) return { tom: 'neutro', texto: `O servidor recusou a verificação automática (HTTP ${s.status}). Isso não indica que o site esteja fora do ar.` };
    if (s.erro === 'robots.txt não permite') return { tom: 'neutro', texto: 'O site pede para não ser visitado por robôs; a verificação automática respeitou o pedido.' };
    return { tom: 'alerta', texto: `Não foi possível acessar o site na verificação automática (${s.erro}). Confira se está no ar: site fora do ar na avaliação zera o índice (critério 1.1).` };
  }

  /** Dicas para um cartão do plano, a partir das verificações. */
  function dicas(a, ext) {
    const out = [];
    const tipo = CRITERIO_RELATORIO[a.id];
    if (tipo && ext.siconfi) {
      const e = ultimoRelatorio(ext.siconfi.municipios[String(ext.ibge)], tipo);
      out.push(e
        ? `No Siconfi (Tesouro), o último ${descreveRelatorio(e, tipo)}. O mesmo relatório, com os anexos, precisa estar no portal.`
        : `No Siconfi (Tesouro) não há ${RELATORIO[tipo]} registrado em ${anosSiconfi(ext)}. Vale conferir com a contabilidade se os relatórios foram enviados ao Tesouro; no portal, eles precisam estar completos, com os anexos.`);
    }
    const s = ext.sonda && ext.sonda.municipios[String(ext.ibge)];
    for (const [k, nome, crit] of SINAIS) {
      if (crit === a.id && s && s.sinais && s.sinais[k]) {
        out.push(`A verificação automática de ${dataBr(ext.sonda.verificado_em)} encontrou na capa: ${nome.toLowerCase()}. Confira se atende ao critério e atualize a situação.`);
      }
    }
    return out;
  }

  // ---------- peças de interface ----------

  function cabecalho(kicker, titulo, sub) {
    return h('div', { class: 'mesa-head' },
      h('div', {},
        h('div', { class: 'kicker' }, kicker),
        h('h1', { class: 'mesa-titulo', tabindex: '-1', id: 'tr-titulo' }, titulo),
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

  const tomNivel = (n) => (n === 'Diamante' || n === 'Ouro' || n === 'Prata' ? 't-ok' : n === 'Elevado' || n === 'Intermediário' ? 't-alerta' : 't-perigo');

  function barra(valor, rotulo, comMarcas) {
    const fio = h('span', { class: 'est-placar-fio' });
    fio.style.width = Math.max(0, Math.min(1, valor ?? 0)) * 100 + '%';
    const trilho = h('span', { class: 'est-placar-trilho', role: 'img', 'aria-label': `${rotulo}: ${pct(valor)}. Prata a partir de 75%, Ouro de 85%, Diamante de 95%.` }, fio,
      Object.entries(SELOS).map(([nome, v]) => {
        const marca = h('span', { class: 'est-placar-marca tr-marca', 'data-selo': nome }, comMarcas ? h('span', {}, nome) : null);
        marca.style.left = v * 100 + '%';
        return marca;
      }));
    return h('div', { class: 'est-placar-linha' }, h('span', { class: 'est-placar-rot' }, rotulo), trilho, h('span', { class: 'est-placar-n' }, pct(valor)));
  }

  function serie(m) {
    const anos = IDX.meta.ciclos.map(String);
    const L = 560, A = 210, ex = 46, ey = 22, base = A - 30, folga = 44;
    const xs = (i) => ex + folga + (i * (L - 2 * ex - 2 * folga)) / Math.max(anos.length - 1, 1);
    const ys = (v) => ey + (1 - v) * (base - ey);
    const p = anos.map((a, i) => (m.ciclos[a] && m.ciclos[a].i != null ? [xs(i), ys(m.ciclos[a].i), m.ciclos[a]] : null));
    const d = p.filter(Boolean).map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join(' ');
    const desc = anos.map((a) => `${a}: ${m.ciclos[a] ? pct(m.ciclos[a].i) + ' (' + m.ciclos[a].n + ')' : 'sem avaliação'}`).join('; ');
    return h('div', { class: 'est-serie' }, sv('svg', { viewBox: `0 0 ${L} ${A}`, role: 'img', 'aria-label': 'Índice por ciclo. ' + desc },
      [0, 0.25, 0.5, 0.75, 1].map((v) => sv('g', {},
        sv('line', { class: 'est-grade', x1: ex, x2: L - ex, y1: ys(v), y2: ys(v) }),
        sv('text', { class: 'est-eixo', x: ex - 8, y: ys(v) + 4, 'text-anchor': 'end' }, `${v * 100}%`))),
      sv('line', { class: 'est-meta-linha', x1: ex, x2: L - ex, y1: ys(0.95), y2: ys(0.95) }),
      sv('text', { class: 'est-meta-txt', x: ex + 6, y: ys(0.95) - 6, 'text-anchor': 'start' }, 'Diamante 95%'),
      d ? sv('path', { class: 'est-linha', d }) : null,
      p.map((q, i) => sv('g', {},
        q ? sv('circle', { class: 'est-ponto', cx: q[0], cy: q[1], r: 4.5 }) : null,
        q ? sv('text', { class: 'est-valor', x: q[0], y: q[1] - 11, 'text-anchor': 'middle' }, pct(q[2].i)) : null,
        sv('text', { class: 'est-eixo', x: xs(i), y: A - 8, 'text-anchor': 'middle' }, anos[i])))));
  }

  function tabelaCiclos(ciclos) {
    const anos = IDX.meta.ciclos.map(String).filter((a) => ciclos[a]);
    return h('div', { class: 'tabela-rolagem' }, h('table', { class: 'tabela' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Ciclo'), h('th', { scope: 'col' }, 'Nível'), h('th', { scope: 'col', class: 'tr-num' }, 'Índice'), h('th', { scope: 'col', class: 'tr-num' }, 'Essenciais'))),
      h('tbody', {}, anos.map((a) => h('tr', {}, h('td', {}, a), h('td', {}, chipNivel(ciclos[a].n)), h('td', { class: 'tr-num' }, pct(ciclos[a].i)), h('td', { class: 'tr-num' }, pct(ciclos[a].e)))))));
  }

  const rotuloFalta = (it) => it.map(([cod, falhando, total]) => ITEM[cod][0] + (falhando == null ? ' (não avaliado antes)' : total > 1 ? ` (${falhando} de ${total} verificações)` : '')).join(', ');
  const rotuloFaltaCurto = (a) => (a.novo ? 'Conferir: ' : 'Falta: ') + rotuloFalta(a.itens).replace(/ \(não avaliado antes\)/g, '');

  const paginaCartilha = (c) => (CATMETA.cartilha_url && c.pagina ? `${CATMETA.cartilha_url}#page=${c.pagina}` : null);

  function orientacao(c, itensEmFalta) {
    if (!c.orientacao.length && !c.fund) return null;
    const falta = new Set(itensEmFalta.map((x) => ITEM[x][0].toLowerCase()));
    return h('details', { class: 'tr-cartilha' },
      h('summary', {}, 'O que a Cartilha exige'),
      c.fund ? h('p', { class: 'aviso' }, h('strong', {}, 'Fundamentação: '), c.fund) : null,
      c.orientacao.map(([rot, txt]) => h('p', { class: rot && falta.has(rot.toLowerCase()) ? 'tr-em-falta' : '' }, rot ? h('strong', {}, rot + ': ') : null, txt)),
      h('ul', { class: 'tr-itens-def' }, c.itens.map((i) => h('li', {}, h('strong', {}, ITEM[i][0]), ': ', ITEM[i][1], '.'))));
  }

  /** Controles de acompanhamento de uma ação (situação, responsável, prazo, evidência). */
  function controlesAcomp(a, ctl, aoMudar) {
    const v = ctl.estado.acoes[a.id] || { s: 'pendente', resp: '', prazo: '', evid: '' };
    const id = (k) => `tr-${k}-${a.id.replace('.', '-')}`;
    const abrir = h('span', { class: 'tr-evid-link' });
    const mostraLink = (u) => abrir.replaceChildren(...[link(u, 'abrir ↗')].filter(Boolean));
    mostraLink(v.evid);
    const campo = (k, rotulo, el) => h('div', { class: 'tr-campo' }, h('label', { for: id(k) }, rotulo), el);
    const sel = h('select', { id: id('s'), class: 'est-filtro-sel', onchange: (e) => { ctl.muda(a.id, { s: e.target.value }); aoMudar(); } },
      Object.entries(SITUACOES).map(([k, t]) => h('option', { value: k, selected: v.s === k }, t)));
    return h('div', { class: 'tr-acomp' },
      campo('s', 'Situação', sel),
      campo('resp', 'Responsável', h('input', { id: id('resp'), class: 'est-filtro-input', type: 'text', maxlength: '120', placeholder: 'Nome ou setor', value: v.resp, oninput: (e) => ctl.muda(a.id, { resp: e.target.value }, true) })),
      campo('prazo', 'Prazo', h('input', { id: id('prazo'), class: 'est-filtro-input', type: 'date', value: v.prazo, onchange: (e) => { ctl.muda(a.id, { prazo: e.target.value }); aoMudar(); } })),
      campo('evid', 'Evidência', h('span', { class: 'tr-evid' },
        h('input', { id: id('evid'), class: 'est-filtro-input', type: 'url', maxlength: '500', placeholder: 'Link da página corrigida', value: v.evid, oninput: (e) => { ctl.muda(a.id, { evid: e.target.value }, true); mostraLink(e.target.value.trim()); } }),
        abrir)));
  }

  /** Cartão de uma ação do plano. `ctl` (opcional) liga o acompanhamento. */
  function cartaoAcao(a, ext, ctl) {
    const c = a.c;
    const el = h('article', { class: 'est-req tr-acao' });
    const atraso = h('span', { class: 'chip chip-fatal', hidden: true }, 'Atrasada');
    const estiliza = () => {
      const v = ctl && ctl.estado.acoes[a.id];
      const s = v ? v.s : 'pendente';
      el.className = 'est-req tr-acao ' + (s === 'concluida' ? 'est-cumprido' : s === 'andamento' ? 'est-andamento' : a.essencial ? 'est-nao' : '');
      atraso.hidden = !atrasada(v);
    };
    el.append(...[
      h('div', { class: 'tr-acao-topo' },
        chipClasse(c.classe),
        h('span', { class: 'chip' }, a.setor),
        a.novo ? h('span', { class: 'chip tr-chip-novo' }, `Novo em ${CATMETA.ano}`) : null,
        c.classe_antes && c.classe_antes !== c.classe ? h('span', { class: 'chip tr-chip-novo', title: `Em ${IDX.meta.ciclo_respostas} era ${c.classe_antes}` }, `Era ${c.classe_antes.toLowerCase()}`) : null,
        atraso,
        h('span', { class: 'tr-ganho' }, '+' + pts(a.ganho))),
      h('h3', { class: 'est-req-titulo' }, `${c.id} ${c.texto}`),
      h('p', { class: 'item-meta' }, h('strong', {}, 'O que falta: '), a.novo ? `conferir se o portal já atende (${rotuloFalta(a.itens).replace(/ \(não avaliado antes\)/g, '')})` : rotuloFalta(a.itens)),
      dicas(a, ext).map((t) => h('p', { class: 'tr-dica' }, t)),
      a.nota ? h('blockquote', { class: 'tr-nota' }, h('span', { class: 'kicker' }, `Observação do tribunal (${IDX.meta.ciclo_respostas})`), h('p', {}, a.nota)) : null,
      h('div', { class: 'tr-links' },
        link(a.link, 'Página avaliada ↗'),
        link(a.print, 'Print do avaliador ↗'),
        link(paginaCartilha(c), `Cartilha, p. ${c.pagina} ↗`)),
      orientacao(c, a.itens.map((x) => x[0])),
      ctl ? controlesAcomp(a, ctl, estiliza) : null].flat().filter(Boolean)); // append() não achata listas e escreveria "null"
    estiliza();
    return el;
  }

  // ---------- telas ----------

  function telaEscolha() {
    const ultimo = guarda.le('tr-municipio', null);
    const lista = h('ul', { class: 'lista tr-escolha' });
    const desenha = (q) => {
      const k = semAcento(q.trim());
      const ms = IDX.municipios.filter((m) => !k || semAcento(m.nome).includes(k));
      lista.replaceChildren(...ms.map((m) => h('li', { class: 'item' },
        h('a', { href: `#/m/${m.ibge}`, class: 'tr-escolha-link' }, h('span', { class: 'tr-escolha-nome' }, m.nome), m.n ? chipNivel(m.n) : null))));
      if (!ms.length) lista.append(h('li', { class: 'item nada' }, 'Nenhum município com esse nome.'));
    };
    const busca = h('input', { type: 'search', placeholder: 'Digite o nome do município', 'aria-label': 'Buscar município', oninput: (e) => desenha(e.target.value) });
    desenha('');
    const anterior = ultimo && IDX.municipios.find((m) => m.ibge === ultimo);
    return h('div', {},
      cabecalho('Transparência municipal · Tocantins', 'Escolha o município',
        'Situação da prefeitura no Programa Nacional de Transparência Pública (Atricon) e o plano de ação para chegar ao selo.'),
      anterior ? h('p', {}, h('a', { class: 'btn btn-inline', href: `#/m/${anterior.ibge}` }, `Continuar com ${anterior.nome} →`)) : null,
      h('div', { class: 'busca tr-busca' }, busca),
      lista);
  }

  function blocoVerificacoes(m, ext) {
    const s = ext.sonda && ext.sonda.municipios[String(m.ibge)];
    const sic = ext.siconfi && ext.siconfi.municipios[String(m.ibge)];
    if (!s && !sic) return null;
    const site = situacaoSite(s);
    return secao('Verificações recentes', 'Conferências automáticas, feitas depois da avaliação de ' + IDX.meta.ciclo_respostas + '. Servem de pista; não substituem a avaliação do tribunal.',
      h('div', { class: 'tr-verif' },
        s ? h('div', { class: 'painel' },
          h('p', { class: 'kicker' }, `Portal · verificação automática em ${dataBr(ext.sonda.verificado_em)}`),
          h('p', { class: 'tr-site', 'data-tom': site.tom }, site.texto),
          s.sinais ? h('ul', { class: 'tr-sinais' }, SINAIS.map(([k, nome]) => h('li', { 'data-ok': s.sinais[k] ? 'sim' : 'nao' },
            h('span', { class: 'tr-marca-sinal', 'aria-hidden': 'true' }, s.sinais[k] ? '✓' : '·'), nome, s.sinais[k] ? '' : ' — não encontrado na capa'))) : null,
          s.sinais ? h('p', { class: 'aviso' }, 'A verificação lê só a página inicial. O que ela encontra o tribunal costuma confirmar; o que ela não encontra pode estar em outra página.' + (s.leitura === 'codigo' ? ' Esta capa é montada por script: leitura aproximada.' : '')) : null) : null,
        sic ? h('div', { class: 'painel' },
          h('p', { class: 'kicker' }, `Relatórios fiscais no Tesouro (Siconfi) · consulta em ${dataBr(ext.siconfi.consultado_em)}`),
          h('ul', { class: 'lista-seca' },
            h('li', {}, fraseRelatorio(sic, 'rreo', ext) + '.'),
            h('li', {}, fraseRelatorio(sic, 'rgf', ext) + '.')),
          !ultimoRelatorio(sic, 'rreo') || !ultimoRelatorio(sic, 'rgf') ? h('p', { class: 'tr-site', 'data-tom': 'alerta' }, 'Sem registro no Tesouro: vale conferir com a contabilidade se os relatórios foram enviados.') : null,
          h('p', { class: 'aviso' }, 'Os mesmos relatórios precisam estar no portal, com os anexos, atualizados e com três anos de histórico: são os critérios essenciais 11.5 (RGF) e 11.6 (RREO).')) : null));
  }

  function telaPanorama(m, ext, ac) {
    const ano = String(IDX.meta.ciclo_atual);
    const o = m.ciclos[ano] || {};
    const d = deriva(m);
    const alteradas = d.acoes.filter((a) => !a.novo && a.c.classe_antes && a.c.classe_antes !== a.c.classe);
    const novos = d.acoes.filter((a) => a.novo);
    const perdas = m.dimensoes.map(([dim, ob, mx]) => ({ dim, ob, mx, perda: mx - ob })).filter((x) => x.perda > 0.05).sort((a, b) => b.perda - a.perda);
    const completas = m.dimensoes.length - perdas.length;
    const feitas = new Set([...concluidas(ac.estado)].filter((id) => d.acoes.some((a) => a.id === id)));

    return h('div', {},
      cabecalho('Prefeitura · ' + [m.pop ? NF0.format(m.pop) + ' habitantes' : null, 'TO'].filter(Boolean).join(' · '), m.nome,
        ['Código IBGE ' + m.ibge, m.cnpj ? 'CNPJ ' + m.cnpj : null].filter(Boolean).join(' · ')),
      h('div', { class: 'painel tr-veredito' },
        h('div', { class: 'est-selo' }, chipNivel(o.n || 'Não Avaliado'), h('strong', {}, pct(o.i)), h('span', { class: 'tr-sub' }, `resultado oficial ${ano}`), link(m.portal, 'Portal da prefeitura ↗')),
        h('p', {}, veredito(m))),
      h('div', { class: 'kpis' },
        kpi(pct(o.i), `Índice oficial ${ano}`, tomNivel(o.n)),
        kpi(pct(o.e), `Itens essenciais atendidos (${ano})`, o.e === 1 ? 't-ok' : 't-perigo'),
        kpi(pct(d.base), `Estimativa nas regras de ${CATMETA.ano}`, 't-fraco'),
        kpi(`${feitas.size}/${d.acoes.length}`, 'Ações do plano concluídas', d.acoes.length && feitas.size === d.acoes.length ? 't-ok' : 't-alerta')),
      h('div', { class: 'tr-espaco' }),
      h('div', { class: 'est-placar' },
        barra(o.i, `Índice oficial ${ano}`, true),
        barra(d.base, `Estimativa ${CATMETA.ano}`),
        feitas.size ? barra(projeta(m, feitas).x, 'Com o que já foi concluído') : null),
      d.essPend.length ? h('div', { class: 'alerta-fatal tr-alerta' },
        h('p', { class: 'kicker' }, plural(d.essPend.length, 'item essencial pendente', 'itens essenciais pendentes')),
        h('ul', { class: 'lista-seca' }, d.essPend.map((a) => h('li', {}, `${a.id} ${a.c.texto}`, feitas.has(a.id) ? ' (marcado como concluído)' : ''))),
        h('p', { class: 'aviso' }, 'Sem eles não há selo. A Lei de Responsabilidade Fiscal (arts. 48, 48-A e 51) também impede o município de receber transferências voluntárias e contratar operações de crédito enquanto não divulgar essas informações.')) : null,
      alteradas.length || novos.length ? h('div', { class: 'painel tr-aviso' },
        h('p', { class: 'kicker' }, `O que muda em ${CATMETA.ano} para esta prefeitura`),
        h('ul', { class: 'lista-seca' },
          alteradas.map((a) => h('li', {}, `${a.id} ${a.c.texto} — era ${a.c.classe_antes.toLowerCase()}, passa a ${a.c.classe.toLowerCase()}, e ainda está pendente.`)),
          novos.length ? h('li', {}, `${plural(novos.length, 'critério novo', 'critérios novos')} a conferir: ${novos.map((a) => a.id).join(', ')}.`) : null)) : null,
      h('p', { class: 'form-acoes' },
        h('a', { class: 'btn btn-inline', href: `#/m/${m.ibge}/plano` }, 'Ver o plano de ação →'),
        h('a', { class: 'botao-texto', href: `#/m/${m.ibge}/relatorio` }, 'Relatório para imprimir')),
      blocoVerificacoes(m, ext),
      secao('Onde a prefeitura perde pontos', `Por dimensão, nas regras de ${CATMETA.ano}: quanto do peso de cada uma está garantido. ${plural(completas, 'dimensão está completa', 'dimensões estão completas')}.`,
        perdas.length ? h('ul', { class: 'rel-barras tr-barras' }, perdas.map((x) => {
          const fio = h('span', { class: 'rb-fio ' + (x.ob / x.mx >= 0.95 ? 't-ok' : x.ob / x.mx >= 0.75 ? 't-alerta' : 't-perigo') });
          fio.style.width = (x.ob / x.mx) * 100 + '%';
          return h('li', {}, h('span', { class: 'rb-rot', title: x.dim }, x.dim), h('span', { class: 'rb-trilho' }, fio),
            h('span', { class: 'rb-val', title: `perde ${pts(x.perda)} do índice` }, pct(x.ob / x.mx), h('span', { class: 'rb-nota' }, `−${NF1.format(x.perda)}`)));
        })) : h('p', { class: 'nada' }, 'Nenhuma perda de pontos nas respostas avaliadas.')),
      secao('Histórico', null, serie(m), tabelaCiclos(m.ciclos)),
      secao('Próximos passos', 'Calendário provável, com base no ciclo 2026. As correções feitas agora contam para o próximo ciclo.',
        h('ol', { class: 'tr-passos' },
          h('li', {}, h('strong', {}, 'Novembro de 2026: '), 'a Atricon divulga o resultado do ciclo 2026, cuja autoavaliação já foi feita (abril e maio).'),
          h('li', {}, h('strong', {}, 'Agora até março de 2027: '), 'corrigir o portal seguindo o plano de ação, começando pelos essenciais.'),
          h('li', {}, h('strong', {}, 'Por volta de março de 2027: '), 'sai a matriz do novo ciclo; conferir se algum critério mudou.'),
          h('li', {}, h('strong', {}, 'Abril e maio de 2027: '), 'o controle interno faz a autoavaliação no sistema Avalia, com link de evidência para cada item.'),
          h('li', {}, h('strong', {}, 'Junho a outubro de 2027: '), 'validação pelo TCE-TO e revisão amostral da Atricon; resultado no fim do ano.'))),
      blocoCamara(m));
  }

  function blocoCamara(m) {
    const c = m.camara;
    if (!c || !Object.keys(c.ciclos).length) return null;
    return secao('Câmara Municipal', 'Avaliada à parte pelo PNTP, com matriz própria. O selo da prefeitura não depende dela.',
      tabelaCiclos(c.ciclos), c.portal ? h('p', { class: 'aviso' }, link(c.portal, 'Portal da Câmara ↗')) : null);
  }

  function telaPlano(m, ext, ac) {
    let meta = guarda.le('tr-meta', 'Diamante');
    if (!SELOS[meta]) meta = 'Diamante';
    let agrupar = guarda.le('tr-agrupar', 'etapa');
    const d = deriva(m);
    const ids = new Set(d.acoes.map((a) => a.id));
    const resumo = h('div', { 'aria-live': 'polite' });
    const salvo = h('p', { class: 'aviso tr-salvo', 'aria-live': 'polite' });
    const corpo = h('div');
    let pendente = null;

    const onde = () => (ac.onde === 'servidor' ? 'no servidor do site' : 'neste navegador');
    const mostraSalvo = (txt, erro) => { salvo.textContent = txt; salvo.classList.toggle('tr-erro', !!erro); };
    async function salva() {
      pendente = null;
      try {
        await acomp.grava(m.ibge, ac.estado);
        mostraSalvo(`Acompanhamento salvo ${onde()} às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.`);
      } catch (e) {
        mostraSalvo(`Não foi possível salvar o acompanhamento: ${e.message}`, true);
      }
    }
    const ctl = {
      estado: ac.estado,
      muda(id, campos, devagar) {
        const atual = ac.estado.acoes[id] || { s: 'pendente', resp: '', prazo: '', evid: '' };
        ac.estado.acoes[id] = { ...atual, ...campos, em: new Date().toISOString() };
        clearTimeout(pendente);
        if (devagar) pendente = setTimeout(salva, 600); // texto: grava quando a digitação para
        else salva();
        desenhaResumo();
      },
    };

    function desenhaResumo() {
      const alvo = SELOS[meta];
      const feitas = new Set([...concluidas(ac.estado)].filter((id) => ids.has(id)));
      const p = projeta(m, feitas);
      const q = projeta(m, new Set([...feitas, ...monta(m, meta).usados]));
      const andamento = Object.entries(ac.estado.acoes).filter(([id, v]) => ids.has(id) && v.s === 'andamento').length;
      const atrasadas = Object.entries(ac.estado.acoes).filter(([id, v]) => ids.has(id) && atrasada(v)).length;
      resumo.replaceChildren(
        h('div', { class: 'tr-sim-linha' },
          h('span', {}, `Estimativa ${CATMETA.ano} `, h('strong', {}, pct(d.base))),
          h('span', { class: 'tr-seta', 'aria-hidden': 'true' }, '→'),
          h('span', {}, 'com o que já foi concluído ', chipNivel(p.nivel), ' ', h('strong', {}, pct(p.x)))),
        h('p', { class: 'aviso' },
          `${feitas.size} de ${d.acoes.length} ações concluídas · ${andamento} em andamento` + (atrasadas ? ` · ${plural(atrasadas, 'atrasada', 'atrasadas')}` : '') + ` · essenciais pendentes: ${p.falta}`,
          p.falta ? '' : p.x >= alvo - 1e-9 ? ` · meta (${meta}) alcançada na estimativa` : ` · faltam ${pts((alvo - p.x) * 100)} para o ${meta}`),
        p.x < alvo - 1e-9 || p.falta ? h('p', { class: 'aviso' }, `Concluindo também o caminho até a meta: `, chipNivel(q.nivel), ' ', pct(q.x), '.') : null);
    }

    function desenhaCorpo() {
      const plano = monta(m, meta);
      const blocos = [];
      if (agrupar === 'setor') {
        const porSetor = new Map();
        for (const e of plano.etapas) for (const a of e.acoes) {
          if (!porSetor.has(a.setor)) porSetor.set(a.setor, []);
          porSetor.get(a.setor).push(a);
        }
        for (const [setor, acoes] of [...porSetor.entries()].sort((a, b) => soma(b[1]) - soma(a[1]))) {
          blocos.push(secao(setor, `${plural(acoes.length, 'ação', 'ações')} · até +${pts(soma(acoes))}`, h('div', { class: 'est-reqs' }, acoes.map((a) => cartaoAcao(a, ext, ctl)))));
        }
      } else {
        for (const e of etapasVisiveis(plano)) {
          blocos.push(secao(e.titulo, `${e.nota} ${plural(e.acoes.length, 'ação', 'ações')} · +${pts(soma(e.acoes))}.`,
            h('div', { class: 'est-reqs' }, e.acoes.map((a) => cartaoAcao(a, ext, ctl)))));
        }
      }
      corpo.replaceChildren(
        h('p', { class: 'tr-meta-txt' }, fraseMeta(plano, meta)),
        ...(blocos.length ? blocos : [h('p', { class: 'nada' }, 'Nenhuma pendência nas respostas avaliadas.')]));
    }

    const botao = (rotulo, ativo, onclick) => h('button', { class: 'filtro', type: 'button', 'aria-pressed': ativo ? 'true' : 'false', onclick }, rotulo);
    const metas = h('div', { class: 'filtros', role: 'group', 'aria-label': 'Meta' });
    const grupos = h('div', { class: 'filtros', role: 'group', 'aria-label': 'Agrupar' });
    const desenhaBotoes = () => {
      metas.replaceChildren(...Object.keys(SELOS).reverse().map((s) => botao(s, s === meta, () => { meta = s; guarda.grava('tr-meta', s); desenhaBotoes(); desenhaResumo(); desenhaCorpo(); })));
      grupos.replaceChildren(botao('Por etapa', agrupar === 'etapa', () => { agrupar = 'etapa'; guarda.grava('tr-agrupar', agrupar); desenhaBotoes(); desenhaCorpo(); }),
        botao('Por setor', agrupar === 'setor', () => { agrupar = 'setor'; guarda.grava('tr-agrupar', agrupar); desenhaBotoes(); desenhaCorpo(); }));
    };

    const arquivo = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        if (f.size > 1e6) throw new Error('arquivo grande demais');
        const x = JSON.parse(await f.text());
        if (x.tipo !== 'acompanhamento-pntp' || String(x.ibge) !== String(m.ibge)) throw new Error(`não é um acompanhamento de ${m.nome}`);
        const novo = acomp.normaliza(x, ids);
        let n = 0;
        for (const [id, v] of Object.entries(novo.acoes)) { // fica a versão mais recente de cada ação
          const atual = ac.estado.acoes[id];
          if (!atual || (v.em || '') > (atual.em || '')) { ac.estado.acoes[id] = v; n += 1; }
        }
        await salva();
        desenhaResumo(); desenhaCorpo();
        mostraSalvo(`Importado: ${plural(n, 'ação atualizada', 'ações atualizadas')}. ${salvo.textContent}`);
      } catch (err) {
        mostraSalvo(`Não foi possível importar: ${err.message}`, true);
      }
    } });
    const exporta = () => baixa(`acompanhamento-${nomeArquivo(m.nome)}.json`, 'application/json',
      JSON.stringify({ tipo: 'acompanhamento-pntp', versao: 1, ibge: m.ibge, municipio: m.nome, exportado_em: new Date().toISOString(), acoes: ac.estado.acoes }, null, 1));

    desenhaBotoes(); desenhaResumo(); desenhaCorpo();
    mostraSalvo(ac.erro ? `Não foi possível carregar o acompanhamento salvo: ${ac.erro}` : `O acompanhamento fica salvo ${onde()}.` + (ac.onde === 'navegador' ? ' Para compartilhar com a equipe, exporte e envie o arquivo.' : ''), !!ac.erro);
    return h('div', {},
      cabecalho('Plano de ação · ' + m.nome, 'Plano de ação até o selo',
        `Montado a partir da avaliação validada de ${IDX.meta.ciclo_respostas} e das regras da matriz ${CATMETA.ano}. Para cada ação: o que falta, a observação do tribunal, o que a Cartilha exige e o acompanhamento (situação, responsável, prazo e evidência).`),
      h('div', { class: 'barra-mesa' }, h('div', { class: 'tr-rotulado' }, h('span', { class: 'kicker' }, 'Meta'), metas), h('div', { class: 'tr-rotulado' }, h('span', { class: 'kicker' }, 'Agrupar'), grupos)),
      h('div', { class: 'tr-sim painel' }, resumo,
        h('div', { class: 'form-acoes' },
          h('button', { class: 'botao-texto', type: 'button', onclick: () => baixaCsv(m, monta(m, meta), ac.estado) }, 'Baixar CSV'),
          h('button', { class: 'botao-texto', type: 'button', onclick: exporta }, 'Exportar acompanhamento'),
          h('button', { class: 'botao-texto', type: 'button', onclick: () => arquivo.click() }, 'Importar acompanhamento'),
          arquivo)),
      salvo,
      corpo);
  }

  function baixaCsv(m, plano, estado) {
    // aspas e prefixo ' para que planilhas não executem texto como fórmula (observações e campos vêm de fora)
    const q = (v) => '"' + String(v ?? '').replace(/^([=+\-@\t\r])/, "'$1").replace(/"/g, '""') + '"';
    const linhas = [['etapa', 'criterio', 'descricao', 'classe', 'setor_sugerido', 'o_que_falta', 'ganho_pontos', 'situacao', 'responsavel', 'prazo', 'evidencia', 'observacao_tribunal', 'pagina_avaliada'].join(',')];
    for (const e of etapasVisiveis(plano)) for (const a of e.acoes) {
      const v = estado.acoes[a.id] || {};
      linhas.push([e.titulo, a.id, a.c.texto, a.c.classe, a.setor, rotuloFalta(a.itens), NF1.format(a.ganho), SITUACOES[v.s || 'pendente'], v.resp, dataBr(v.prazo), v.evid, a.nota, a.link].map(q).join(','));
    }
    baixa(`plano-transparencia-${nomeArquivo(m.nome)}.csv`, 'text/csv;charset=utf-8', String.fromCharCode(0xfeff) + linhas.join('\n'));
  }

  function telaChecklist(m, ext, ac) {
    const d = deriva(m);
    const pend = new Map(d.acoes.map((a) => [a.id, a]));
    const situ = (c) => (pend.has(c.id) ? (pend.get(c.id).novo ? 'A conferir' : 'Pendente') : 'Atende');
    const filtro = { s: 'Todas' };
    const corpo = h('tbody');
    const conta = (s) => CATMETA.criterios.filter((c) => s === 'Todas' || situ(c) === s).length;
    const botoes = h('div', { class: 'filtros', role: 'group', 'aria-label': 'Situação' });
    const desenha = () => {
      botoes.replaceChildren(...['Todas', 'Pendente', 'A conferir', 'Atende'].map((s) => h('button', { class: 'filtro', type: 'button', 'aria-pressed': filtro.s === s ? 'true' : 'false', onclick: () => { filtro.s = s; desenha(); } }, s, h('span', { class: 'n' }, String(conta(s))))));
      let dimAnterior = null;
      const linhas = [];
      for (const c of CATMETA.criterios) {
        const s = situ(c);
        if (filtro.s !== 'Todas' && s !== filtro.s) continue;
        if (c.dim !== dimAnterior) { linhas.push(h('tr', { class: 'tr-grupo' }, h('th', { colspan: '4', scope: 'colgroup' }, c.dim))); dimAnterior = c.dim; }
        const a = pend.get(c.id);
        const acompanhamento = a && situacao(ac.estado, c.id) !== 'pendente' ? SITUACOES[situacao(ac.estado, c.id)] : null;
        linhas.push(h('tr', {},
          h('td', { class: 'nw' }, c.id),
          h('td', {}, c.texto, a && !a.novo ? h('span', { class: 'item-meta tr-bloco' }, 'Falta: ' + rotuloFalta(a.itens)) : null),
          h('td', {}, chipClasse(c.classe)),
          h('td', { class: 'nw' }, h('span', { class: 'chip tr-sit', 'data-s': s }, s), a ? h('span', { class: 'tr-sub' }, ' +' + NF1.format(a.ganho)) : null,
            acompanhamento ? h('span', { class: 'item-meta tr-bloco' }, acompanhamento) : null)));
      }
      corpo.replaceChildren(...linhas);
    };
    desenha();
    return h('div', {},
      cabecalho('Checklist · ' + m.nome, `Os ${CATMETA.criterios.length} critérios da matriz ${CATMETA.ano}`,
        `Situação de cada critério que vale para a prefeitura, segundo a avaliação validada de ${IDX.meta.ciclo_respostas}. "A conferir": critério novo, sem avaliação anterior.`),
      h('div', { class: 'barra-mesa' }, botoes),
      h('div', { class: 'tabela-rolagem' }, h('table', { class: 'tabela' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Critério'), h('th', { scope: 'col' }, 'Descrição'), h('th', { scope: 'col' }, 'Classe'), h('th', { scope: 'col' }, 'Situação'))),
        corpo)));
  }

  function telaRelatorio(m, ext, ac) {
    const ano = String(IDX.meta.ciclo_atual);
    const meta = SELOS[guarda.le('tr-meta', 'Diamante')] ? guarda.le('tr-meta', 'Diamante') : 'Diamante';
    const plano = monta(m, meta);
    const d = deriva(m);
    const hoje = new Date().toLocaleDateString('pt-BR');
    const ids = new Set(d.acoes.map((a) => a.id));
    const est = Object.entries(ac.estado.acoes).filter(([id]) => ids.has(id));
    const feitas = new Set(est.filter(([, v]) => v.s === 'concluida').map(([id]) => id));
    const andamento = est.filter(([, v]) => v.s === 'andamento').length;
    const atrasadas = est.filter(([, v]) => atrasada(v)).length;
    const s = ext.sonda && ext.sonda.municipios[String(m.ibge)];
    const sic = ext.siconfi && ext.siconfi.municipios[String(m.ibge)];
    const site = situacaoSite(s);
    return h('div', { class: 'tr-relatorio' },
      h('p', { class: 'form-acoes tr-nao-imprime' },
        h('button', { class: 'btn btn-inline', type: 'button', onclick: () => window.print() }, 'Imprimir ou salvar em PDF'),
        h('a', { class: 'botao-texto', href: `#/m/${m.ibge}/plano` }, 'Mudar a meta no plano')),
      cabecalho(`Transparência pública · relatório para o prefeito · ${hoje}`, `Prefeitura de ${m.nome} (TO)`,
        `Programa Nacional de Transparência Pública (Atricon). Resultado oficial do ciclo ${ano} e plano para o ${meta} nas regras de ${CATMETA.ano}.`),
      secao('Situação', null,
        h('p', {}, veredito(m)),
        tabelaCiclos(m.ciclos)),
      d.essPend.length ? secao('Itens essenciais pendentes', 'Impedem o selo e, pela LRF (arts. 48, 48-A e 51), transferências voluntárias e operações de crédito.',
        h('ul', { class: 'lista-seca' }, d.essPend.map((a) => h('li', {}, `${a.id} ${a.c.texto} (falta: ${rotuloFalta(a.itens)})`)))) : null,
      site || sic ? secao('Verificações recentes', null, h('ul', { class: 'lista-seca' },
        site ? h('li', {}, `Portal (${dataBr(ext.sonda.verificado_em)}): ${site.texto}`) : null,
        sic ? h('li', {}, `Siconfi (${dataBr(ext.siconfi.consultado_em)}): ${fraseRelatorio(sic, 'rreo', ext)}; ${fraseRelatorio(sic, 'rgf', ext).toLowerCase()}.`) : null)) : null,
      secao(`Plano para o ${meta}`, `${fraseMeta(plano, meta)} Andamento: ${feitas.size} de ${d.acoes.length} ações concluídas, ${andamento} em andamento` + (atrasadas ? `, ${plural(atrasadas, 'atrasada', 'atrasadas')}` : '') + `. Com o que já foi concluído, a estimativa é ${pct(projeta(m, feitas).x)}.`,
        etapasVisiveis(plano).map((e) => h('div', { class: 'tr-rel-etapa' },
          h('h3', { class: 'grupo-nome' }, e.titulo, h('span', { class: 'grupo-n' }, `${e.acoes.length} · +${pts(soma(e.acoes))}`)),
          h('div', { class: 'tabela-rolagem' }, h('table', { class: 'tabela' },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Critério'), h('th', { scope: 'col' }, 'O que fazer'), h('th', { scope: 'col' }, 'Responsável'), h('th', { scope: 'col' }, 'Prazo'), h('th', { scope: 'col' }, 'Situação'), h('th', { scope: 'col', class: 'tr-num' }, 'Ganho'))),
            h('tbody', {}, e.acoes.map((a) => {
              const v = ac.estado.acoes[a.id] || {};
              return h('tr', {},
                h('td', { class: 'nw' }, a.id),
                h('td', {}, a.c.texto, h('span', { class: 'item-meta tr-bloco' }, rotuloFaltaCurto(a))),
                h('td', {}, v.resp || a.setor + ' (sugerido)'),
                h('td', { class: 'nw' }, dataBr(v.prazo) || '–', atrasada(v) ? h('span', { class: 'item-meta tr-bloco tr-erro' }, 'atrasada') : null),
                h('td', { class: 'nw' }, SITUACOES[v.s || 'pendente']),
                h('td', { class: 'tr-num' }, '+' + NF1.format(a.ganho)));
            }))))))),
      h('p', { class: 'aviso' }, `Fontes: base aberta do PNTP (Atricon), avaliação validada de ${IDX.meta.ciclo_respostas}; Cartilha e matriz PNTP ${CATMETA.ano}; Siconfi (Tesouro Nacional); verificação automática do portal. A estimativa reproduz a fórmula oficial, mas o resultado depende da validação do TCE-TO e da revisão da Atricon.`));
  }

  function telaMetodologia() {
    const regras = [
      ['Diamante', '95% a 100%', '100% dos essenciais'], ['Ouro', '85% a 94%', '100% dos essenciais'], ['Prata', '75% a 84%', '100% dos essenciais'],
      ['Elevado', 'acima de 75%', 'menos de 100% dos essenciais'], ['Intermediário', '50% a 74%', '–'], ['Básico', '30% a 49%', '–'],
      ['Inicial', '1% a 29%', '–'], ['Inexistente', '0%', 'sem sítio oficial próprio ou fora do ar (critério 1.1)'],
    ];
    const ess = CATMETA.criterios.filter((c) => c.classe === 'Essencial');
    const r = IDX.meta.ciclo_respostas, a = CATMETA.ano;
    return h('div', {},
      cabecalho('Transparência municipal', 'Como o plano é montado'),
      secao('Níveis e selos', `Cartilha PNTP ${a}, tabela 3. O selo (Prata, Ouro ou Diamante) exige todos os itens essenciais.`,
        h('div', { class: 'tabela-rolagem' }, h('table', { class: 'tabela' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Nível'), h('th', { scope: 'col' }, 'Índice'), h('th', { scope: 'col' }, 'Requisito adicional'))),
          h('tbody', {}, regras.map(([n, i, x]) => h('tr', {}, h('td', {}, chipNivel(n)), h('td', {}, i), h('td', {}, x))))))),
      secao(`Os ${ess.length} itens essenciais (${a})`, 'São os da execução orçamentária e financeira: sem eles, além de não haver selo, a LRF (arts. 48, 48-A e 51) impede transferências voluntárias e operações de crédito.',
        h('ul', { class: 'lista-seca' }, ess.map((c) => h('li', {}, `${c.id} ${c.texto}`)))),
      secao('Cálculo do índice', 'Peso da dimensão × peso do critério (essencial 2, obrigatório 1,5, recomendado 1) × peso do item de verificação (disponibilidade 30%, atualidade 30%, série histórica 20%, gravação de relatórios 10%, filtro de pesquisa 10%; os que não se aplicam são rateados). Não há atendimento parcial de um item.',
        h('ul', { class: 'tr-itens-def' }, Object.values(ITEM).map(([n, t]) => h('li', {}, h('strong', {}, n), ': ', t, '.')))),
      secao('De onde vem cada ação', null,
        h('ul', { class: 'lista-seca' },
          h('li', {}, `A situação de cada critério vem das respostas validadas pelo TCE-TO em ${r} (base aberta da Atricon), incluindo a observação do avaliador e o link da página conferida.`),
          h('li', {}, `Os critérios de ${r} foram ligados aos de ${a} pelo texto, porque a numeração mudou (por exemplo, a lista de estagiários era o 6.3 e passou a 6.4). Critérios sem correspondente aparecem como novos, "a conferir".`),
          h('li', {}, `A estimativa usa os pesos de ${a} e conta como pendente o que não foi avaliado antes: é conservadora. Aplicada às respostas de ${r} com os pesos de ${r}, a mesma fórmula reproduz o índice oficial com erro médio de 0,01 ponto.`),
          h('li', {}, 'O plano põe primeiro os essenciais, depois os critérios de maior ganho até a meta, depois os novos a conferir e, por fim, o restante.'),
          h('li', {}, 'O setor responsável é uma sugestão por dimensão; ajuste à estrutura da prefeitura.'))),
      secao('Verificações automáticas', null,
        h('ul', { class: 'lista-seca' },
          h('li', {}, 'Siconfi (Tesouro Nacional): entregas de RREO e RGF de cada prefeitura, ligadas aos essenciais 11.5 e 11.6. Inclui as versões simplificadas dos municípios menores.'),
          h('li', {}, 'Sonda: uma visita à página inicial de cada portal, identificada e respeitando o robots.txt. Verifica se o site responde e procura links (transparência, Radar, SIC, ouvidoria, LGPD, acessibilidade).'),
          h('li', {}, `Comparada com a avaliação validada de ${r}: quando a sonda encontra o link da transparência ou o botão do Radar, o tribunal também tinha aceitado o critério em 98% e 97% dos casos. Quando não encontra, o tribunal aceitou mesmo assim na maioria das vezes: por isso "não encontrado" não é tratado como falha.`))),
      secao('Acompanhamento do plano', null,
        h('ul', { class: 'lista-seca' },
          h('li', {}, 'Cada ação tem situação (pendente, em andamento, concluída), responsável, prazo e link de evidência. A projeção do índice conta só as ações concluídas.'),
          h('li', {}, 'No protótipo, o acompanhamento fica no navegador e pode ser exportado e importado em arquivo, para compartilhar com a equipe. Integrado ao site, fica no servidor.'))),
      secao('Limites', null,
        h('ul', { class: 'lista-seca' },
          h('li', {}, 'O resultado oficial é o do Radar da Transparência Pública (Atricon). Este painel ajuda a preparar a autoavaliação; não a substitui.'),
          h('li', {}, `Mostra o que o tribunal validou em ${r}. As verificações automáticas são pistas, não avaliação.`),
          h('li', {}, 'A matriz do próximo ciclo pode trazer novos critérios ou mudar pesos.'))),
      secao('Fontes', null, h('ul', { class: 'lista-seca' }, IDX.meta.fontes.map((f) => h('li', {}, link(f.url, f.nome + ' ↗'))))));
  }

  // ---------- navegação ----------

  function nav(m, aba) {
    const el = document.getElementById('tr-nav');
    const itens = m
      ? [['', 'Panorama'], ['plano', 'Plano de ação'], ['checklist', 'Checklist'], ['relatorio', 'Relatório']].map(([k, t]) => [`#/m/${m.ibge}${k ? '/' + k : ''}`, t, aba === (k || 'panorama')])
      : [];
    itens.push(['#/metodologia', 'Metodologia', aba === 'metodologia']);
    el.replaceChildren(...itens.map(([href, t, atual]) => h('a', { class: 'nav-item', href, 'aria-current': atual ? 'page' : null }, t)));
    const ctx = document.getElementById('tr-contexto');
    ctx.replaceChildren(m ? h('span', {}, m.nome, ' · ', h('a', { href: '#/' }, 'trocar')) : h('a', { href: '#/' }, 'Escolher município'));
  }

  let geracao = 0;
  async function rota() {
    const minha = ++geracao;
    const [nome = '', arg, aba = 'panorama'] = location.hash.replace(/^#\/?/, '').split('/');
    const app = document.getElementById('tr-app');
    let tela;
    try {
      if (nome === 'm' && /^\d{7}$/.test(arg || '')) {
        app.setAttribute('aria-busy', 'true');
        const [m, , siconfi, sonda] = await Promise.all([json(`dados/m/${arg}.json`), catalogo(), opcional('dados/siconfi.json'), opcional('dados/sonda.json')]);
        const ids = new Set(deriva(m).acoes.map((a) => a.id));
        let ac;
        try {
          ac = await acomp.le(m.ibge, ids);
        } catch (e) {
          ac = { estado: acomp.normaliza(null, ids), onde: acomp.api() ? 'servidor' : 'navegador', erro: e.message };
        }
        if (minha !== geracao) return;
        guarda.grava('tr-municipio', m.ibge);
        nav(m, aba);
        const ext = { ibge: m.ibge, siconfi, sonda };
        const telaAba = { plano: telaPlano, checklist: telaChecklist, relatorio: telaRelatorio }[aba];
        tela = telaAba && !m.pendencias
          ? h('div', { class: 'plain' }, h('h1', { id: 'tr-titulo', tabindex: '-1' }, 'Sem respostas detalhadas'), h('p', {}, `A base de ${IDX.meta.ciclo_respostas} não traz as respostas critério a critério desta prefeitura.`))
          : (telaAba || telaPanorama)(m, ext, ac);
      } else if (nome === 'metodologia') {
        await catalogo();
        if (minha !== geracao) return;
        nav(null, 'metodologia');
        tela = telaMetodologia();
      } else {
        nav(null, '');
        tela = telaEscolha();
      }
    } catch (e) {
      tela = h('div', { class: 'plain' }, h('h1', { id: 'tr-titulo', tabindex: '-1' }, 'Não foi possível abrir'), h('p', {}, e.message), h('a', { class: 'back', href: '#/' }, '← Escolher município'));
    }
    app.removeAttribute('aria-busy');
    app.replaceChildren(tela);
    const t = document.getElementById('tr-titulo');
    if (t) t.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  // ---------- aparência (Terminal, Claro, Escuro, como no site) ----------

  function aparencia() {
    const sel = document.getElementById('tr-aparencia');
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

  async function inicia() {
    aparencia();
    try {
      IDX = await json('dados/municipios.json');
    } catch (e) {
      document.getElementById('tr-app').replaceChildren(h('div', { class: 'plain' }, h('h1', {}, 'Não foi possível carregar os dados'), h('p', {}, 'Gere a pasta dados/ com build_dados.py. ' + e.message)));
      return;
    }
    window.addEventListener('hashchange', rota);
    rota();
  }

  inicia();
})();
