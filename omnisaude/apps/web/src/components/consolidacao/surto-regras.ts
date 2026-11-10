import {
  arredondar,
  CATEGORIA_SURTO,
  CRITERIO_CASO_SURTO,
  DELIMITACAO_SURTO,
  fromZonedParts,
  localDateString,
  validarSurto,
  zonedParts,
  type BlocoDta,
  type CasoSurto,
  type CategoriaSurto,
  type CorpoComunicacaoSurto,
  type CorpoEditarSurto,
  type CorpoEncerrarSurto,
  type CorpoNovoSurto,
  type DadosSurtoValidacao,
  type DetalheSurto,
  type EventoSurto,
  type LinhaCasoSurto,
  type LocalSurto,
  type StatusSurto,
  type SugestaoSurtoTela,
  type TipoVinculoSurto,
} from '@omnisaude/shared';

/*
 * Regras da aba Surtos sem React (testadas em apps/web/test/surto-regras.test.ts): formulário da notificação de surto
 * (manual ou a partir de uma sugestão), só o que mudou para o PATCH, encerramento, comunicação, linha manual da
 * planilha, linha do tempo e comunicações. As pendências usam o `validarSurto` compartilhado, o mesmo da API.
 */

export type Tom = 'slate' | 'blue' | 'green' | 'amber' | 'red' | 'violet';

export const TOM_STATUS_SURTO: Record<StatusSurto, Tom> = { ABERTO: 'amber', ENCERRADO: 'green', DESCARTADO: 'slate' };
export const ROTULO_VINCULO: Record<TipoVinculoSurto | 'MUNICIPIO', string> = { QUARTEIRAO: 'Quarteirão', BAIRRO: 'Bairro', UNIDADE: 'Unidade', MUNICIPIO: 'Município' };
export const ROTULO_CANAL_COMUNICACAO: Record<CorpoComunicacaoSurto['canal'], string> = {
  TELEFONE: 'Telefone',
  EMAIL: 'E-mail',
  FORMULARIO: 'Formulário eletrônico',
  PRESENCIAL: 'Presencial',
  OUTRO: 'Outro',
};
/** CS_ZONA. */
export const ROTULO_ZONA: Record<string, string> = { '1': 'Urbana', '2': 'Rural', '3': 'Periurbana', '9': 'Ignorado' };
export const ROTULO_SEXO: Record<string, string> = { M: 'Masculino', F: 'Feminino', I: 'Ignorado' };
export const ESFERAS_SURTO = ['SMS', 'SES', 'MS'] as const;

/** Local inicial sugerido pelo vínculo do aglomerado: quarteirão e bairro → 8 (casos no bairro); unidade → 2; município → 9. */
export const LOCAL_INICIAL_DO_VINCULO: Record<TipoVinculoSurto | 'MUNICIPIO', string> = { QUARTEIRAO: '8', BAIRRO: '8', UNIDADE: '2', MUNICIPIO: '9' };

/**
 * Bloco da ficha de surto de DTA, resumido (campos 27 a 60): as variáveis do dicionário que a API conhece. Datas em
 * AAAA-MM-DD; o critério com os códigos do dicionário.
 */
export const CAMPOS_DTA: { variavel: string; rotulo: string; tipo: 'numero' | 'texto' | 'data' | 'criterio' }[] = [
  { variavel: 'NU_ENTR', rotulo: 'Nº de entrevistados', tipo: 'numero' },
  { variavel: 'NU_ENT_DOE', rotulo: 'Nº de doentes entrevistados', tipo: 'numero' },
  { variavel: 'NU_TOT', rotulo: 'Total de doentes', tipo: 'numero' },
  { variavel: 'NU_TOT_HOS', rotulo: 'Nº de hospitalizados', tipo: 'numero' },
  { variavel: 'NU_OBITO', rotulo: 'Nº de óbitos', tipo: 'numero' },
  { variavel: 'TP_PRO_PRE', rotulo: 'Local de produção/preparação', tipo: 'texto' },
  { variavel: 'ST_ALIMEN', rotulo: 'Local de ingestão', tipo: 'texto' },
  { variavel: 'DS_ETIOLOG', rotulo: 'Agente etiológico', tipo: 'texto' },
  { variavel: 'DS_ALICAUS', rotulo: 'Alimento causador', tipo: 'texto' },
  { variavel: 'CRITERIO', rotulo: 'Critério de confirmação', tipo: 'criterio' },
  { variavel: 'DT_ENCERRA', rotulo: 'Data de encerramento (DTA)', tipo: 'data' },
];

/** Data civil AAAA-MM-DD como dd/mm/aaaa. */
export const dataBr = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');
export const simNao = (v: boolean | null | undefined) => (v === true ? 'Sim' : v === false ? 'Não' : '—');
/** Número com até 2 casas (ARRED do Excel). */
export const numeroBr = (x: number) => arredondar(x, 2).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const texto = (s: string | null | undefined) => s?.trim() || null;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const CID = /^[A-Za-z]\d{2}(\.?\d{1,2})?$/;
/** CID como a API guarda: sem ponto, maiúsculo. */
export const cidNormalizado = (s: string | null | undefined) => texto(s)?.replace(/\./g, '').toUpperCase() ?? null;

// ───────────── Datas e horas ─────────────

/** Instante ISO → "AAAA-MM-DDTHH:MM" na hora de parede do fuso da instituição (valor do campo datetime-local). */
export function isoParaLocal(iso: string | null | undefined, tz: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = zonedParts(d, tz);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}

/** "AAAA-MM-DDTHH:MM" lido no fuso da instituição → instante ISO (UTC); null quando inválido. */
export function localParaIso(local: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local.trim());
  if (!m) return null;
  const [ano, mes, dia, hora, minuto] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const iso = fromZonedParts({ year: ano, month: mes, day: dia, hour: hora, minute: minuto, second: 0 }, tz).toISOString();
  // Data inexistente (31/02) ou hora fora do relógio: a volta não bate.
  return isoParaLocal(iso, tz) === local.trim().slice(0, 16) ? iso : null;
}

/** Inteiro digitado; null quando vazio ou não inteiro. */
export function lerInteiro(s: string): number | null {
  const t = s.trim();
  return /^\d{1,7}$/.test(t) ? Number(t) : null;
}

/** Número decimal digitado (vírgula ou ponto); null quando vazio; NaN quando inválido. */
export function lerDecimal(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (!t) return null;
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN;
}

// ───────────── Formulário da notificação de surto ─────────────

export interface FormLocal {
  municipioIbge: string;
  localidadeId: string;
  bairroId: string;
  endereco: string;
  referencia: string;
  zona: string;
  lat: string;
  lng: string;
}

export interface FormSurto {
  categoria: CategoriaSurto;
  grupo: string;
  sindrome: string;
  cid: string;
  agente: string;
  /** AAAA-MM-DD. */
  notificadoEm: string;
  /** AAAA-MM-DDTHH:MM no fuso da instituição. */
  conhecidoEm: string;
  esp: boolean;
  unitId: string;
  primeirosSintomasEm: string;
  casos: string;
  localInicial: string;
  localInicialTexto: string;
  local: FormLocal;
}

export const localVazio = (): FormLocal => ({ municipioIbge: '', localidadeId: '', bairroId: '', endereco: '', referencia: '', zona: '', lat: '', lng: '' });

/** Quais campos de agravo a categoria usa: da lista e DTA, o agravo do catálogo; agravo inusitado, a síndrome. */
export const usaGrupo = (c: CategoriaSurto) => c === 'DA_LISTA' || c === 'DTA';
export const usaSindrome = (c: CategoriaSurto) => c === 'SINDROMICO';

/** Notificação de surto manual, em branco: hoje, agora e a unidade do contexto. */
export function formNovoSurto(o: { hoje: string; agora: string; unitId: string }): FormSurto {
  return {
    categoria: 'DA_LISTA',
    grupo: '',
    sindrome: '',
    cid: '',
    agente: '',
    notificadoEm: o.hoje,
    conhecidoEm: o.agora,
    esp: false,
    unitId: o.unitId,
    primeirosSintomasEm: '',
    casos: '',
    localInicial: '',
    localInicialTexto: '',
    local: localVazio(),
  };
}

/**
 * Notificação pré-preenchida a partir da sugestão: o agravo, os casos, o primeiro sintoma (ou, sem ele, a data do
 * primeiro caso conhecido), o local inicial pelo vínculo, o bairro (vínculo de bairro) e a unidade (vínculo de unidade;
 * nos demais, a unidade padrão). O instante do conhecimento fica "agora": a vigilância corrige se soube antes.
 */
export function formDaSugestao(s: SugestaoSurtoTela, o: { hoje: string; agora: string; unitIdPadrao: string; tz: string }): FormSurto {
  const sintomas = [s.primeiroSintoma, ...s.casosDetalhe.map((c) => c.inicioSintomas)].filter((d): d is string => !!d && DATA.test(d)).sort();
  const conhecidos = s.casosDetalhe.map((c) => localDateString(new Date(c.conhecidoEm), o.tz)).sort();
  return {
    ...formNovoSurto({ hoje: o.hoje, agora: o.agora, unitId: s.vinculo.tipo === 'UNIDADE' ? s.vinculo.id : o.unitIdPadrao }),
    categoria: 'DA_LISTA',
    grupo: s.grupo,
    primeirosSintomasEm: sintomas[0] ?? conhecidos[0] ?? '',
    casos: String(Math.max(1, s.casos.length)),
    localInicial: LOCAL_INICIAL_DO_VINCULO[s.vinculo.tipo],
    local: { ...localVazio(), bairroId: s.vinculo.tipo === 'BAIRRO' ? s.vinculo.id : '' },
  };
}

/** Só os campos preenchidos do local (o restante fica como está). */
function localPreenchido(f: FormLocal): Partial<LocalSurto> {
  const l: Partial<LocalSurto> = {};
  const ibge = f.municipioIbge.replace(/\D/g, '');
  if (ibge) l.municipioIbge = ibge;
  if (f.localidadeId) l.localidadeId = f.localidadeId;
  if (f.bairroId) l.bairroId = f.bairroId;
  if (texto(f.endereco)) l.endereco = texto(f.endereco);
  if (texto(f.referencia)) l.referencia = texto(f.referencia);
  if (f.zona) l.zona = f.zona;
  const lat = lerDecimal(f.lat);
  const lng = lerDecimal(f.lng);
  if (lat !== null && Number.isFinite(lat)) l.lat = lat;
  if (lng !== null && Number.isFinite(lng)) l.lng = lng;
  return l;
}

/** Corpo do POST /vigilancia/surtos (com a assinatura e os casos quando vem de uma sugestão). */
export function corpoNovoSurto(f: FormSurto, tz: string, sugestao?: Pick<SugestaoSurtoTela, 'assinatura' | 'casos'> | null): CorpoNovoSurto {
  const local = localPreenchido(f.local);
  return {
    ...(sugestao ? { assinatura: sugestao.assinatura, casosIndicados: sugestao.casos.map((id) => ({ notificationId: id })) } : {}),
    categoria: f.categoria,
    grupo: usaGrupo(f.categoria) ? f.grupo || null : null,
    sindrome: usaSindrome(f.categoria) ? f.sindrome || null : null,
    cid: cidNormalizado(f.cid),
    agente: texto(f.agente),
    notificadoEm: f.notificadoEm,
    conhecidoEm: localParaIso(f.conhecidoEm, tz) ?? '',
    esp: f.esp,
    unitId: f.unitId,
    primeirosSintomasEm: f.primeirosSintomasEm,
    casos: lerInteiro(f.casos) ?? 0,
    localInicial: f.localInicial,
    localInicialTexto: f.localInicial === '11' ? texto(f.localInicialTexto) : null,
    ...(Object.keys(local).length ? { local } : {}),
  };
}

/** Regras da categoria (as mesmas da API): agravo do catálogo, síndrome ou CID. */
export function errosCategoria(f: { categoria: CategoriaSurto; grupo: string | null; sindrome: string | null; cid: string | null }): string[] {
  const erros: string[] = [];
  if (f.categoria === 'DA_LISTA' && !f.grupo) erros.push('Surto de doença da lista: escolha o agravo do catálogo.');
  if (f.categoria === 'SINDROMICO' && !f.sindrome) erros.push('Agravo inusitado: escolha a síndrome.');
  if (f.categoria === 'FORA_DA_LISTA' && !texto(f.cid)) erros.push('Doença fora da lista: informe o CID.');
  if (texto(f.cid) && !CID.test(texto(f.cid)!)) erros.push('CID inválido (ex.: A05.9).');
  return erros;
}

function errosLocal(f: FormLocal): string[] {
  const erros: string[] = [];
  const ibge = f.municipioIbge.replace(/\D/g, '');
  if (f.municipioIbge.trim() && !/^\d{6,7}$/.test(ibge)) erros.push('Município de ocorrência: código IBGE de 6 ou 7 dígitos.');
  const lat = lerDecimal(f.lat);
  const lng = lerDecimal(f.lng);
  if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) erros.push('Latitude inválida (de -90 a 90).');
  if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) erros.push('Longitude inválida (de -180 a 180).');
  return erros;
}

const unico = (xs: string[]) => [...new Set(xs)];
/** Limite do nº de casos na API. */
const MAXIMO_CASOS = 1_000_000;

/** Pendências da notificação nova (etapa NOTIFICACAO do `validarSurto`, categoria, conhecimento e datas). */
export function pendenciasNovoSurto(f: FormSurto, o: { hoje: string; agoraIso: string; tz: string }): string[] {
  const categoria = { categoria: f.categoria, grupo: usaGrupo(f.categoria) ? f.grupo || null : null, sindrome: usaSindrome(f.categoria) ? f.sindrome || null : null, cid: texto(f.cid) };
  const erros = [...errosCategoria(categoria)];
  const dados: DadosSurtoValidacao = {
    notificadoEm: f.notificadoEm || null,
    unitId: f.unitId || null,
    grupo: categoria.grupo,
    sindrome: categoria.sindrome,
    cid: categoria.cid,
    primeirosSintomasEm: f.primeirosSintomasEm || null,
    casos: lerInteiro(f.casos),
    localInicial: f.localInicial || null,
    localInicialTexto: texto(f.localInicialTexto),
  };
  erros.push(...validarSurto(dados, 'NOTIFICACAO'));
  if ((dados.casos ?? 0) > MAXIMO_CASOS) erros.push('O número de casos vai até 1.000.000.');
  if (f.notificadoEm && f.notificadoEm > o.hoje) erros.push('A data da notificação não pode ser futura.');
  const conhecido = localParaIso(f.conhecidoEm, o.tz);
  if (!conhecido) erros.push('Informe quando a vigilância soube do surto (data e hora).');
  else if (Date.parse(conhecido) > Date.parse(o.agoraIso) + 60_000) erros.push('O conhecimento do surto não pode ser futuro.');
  erros.push(...errosLocal(f.local));
  return unico(erros);
}

// ───────────── Edição (PATCH) ─────────────

export interface FormInvestigacao {
  investigadoEm: string;
  modoTransmissao: string;
  veiculo: string;
  veiculoTexto: string;
  observacoes: string;
  investigadorNome: string;
  investigadorFuncao: string;
}

/** Ficha editável do surto aberto (unidade e conhecimento não mudam depois de notificado). */
export interface FormEdicaoSurto extends Omit<FormSurto, 'conhecidoEm' | 'unitId'> {
  investigacao: FormInvestigacao;
  /** Bloco DTA: variável → texto digitado. */
  dta: Record<string, string>;
}

const str = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));

export function formEdicao(d: DetalheSurto): FormEdicaoSurto {
  return {
    categoria: d.categoria,
    grupo: d.grupo ?? '',
    sindrome: d.sindrome ?? '',
    cid: d.cid ?? '',
    agente: d.agente ?? '',
    notificadoEm: d.notificadoEm,
    esp: d.esp,
    primeirosSintomasEm: d.primeirosSintomasEm,
    casos: String(d.casos),
    localInicial: d.localInicial,
    localInicialTexto: d.localInicialTexto ?? '',
    local: {
      municipioIbge: d.local.municipioIbge ?? '',
      localidadeId: d.local.localidadeId ?? '',
      bairroId: d.local.bairroId ?? '',
      endereco: d.local.endereco ?? '',
      referencia: d.local.referencia ?? '',
      zona: d.local.zona ?? '',
      lat: str(d.local.lat),
      lng: str(d.local.lng),
    },
    investigacao: {
      investigadoEm: d.investigacao.investigadoEm ?? '',
      modoTransmissao: d.investigacao.modoTransmissao ?? '',
      veiculo: d.investigacao.veiculo ?? '',
      veiculoTexto: d.investigacao.veiculoTexto ?? '',
      observacoes: d.investigacao.observacoes ?? '',
      investigadorNome: d.investigacao.investigadorNome ?? '',
      investigadorFuncao: d.investigacao.investigadorFuncao ?? '',
    },
    dta: Object.fromEntries(Object.entries(d.dta ?? {}).map(([k, v]) => [k, str(v)])),
  };
}

/** O bloco DTA cabe quando a categoria é DTA ou o veículo é alimento/água (regra da API). */
export const aceitaDta = (categoria: CategoriaSurto, veiculo: string) => categoria === 'DTA' || veiculo === '1';

/** Bloco DTA do formulário: só os campos preenchidos (números como número); null quando vazio. */
export function dtaDoForm(dta: Record<string, string>): BlocoDta | null {
  const out: BlocoDta = {};
  for (const campo of CAMPOS_DTA) {
    const v = dta[campo.variavel]?.trim();
    if (!v) continue;
    out[campo.variavel] = campo.tipo === 'numero' && /^\d{1,7}$/.test(v) ? Number(v) : v;
  }
  // Variáveis que a tela não mostra (gravadas por outra via) continuam no bloco.
  for (const [k, v] of Object.entries(dta)) if (!CAMPOS_DTA.some((c) => c.variavel === k) && v.trim()) out[k] = v.trim();
  return Object.keys(out).length ? out : null;
}

const ordenado = (b: BlocoDta | null) => (b ? JSON.stringify(Object.fromEntries(Object.entries(b).sort(([a], [c]) => a.localeCompare(c)))) : 'null');

/** Só o que mudou na ficha, para o PATCH /vigilancia/surtos/:id (texto vazio = apagar). */
export function corpoEdicao(d: DetalheSurto, f: FormEdicaoSurto): CorpoEditarSurto {
  const c: CorpoEditarSurto = {};
  if (f.categoria !== d.categoria) c.categoria = f.categoria;
  const grupo = usaGrupo(f.categoria) ? f.grupo || null : null;
  if (grupo !== (d.grupo ?? null)) c.grupo = grupo;
  const sindrome = usaSindrome(f.categoria) ? f.sindrome || null : null;
  if (sindrome !== (d.sindrome ?? null)) c.sindrome = sindrome;
  const cid = cidNormalizado(f.cid);
  if (cid !== cidNormalizado(d.cid)) c.cid = cid;
  if (texto(f.agente) !== (d.agente ?? null)) c.agente = texto(f.agente);
  if (f.notificadoEm !== d.notificadoEm) c.notificadoEm = f.notificadoEm;
  if (f.esp !== d.esp) c.esp = f.esp;
  if (f.primeirosSintomasEm !== d.primeirosSintomasEm) c.primeirosSintomasEm = f.primeirosSintomasEm;
  const casos = lerInteiro(f.casos);
  if (casos !== null && casos !== d.casos) c.casos = casos;
  if (f.localInicial !== d.localInicial) c.localInicial = f.localInicial;
  const localTexto = f.localInicial === '11' ? texto(f.localInicialTexto) : null;
  if (localTexto !== (d.localInicialTexto ?? null)) c.localInicialTexto = localTexto;

  const local: Partial<LocalSurto> = {};
  const ibge = f.local.municipioIbge.replace(/\D/g, '') || null;
  if (ibge !== (d.local.municipioIbge ?? null)) local.municipioIbge = ibge;
  if ((f.local.localidadeId || null) !== (d.local.localidadeId ?? null)) local.localidadeId = f.local.localidadeId || null;
  if ((f.local.bairroId || null) !== (d.local.bairroId ?? null)) local.bairroId = f.local.bairroId || null;
  if (texto(f.local.endereco) !== (d.local.endereco ?? null)) local.endereco = texto(f.local.endereco);
  if (texto(f.local.referencia) !== (d.local.referencia ?? null)) local.referencia = texto(f.local.referencia);
  if ((f.local.zona || null) !== (d.local.zona ?? null)) local.zona = f.local.zona || null;
  for (const k of ['lat', 'lng'] as const) {
    const v = lerDecimal(f.local[k]);
    if (v !== null && !Number.isFinite(v)) continue;
    if (v !== (d.local[k] ?? null)) local[k] = v;
  }
  if (Object.keys(local).length) c.local = local;

  const inv: CorpoEditarSurto['investigacao'] = {};
  const i = f.investigacao;
  const atual = d.investigacao;
  if ((i.investigadoEm || null) !== (atual.investigadoEm ?? null)) inv.investigadoEm = i.investigadoEm || null;
  if ((i.modoTransmissao || null) !== (atual.modoTransmissao ?? null)) inv.modoTransmissao = i.modoTransmissao || null;
  if ((i.veiculo || null) !== (atual.veiculo ?? null)) inv.veiculo = i.veiculo || null;
  const veiculoTexto = i.veiculo === '6' ? texto(i.veiculoTexto) : null;
  if (veiculoTexto !== (atual.veiculoTexto ?? null)) inv.veiculoTexto = veiculoTexto;
  if (texto(i.observacoes) !== (atual.observacoes ?? null)) inv.observacoes = texto(i.observacoes);
  if (texto(i.investigadorNome) !== (atual.investigadorNome ?? null)) inv.investigadorNome = texto(i.investigadorNome);
  if (texto(i.investigadorFuncao) !== (atual.investigadorFuncao ?? null)) inv.investigadorFuncao = texto(i.investigadorFuncao);
  if (Object.keys(inv).length) c.investigacao = inv;

  const dta = aceitaDta(f.categoria, i.veiculo) ? dtaDoForm(f.dta) : null;
  if (ordenado(dta) !== ordenado(d.dta ?? null)) c.dta = dta;
  return c;
}

/** Pendências da ficha editada (etapa INVESTIGACAO quando há data da investigação, como na API). */
export function pendenciasEdicao(d: DetalheSurto, f: FormEdicaoSurto, hoje: string): string[] {
  const categoria = { categoria: f.categoria, grupo: usaGrupo(f.categoria) ? f.grupo || null : null, sindrome: usaSindrome(f.categoria) ? f.sindrome || null : null, cid: texto(f.cid) };
  const erros = [...errosCategoria(categoria)];
  const investigadoEm = f.investigacao.investigadoEm || null;
  const dados: DadosSurtoValidacao = {
    notificadoEm: f.notificadoEm || null,
    unitId: d.unidade.id,
    grupo: categoria.grupo,
    sindrome: categoria.sindrome,
    cid: categoria.cid,
    primeirosSintomasEm: f.primeirosSintomasEm || null,
    casos: lerInteiro(f.casos),
    localInicial: f.localInicial || null,
    localInicialTexto: texto(f.localInicialTexto),
    investigadoEm,
  };
  erros.push(...validarSurto(dados, investigadoEm ? 'INVESTIGACAO' : 'NOTIFICACAO'));
  if ((dados.casos ?? 0) > MAXIMO_CASOS) erros.push('O número de casos vai até 1.000.000.');
  if (f.notificadoEm && f.notificadoEm > hoje) erros.push('A data da notificação não pode ser futura.');
  if (investigadoEm && investigadoEm > hoje) erros.push('A data da investigação não pode ser futura.');
  if (f.investigacao.veiculo === '6' && !texto(f.investigacao.veiculoTexto)) erros.push('Descreva o veículo de transmissão (Outro).');
  erros.push(...errosLocal(f.local));
  if (aceitaDta(f.categoria, f.investigacao.veiculo))
    for (const campo of CAMPOS_DTA) {
      const v = f.dta[campo.variavel]?.trim();
      if (!v) continue;
      if (campo.tipo === 'numero' && !/^\d{1,7}$/.test(v)) erros.push(`DTA, ${campo.rotulo}: número inteiro.`);
      if (campo.tipo === 'data' && (!DATA.test(v) || v > hoje)) erros.push(`DTA, ${campo.rotulo}: data válida e não futura.`);
    }
  return unico(erros);
}

// ───────────── Encerramento, descarte, número e comunicação ─────────────

/** Dados do surto gravado para o `validarSurto`. */
export function dadosDoDetalhe(d: DetalheSurto): DadosSurtoValidacao {
  return {
    notificadoEm: d.notificadoEm,
    unitId: d.unidade.id,
    grupo: d.grupo,
    sindrome: d.sindrome,
    cid: d.cid,
    primeirosSintomasEm: d.primeirosSintomasEm,
    casos: d.casos,
    localInicial: d.localInicial,
    localInicialTexto: d.localInicialTexto,
    investigadoEm: d.investigacao.investigadoEm,
    delimitacao: d.delimitacao,
    delimitacaoTexto: d.delimitacaoTexto,
    encerradoEm: d.encerradoEm,
  };
}

export interface FormEncerramento {
  delimitacao: string;
  texto: string;
  data: string;
  notas: string;
}

/** Pendências do encerramento: as três etapas do `validarSurto` (exige a investigação gravada) e a data não futura. */
export function pendenciasEncerramento(d: DetalheSurto, f: FormEncerramento, hoje: string): string[] {
  const erros = validarSurto({ ...dadosDoDetalhe(d), delimitacao: f.delimitacao || null, delimitacaoTexto: texto(f.texto), encerradoEm: f.data || null }, 'ENCERRAMENTO');
  if (f.data && f.data > hoje) erros.push('O encerramento não pode ter data futura.');
  return unico(erros);
}

export function corpoEncerramento(f: FormEncerramento): CorpoEncerrarSurto {
  return { delimitacao: f.delimitacao, texto: f.delimitacao === '11' ? texto(f.texto) : null, data: f.data, notas: texto(f.notas) };
}

export const MINIMO_MOTIVO = 10;
export const faltaNoMotivo = (motivo: string) => Math.max(0, MINIMO_MOTIVO - motivo.trim().length);
export const numeroSinanValido = (n: string) => /^\d{1,7}$/.test(n.trim());

export interface FormComunicacao {
  alvo: (typeof ESFERAS_SURTO)[number];
  canal: CorpoComunicacaoSurto['canal'];
  contraparte: string;
  protocolo: string;
  nota: string;
  /** AAAA-MM-DDTHH:MM no fuso da instituição. */
  em: string;
}

export function pendenciasComunicacao(f: FormComunicacao, o: { tz: string; agoraIso: string; conhecidoEm: string }): string[] {
  const erros: string[] = [];
  if (f.contraparte.trim().length < 2) erros.push('Informe com quem falou (nome ou setor).');
  const em = localParaIso(f.em, o.tz);
  if (!em) erros.push('Informe a data e a hora da comunicação.');
  else {
    if (Date.parse(em) > Date.parse(o.agoraIso) + 60_000) erros.push('A comunicação não pode ter data futura.');
    // Como na API: o instante exato do conhecimento (o campo tem minutos; no mesmo minuto, use o seguinte).
    if (Date.parse(em) < Date.parse(o.conhecidoEm)) erros.push('A comunicação não pode ser anterior ao conhecimento do surto.');
  }
  return erros;
}

export function corpoComunicacao(f: FormComunicacao, tz: string): CorpoComunicacaoSurto {
  return { alvo: f.alvo, canal: f.canal, contraparte: f.contraparte.trim(), protocolo: texto(f.protocolo), nota: texto(f.nota), em: localParaIso(f.em, tz) ?? '' };
}

export interface ComunicacaoSurto {
  id: string;
  alvo: string;
  canal: string;
  contraparte: string;
  protocolo: string | null;
  nota: string | null;
  em: string;
  registradoEm: string;
  por: string | null;
}

/** Comunicações registradas (eventos COMUNICADO), da mais recente para a mais antiga. */
export function comunicacoesDoSurto(eventos: EventoSurto[]): ComunicacaoSurto[] {
  return eventos
    .filter((e) => e.tipo === 'COMUNICADO')
    .map((e) => {
      const p = e.dados as Partial<Record<'alvo' | 'canal' | 'contraparte' | 'protocolo' | 'nota' | 'em', string | null>>;
      return { id: e.id, alvo: p.alvo ?? '', canal: p.canal ?? '', contraparte: p.contraparte ?? '', protocolo: p.protocolo ?? null, nota: p.nota ?? null, em: p.em ?? e.em, registradoEm: e.em, por: e.por };
    })
    .sort((a, b) => Date.parse(b.em) - Date.parse(a.em));
}

// ───────────── Planilha de casos ─────────────

export interface FormLinhaCaso {
  iniciais: string;
  sexo: string;
  idade: string;
  municipioResidencia: string;
  bairroId: string;
  inicioSintomas: string;
  hospitalizado: '' | 'S' | 'N';
  obito: '' | 'S' | 'N';
  classificacao: string;
  criterio: string;
  cidFinal: string;
}

export const linhaVazia = (): FormLinhaCaso => ({
  iniciais: '',
  sexo: '',
  idade: '',
  municipioResidencia: '',
  bairroId: '',
  inicioSintomas: '',
  hospitalizado: '',
  obito: '',
  classificacao: '',
  criterio: '',
  cidFinal: '',
});

const LIMITE_IDADE: Record<string, number> = { A: 130, M: 11, D: 31, H: 23 };

/** Idade como a API aceita: número e unidade ("34", "34 anos", "34A", "5 meses", "10 dias", "12 horas"). */
export function idadeValida(t: string): boolean {
  const s = t.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const m = /^(\d{1,3})\s*([a-z]*)\.?$/.exec(s);
  if (!m) return false;
  const u = ['', 'a', 'ano', 'anos'].includes(m[2]!) ? 'A' : ['m', 'mes', 'meses'].includes(m[2]!) ? 'M' : ['d', 'dia', 'dias'].includes(m[2]!) ? 'D' : ['h', 'hora', 'horas'].includes(m[2]!) ? 'H' : null;
  return !!u && Number(m[1]) <= LIMITE_IDADE[u]!;
}

export function pendenciasLinhaCaso(f: FormLinhaCaso, hoje: string): string[] {
  const erros: string[] = [];
  if (f.idade.trim() && !idadeValida(f.idade)) erros.push('Idade: número e unidade (ex.: 34 anos, 5 meses, 10 dias).');
  if (f.inicioSintomas && f.inicioSintomas > hoje) erros.push('O início dos sintomas não pode ser futuro.');
  if (f.municipioResidencia.trim() && !/^\d{6,7}$/.test(f.municipioResidencia.replace(/\D/g, ''))) erros.push('Município de residência: código IBGE de 6 ou 7 dígitos.');
  if (texto(f.cidFinal) && !CID.test(texto(f.cidFinal)!)) erros.push('CID final inválido (ex.: A05.9).');
  if (f.iniciais.trim().length > 15) erros.push('As iniciais têm até 15 letras.');
  if (!Object.entries(f).some(([k, v]) => k !== 'sexo' && typeof v === 'string' && v.trim()) && !f.sexo) erros.push('Preencha ao menos um campo da linha.');
  return erros;
}

export function corpoLinhaCaso(f: FormLinhaCaso): LinhaCasoSurto {
  const sn = (v: '' | 'S' | 'N') => (v === 'S' ? true : v === 'N' ? false : null);
  const ibge = f.municipioResidencia.replace(/\D/g, '');
  return {
    iniciais: texto(f.iniciais)?.toUpperCase() ?? null,
    sexo: f.sexo || null,
    idade: texto(f.idade),
    municipioResidencia: ibge || null,
    bairroId: f.bairroId || null,
    inicioSintomas: f.inicioSintomas || null,
    hospitalizado: sn(f.hospitalizado),
    obito: sn(f.obito),
    classificacao: f.classificacao || null,
    criterio: f.criterio || null,
    cidFinal: cidNormalizado(f.cidFinal),
  };
}

/** De onde veio a linha da planilha. */
export function origemDoCaso(c: Pick<CasoSurto, 'notificationId' | 'notificacaoNumero' | 'officialRecordId'>): string {
  if (c.notificationId) return `Notificação ${c.notificacaoNumero ?? ''}`.trim();
  if (c.officialRecordId) return 'Registro oficial';
  return 'Linha manual';
}

/** Notificações que ainda podem entrar na planilha (não descartadas e fora dela). */
export function candidatasParaPlanilha<T extends { id: string; status: string }>(lista: T[], planilha: Pick<CasoSurto, 'notificationId'>[]): T[] {
  const ja = new Set(planilha.map((c) => c.notificationId).filter(Boolean));
  return lista.filter((n) => n.status !== 'DESCARTADA' && !ja.has(n.id));
}

// ───────────── Linha do tempo ─────────────

const CAMPO_EDITADO: Record<string, string> = {
  categoria: 'categoria',
  grupo: 'agravo',
  sindrome: 'síndrome',
  cid: 'CID',
  agente: 'agente',
  notificadoEm: 'data da notificação',
  esp: 'ESP',
  primeirosSintomasEm: 'primeiros sintomas',
  casos: 'nº de casos',
  localInicial: 'local inicial',
  localInicialTexto: 'local inicial (outros)',
  local: 'local de ocorrência',
  investigacao: 'investigação',
  dta: 'bloco DTA',
};

/** Frase do evento da linha do tempo. */
export function textoEvento(e: Pick<EventoSurto, 'tipo' | 'dados'>): string {
  const p = e.dados as Record<string, unknown>;
  const s = (k: string) => (p[k] === null || p[k] === undefined ? '' : String(p[k]));
  switch (e.tipo) {
    case 'CRIADO': {
      const cat = CATEGORIA_SURTO[s('categoria') as CategoriaSurto];
      return `Surto notificado${cat ? ` (${cat})` : ''}${s('casos') ? `, ${s('casos')} caso(s) informado(s)` : ''}${p.assinatura ? ', a partir de uma sugestão' : ''}.`;
    }
    case 'EDITADO':
    case 'INVESTIGADO': {
      const campos = Array.isArray(p.campos) ? (p.campos as string[]).map((c) => CAMPO_EDITADO[c] ?? c) : [];
      const inv = e.tipo === 'INVESTIGADO' && s('investigadoEm') ? `Investigação em ${dataBr(s('investigadoEm'))}. ` : '';
      return `${inv}${campos.length ? `Alterado: ${campos.join(', ')}.` : 'Ficha alterada.'}`.trim();
    }
    case 'COMUNICADO':
      return `Comunicado à ${s('alvo')} por ${ROTULO_CANAL_COMUNICACAO[s('canal') as CorpoComunicacaoSurto['canal']]?.toLowerCase() ?? s('canal')}${s('contraparte') ? ` (${s('contraparte')})` : ''}${s('protocolo') ? `, protocolo ${s('protocolo')}` : ''}.`;
    case 'CASO_VINCULADO':
      return `Caso ${s('caso')} na planilha: ${s('notificacao') ? `notificação ${s('notificacao')}` : s('registro') ? `registro oficial ${s('registro')}` : 'linha manual'}.`;
    case 'CASO_RETIRADO':
      return `Caso ${s('caso')} retirado da planilha${s('notificacao') ? ` (notificação ${s('notificacao')})` : ''}.`;
    case 'ENCERRADO':
      return `Encerrado em ${dataBr(s('data'))}${DELIMITACAO_SURTO[s('delimitacao')] ? `; delimitação: ${DELIMITACAO_SURTO[s('delimitacao')]}` : ''}.`;
    case 'DESCARTADO':
      return `Descartado. Motivo: ${s('motivo')}`;
    case 'NUMERO_OFICIAL':
      return `Número do Sinan: ${s('numero')}${s('anterior') ? ` (antes: ${s('anterior')})` : ''}.`;
    default:
      return '';
  }
}

/** Critério do caso: código e rótulo do dicionário. */
export const textoCriterioCaso = (c: string | null) => (c ? `${c} - ${CRITERIO_CASO_SURTO[c] ?? '?'}` : '—');
