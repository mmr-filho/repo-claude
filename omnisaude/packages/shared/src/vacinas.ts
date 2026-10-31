import type { ComponenteVacinal } from './aps-indicadores';
import { CALENDARIO_VACINAL_0_24M, TOLERANCIA_VACINA_DIAS } from './aps-programas';

/**
 * Calendário Nacional de Vacinação (PNI) por idade, grupo e estratégia, e o aprazamento das doses de uma
 * pessoa a partir das doses já aplicadas. As regras cobrem a rotina da criança, do adolescente, do adulto,
 * da pessoa idosa e da gestante, mais as campanhas anuais (influenza e covid-19 nos grupos prioritários).
 */

export type GrupoCalendario = 'CRIANCA' | 'ADOLESCENTE' | 'ADULTO' | 'IDOSO' | 'GESTANTE';
export type EstrategiaVacinal = 'ROTINA' | 'CAMPANHA';
export type SituacaoVacinal = 'APLICADA' | 'APRAZADA' | 'ATRASADA';

/** Códigos de estratégia do e-SUS (ficha de vacinação). */
export const ESTRATEGIA_CODIGO: Record<EstrategiaVacinal, string> = { ROTINA: '1', CAMPANHA: '5' };
/** Códigos de dose do e-SUS (tabela DOSE_VACINA). */
export const DOSE_CODIGO = { D1: '1', D2: '2', D3: '3', D4: '4', R1: '6', R2: '7', DOSE: '8', UNICA: '9' } as const;

export interface RegraCalendario {
  componente: ComponenteVacinal;
  rotulo: string;
  /** Número da dose do componente (reforços continuam a contagem). */
  dose: number;
  doseCodigo: string;
  grupo: GrupoCalendario;
  estrategia: EstrategiaVacinal;
  /** Idade mínima em meses (gestante: ignorada, usa semanas de gestação). */
  meses: number;
  idadeMaxMeses?: number;
  /** Intervalo mínimo desde a dose anterior do componente, em dias. */
  intervaloMinDias?: number;
  /** Doses repetidas: a próxima vence este número de meses depois da última. */
  periodicidadeMeses?: number;
  sexo?: 'F';
  /** Dose por gestação, a partir desta semana. */
  semanaGestacao?: number;
  /** Regra de esquema adulto (dT): 3 doses se não houver histórico, depois reforço a cada 10 anos. */
  esquemaAdulto?: boolean;
}

const doseCodigoCrianca = (componente: ComponenteVacinal, dose: number): string => {
  if (componente === 'BCG' || componente === 'FEBRE_AMARELA' || componente === 'VARICELA' || componente === 'HEPA') return dose === 1 ? DOSE_CODIGO.UNICA : DOSE_CODIGO.D2;
  if (componente === 'DTP' || componente === 'VIP') return dose <= 3 ? String(dose) : dose === 4 ? DOSE_CODIGO.R1 : DOSE_CODIGO.R2;
  if (componente === 'PNEUMO' || componente === 'MENINGO_C') return dose <= 2 ? String(dose) : DOSE_CODIGO.R1;
  return String(dose);
};

/** Idade máxima (meses) em que a dose infantil ainda é indicada; depois disso vale o esquema do adulto ou a dose deixa de ser indicada. */
const idadeMaxCrianca = (componente: ComponenteVacinal, dose: number): number | undefined => {
  switch (componente) {
    case 'BCG':
    case 'VIP':
    case 'PNEUMO':
    case 'MENINGO_C':
    case 'HEPA':
      return 59;
    case 'HEPB':
    case 'DTP':
    case 'VARICELA':
      return 83;
    case 'ROTA':
      return dose === 1 ? 3 : 7;
    case 'FEBRE_AMARELA':
      return 719;
    case 'SCR':
      return dose === 2 ? 359 : 719;
    default:
      return undefined;
  }
};

const CRIANCA_0_24M: RegraCalendario[] = CALENDARIO_VACINAL_0_24M.map((d) => ({
  componente: d.componente,
  rotulo: d.rotulo,
  dose: d.dose,
  doseCodigo: doseCodigoCrianca(d.componente, d.dose),
  grupo: 'CRIANCA',
  estrategia: 'ROTINA',
  meses: d.meses,
  intervaloMinDias: d.componente === 'SCR' ? 30 : d.dose > 1 ? 30 : undefined,
  ...(idadeMaxCrianca(d.componente, d.dose) !== undefined ? { idadeMaxMeses: idadeMaxCrianca(d.componente, d.dose) } : {}),
}));

export const CALENDARIO_NACIONAL: RegraCalendario[] = [
  ...CRIANCA_0_24M,
  { componente: 'DTP', rotulo: 'DTP 2º reforço', dose: 5, doseCodigo: DOSE_CODIGO.R2, grupo: 'CRIANCA', estrategia: 'ROTINA', meses: 48, idadeMaxMeses: 83, intervaloMinDias: 180 },
  { componente: 'VIP', rotulo: 'Poliomielite inativada 2º reforço', dose: 5, doseCodigo: DOSE_CODIGO.R2, grupo: 'CRIANCA', estrategia: 'ROTINA', meses: 48, idadeMaxMeses: 59, intervaloMinDias: 180 },
  { componente: 'FEBRE_AMARELA', rotulo: 'Febre amarela reforço', dose: 2, doseCodigo: DOSE_CODIGO.R1, grupo: 'CRIANCA', estrategia: 'ROTINA', meses: 48, idadeMaxMeses: 59, intervaloMinDias: 30 },
  { componente: 'VARICELA', rotulo: 'Varicela 2ª dose', dose: 2, doseCodigo: DOSE_CODIGO.D2, grupo: 'CRIANCA', estrategia: 'ROTINA', meses: 48, idadeMaxMeses: 83, intervaloMinDias: 30 },
  { componente: 'HPV', rotulo: 'HPV (dose única)', dose: 1, doseCodigo: DOSE_CODIGO.UNICA, grupo: 'ADOLESCENTE', estrategia: 'ROTINA', meses: 108, idadeMaxMeses: 179 },
  { componente: 'MENINGO_ACWY', rotulo: 'Meningocócica ACWY (adolescente)', dose: 1, doseCodigo: DOSE_CODIGO.UNICA, grupo: 'ADOLESCENTE', estrategia: 'ROTINA', meses: 132, idadeMaxMeses: 179 },
  { componente: 'HEPB', rotulo: 'Hepatite B (esquema do adulto) 1ª dose', dose: 1, doseCodigo: DOSE_CODIGO.D1, grupo: 'ADULTO', estrategia: 'ROTINA', meses: 84 },
  { componente: 'HEPB', rotulo: 'Hepatite B 2ª dose', dose: 2, doseCodigo: DOSE_CODIGO.D2, grupo: 'ADULTO', estrategia: 'ROTINA', meses: 84, intervaloMinDias: 30 },
  { componente: 'HEPB', rotulo: 'Hepatite B 3ª dose', dose: 3, doseCodigo: DOSE_CODIGO.D3, grupo: 'ADULTO', estrategia: 'ROTINA', meses: 84, intervaloMinDias: 120 },
  { componente: 'DT', rotulo: 'Difteria e tétano (dT)', dose: 0, doseCodigo: DOSE_CODIGO.R1, grupo: 'ADULTO', estrategia: 'ROTINA', meses: 84, esquemaAdulto: true },
  {
    componente: 'INFLUENZA',
    rotulo: 'Influenza (campanha anual, crianças de 6 meses a 5 anos)',
    dose: 0,
    doseCodigo: DOSE_CODIGO.DOSE,
    grupo: 'CRIANCA',
    estrategia: 'CAMPANHA',
    meses: 6,
    idadeMaxMeses: 71,
    periodicidadeMeses: 12,
  },
  { componente: 'INFLUENZA', rotulo: 'Influenza (campanha anual, pessoa idosa)', dose: 0, doseCodigo: DOSE_CODIGO.DOSE, grupo: 'IDOSO', estrategia: 'CAMPANHA', meses: 720, periodicidadeMeses: 12 },
  { componente: 'COVID', rotulo: 'Covid-19 1ª dose (6 meses a 4 anos)', dose: 1, doseCodigo: DOSE_CODIGO.D1, grupo: 'CRIANCA', estrategia: 'ROTINA', meses: 6, idadeMaxMeses: 59 },
  { componente: 'COVID', rotulo: 'Covid-19 2ª dose (6 meses a 4 anos)', dose: 2, doseCodigo: DOSE_CODIGO.D2, grupo: 'CRIANCA', estrategia: 'ROTINA', meses: 7, idadeMaxMeses: 59, intervaloMinDias: 28 },
  { componente: 'COVID', rotulo: 'Covid-19 (campanha anual, pessoa idosa)', dose: 0, doseCodigo: DOSE_CODIGO.DOSE, grupo: 'IDOSO', estrategia: 'CAMPANHA', meses: 720, periodicidadeMeses: 12 },
  { componente: 'DTPA_ADULTO', rotulo: 'dTpa da gestante (a partir de 20 semanas)', dose: 1, doseCodigo: DOSE_CODIGO.UNICA, grupo: 'GESTANTE', estrategia: 'ROTINA', meses: 0, sexo: 'F', semanaGestacao: 20 },
  { componente: 'INFLUENZA', rotulo: 'Influenza da gestante (campanha)', dose: 0, doseCodigo: DOSE_CODIGO.DOSE, grupo: 'GESTANTE', estrategia: 'CAMPANHA', meses: 0, sexo: 'F', semanaGestacao: 0, periodicidadeMeses: 12 },
];

export const GRUPO_LABEL: Record<GrupoCalendario, string> = { CRIANCA: 'Criança', ADOLESCENTE: 'Adolescente', ADULTO: 'Adulto', IDOSO: 'Pessoa idosa', GESTANTE: 'Gestante' };
export const SITUACAO_VACINAL_LABEL: Record<SituacaoVacinal, string> = { APLICADA: 'Aplicada', APRAZADA: 'Aprazada', ATRASADA: 'Atrasada' };

export interface DoseAplicada {
  componentes: ComponenteVacinal[];
  at: Date;
}

export interface SituacaoDose {
  componente: ComponenteVacinal;
  rotulo: string;
  dose: number;
  doseCodigo: string;
  grupo: GrupoCalendario;
  estrategia: EstrategiaVacinal;
  situacao: SituacaoVacinal;
  /** Data prevista (AAAA-MM-DD) para as doses não aplicadas. */
  prevista: string | null;
  aplicadaEm: string | null;
}

const DIA = 86_400_000;
const MES = 30.4375 * DIA;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDias = (d: Date, n: number) => new Date(d.getTime() + n * DIA);
const addMeses = (d: Date, n: number) => new Date(d.getTime() + n * MES);
const mesesEntre = (de: Date, ate: Date) => (ate.getTime() - de.getTime()) / MES;

/** Datas válidas de um componente, respeitando o intervalo mínimo entre doses. */
function datasDoComponente(doses: DoseAplicada[], componente: ComponenteVacinal, intervaloMin = 30, minimo?: Date): Date[] {
  const todas = doses
    .filter((d) => d.componentes.includes(componente) && (!minimo || d.at.getTime() >= minimo.getTime()))
    .map((d) => d.at)
    .sort((a, b) => a.getTime() - b.getTime());
  const validas: Date[] = [];
  for (const d of todas) {
    const ultima = validas[validas.length - 1];
    if (!ultima || d.getTime() - ultima.getTime() >= intervaloMin * DIA) validas.push(d);
  }
  return validas;
}

const situacaoPor = (prevista: Date, hoje: Date): SituacaoVacinal => (hoje.getTime() > prevista.getTime() + TOLERANCIA_VACINA_DIAS * DIA ? 'ATRASADA' : 'APRAZADA');

/**
 * Aprazamento: para cada regra aplicável à pessoa, se a dose já foi aplicada, está aprazada (com data) ou
 * atrasada. Inclui as doses dos próximos 24 meses para o cartão mostrar o que vem.
 */
export function aprazar(pessoa: { birthDate: Date; sex: string; gestacaoDum?: Date | null }, doses: DoseAplicada[], hoje: Date, horizonteMeses = 24): SituacaoDose[] {
  const idade = mesesEntre(pessoa.birthDate, hoje);
  const out: SituacaoDose[] = [];
  const dtContagem = datasDoComponente(doses, 'DT', 30).length + datasDoComponente(doses, 'DTP', 30).length + datasDoComponente(doses, 'DTPA_ADULTO', 30).length;
  /** Última dose pendente de cada componente: a seguinte só pode vir depois dela (mais o intervalo mínimo). */
  const pendente = new Map<string, Date>();
  for (const regra of CALENDARIO_NACIONAL) {
    if (regra.sexo && pessoa.sex !== regra.sexo) continue;
    if (regra.semanaGestacao !== undefined) {
      if (!pessoa.gestacaoDum) continue;
      const inicio = addDias(pessoa.gestacaoDum, regra.semanaGestacao * 7);
      const fim = addDias(pessoa.gestacaoDum, 294);
      const aplicada = datasDoComponente(doses, regra.componente, 1, inicio).find((d) => d.getTime() <= fim.getTime());
      const prevista = inicio.getTime() > hoje.getTime() ? inicio : hoje;
      out.push({ ...base(regra), situacao: aplicada ? 'APLICADA' : situacaoPor(inicio, hoje), prevista: aplicada ? null : iso(prevista), aplicadaEm: aplicada ? iso(aplicada) : null });
      continue;
    }
    if (regra.idadeMaxMeses !== undefined && idade > regra.idadeMaxMeses && !jaAplicada(regra, doses, pessoa)) continue;
    if (idade + horizonteMeses < regra.meses) continue;
    const datas = datasDoComponente(doses, regra.componente, regra.intervaloMinDias ?? 30, regra.componente === 'SCR' || regra.componente === 'VARICELA' ? addMeses(pessoa.birthDate, 12) : undefined);
    if (regra.esquemaAdulto) {
      // dT: completa 3 doses (qualquer vacina com difteria e tétano conta) e depois reforço a cada 10 anos.
      const ultima = [...datasDoComponente(doses, 'DT', 30), ...datasDoComponente(doses, 'DTP', 30), ...datasDoComponente(doses, 'DTPA_ADULTO', 30)].sort((a, b) => b.getTime() - a.getTime())[0];
      if (idade < regra.meses) continue;
      if (dtContagem < 3) {
        const prevista = ultima ? addDias(ultima, 60) : addMeses(pessoa.birthDate, regra.meses);
        out.push({
          ...base(regra),
          rotulo: `dT ${dtContagem + 1}ª dose (esquema do adulto)`,
          dose: dtContagem + 1,
          doseCodigo: String(dtContagem + 1),
          situacao: situacaoPor(prevista, hoje),
          prevista: iso(prevista.getTime() < hoje.getTime() ? prevista : prevista),
          aplicadaEm: null,
        });
      } else {
        const prevista = addMeses(ultima!, 120);
        if (prevista.getTime() > addMeses(hoje, horizonteMeses).getTime()) {
          out.push({ ...base(regra), rotulo: 'dT reforço (a cada 10 anos)', situacao: 'APLICADA', prevista: iso(prevista), aplicadaEm: iso(ultima!) });
        } else out.push({ ...base(regra), rotulo: 'dT reforço (a cada 10 anos)', situacao: situacaoPor(prevista, hoje), prevista: iso(prevista), aplicadaEm: null });
      }
      continue;
    }
    if (regra.periodicidadeMeses) {
      if (idade < regra.meses) continue;
      const ultima = datas[datas.length - 1];
      const prevista = ultima ? addMeses(ultima, regra.periodicidadeMeses) : addMeses(pessoa.birthDate, regra.meses);
      const emDia = ultima !== undefined && prevista.getTime() > hoje.getTime();
      out.push({
        ...base(regra),
        situacao: emDia ? 'APLICADA' : situacaoPor(prevista, hoje),
        prevista: emDia ? iso(prevista) : iso(prevista.getTime() < hoje.getTime() ? prevista : prevista),
        aplicadaEm: ultima ? iso(ultima) : null,
      });
      continue;
    }
    const aplicada = datas[regra.dose - 1];
    if (aplicada) {
      out.push({ ...base(regra), situacao: 'APLICADA', prevista: null, aplicadaEm: iso(aplicada) });
      continue;
    }
    const anterior = datas[regra.dose - 2];
    const minimaPelaIdade = addMeses(pessoa.birthDate, regra.meses);
    const chave = `${regra.componente}|${regra.grupo}`;
    // Dose anterior ainda não aplicada: esta só vence depois da anterior (mais o intervalo mínimo).
    const referencia = anterior ?? (regra.dose > 1 ? pendente.get(chave) : undefined);
    const minimaPeloIntervalo = referencia && regra.intervaloMinDias ? addDias(referencia, regra.intervaloMinDias) : null;
    const prevista = minimaPeloIntervalo && minimaPeloIntervalo.getTime() > minimaPelaIdade.getTime() ? minimaPeloIntervalo : minimaPelaIdade;
    pendente.set(chave, prevista);
    out.push({ ...base(regra), situacao: situacaoPor(prevista, hoje), prevista: iso(prevista), aplicadaEm: null });
  }
  const ordem: Record<SituacaoVacinal, number> = { ATRASADA: 0, APRAZADA: 1, APLICADA: 2 };
  return out.sort((a, b) => ordem[a.situacao] - ordem[b.situacao] || (a.prevista ?? a.aplicadaEm ?? '').localeCompare(b.prevista ?? b.aplicadaEm ?? ''));
}

function jaAplicada(regra: RegraCalendario, doses: DoseAplicada[], pessoa: { birthDate: Date }): boolean {
  if (regra.periodicidadeMeses || regra.esquemaAdulto) return false;
  return datasDoComponente(doses, regra.componente, regra.intervaloMinDias ?? 30, regra.componente === 'SCR' || regra.componente === 'VARICELA' ? addMeses(pessoa.birthDate, 12) : undefined).length >= regra.dose;
}

const base = (r: RegraCalendario) => ({ componente: r.componente, rotulo: r.rotulo, dose: r.dose, doseCodigo: r.doseCodigo, grupo: r.grupo, estrategia: r.estrategia });

/** Só a próxima dose pendente de cada componente (para o cartão e para a lista de faltosos). */
export function proximasDoses(situacoes: SituacaoDose[]): SituacaoDose[] {
  const vistos = new Set<string>();
  return situacoes.filter((s) => {
    if (s.situacao === 'APLICADA') return false;
    const k = `${s.componente}|${s.grupo}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}
