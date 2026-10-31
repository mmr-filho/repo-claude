import {
  CALENDARIO_VACINAL_0_24M,
  CBO_MEDICO_ENFERMEIRO_PREFIXOS,
  CONSULTAS_PUERICULTURA_MESES,
  ESTADO_NUTRICIONAL_LABEL,
  estadoNutricionalImc,
  intervaloPreNatalDias,
  SIGTAP_APS,
  TOLERANCIA_CONSULTA_PUERICULTURA_DIAS,
  TOLERANCIA_VACINA_DIAS,
  vigenciaBolsaFamilia,
  type CodigoPrograma,
  type LinhaBuscaAtiva,
  type TipoEstratificacao,
} from '@omnisaude/shared';
import { cadastradas, cronicos, cumpreC7, dosesValidas, gestacoes, idade, idosos, Indice, pontuarCronico, pontuarIdoso, praticasC7Aplicaveis, type DadosEquipe, type Pessoa } from '../indicators/indicators-calc';

/**
 * Listas dos programas da APS: quem está em acompanhamento, o que está em atraso e qual a próxima ação.
 * Reaproveita a apuração dos indicadores (as faltas pontuam nos indicadores) e acrescenta as ações
 * programáticas que o cofinanciamento não mede (agenda de consultas por idade, calendário vacinal,
 * estratificações, vigências do Bolsa Família, previsão de alta de TB/hanseníase).
 */

const DIA = 86_400_000;
const MES = 30.4375 * DIA;

export interface Estratificacao {
  patientId: string;
  kind: TipoEstratificacao;
  result: string;
  score: number | null;
  assessedAt: Date;
  nextDueAt: Date | null;
}

export type DadosPrograma = DadosEquipe & { estratificacoes: Estratificacao[] };

export interface Falta {
  codigo: string;
  descricao: string;
}

export interface LinhaPrograma {
  patientId: string;
  nome: string;
  idade: number;
  sexo: string;
  nascimento: string;
  situacao: string;
  faltas: Falta[];
  proximaAcao: string | null;
  linhas: LinhaBuscaAtiva[];
  estratificacao: { kind: TipoEstratificacao; result: string; assessedAt: string; nextDueAt: string | null } | null;
  /** Pontos das boas práticas do indicador correspondente, quando houver. */
  pontos?: number;
  maximo?: number;
}

export interface ResultadoPrograma {
  codigo: CodigoPrograma;
  populacao: number;
  faltosos: number;
  pessoas: LinhaPrograma[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDias = (d: Date, n: number) => new Date(d.getTime() + n * DIA);
const addMeses = (d: Date, n: number) => new Date(d.getTime() + n * MES);
const meses = (de: Date, ate: Date) => (ate.getTime() - de.getTime()) / MES;
const fmt = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
const ehMedEnf = (cbo: string) => CBO_MEDICO_ENFERMEIRO_PREFIXOS.some((p) => cbo.startsWith(p));

function ultimaEstratificacao(dados: DadosPrograma, patientId: string, kind: TipoEstratificacao, desde?: Date): Estratificacao | null {
  const lista = dados.estratificacoes.filter((e) => e.patientId === patientId && e.kind === kind && (!desde || e.assessedAt.getTime() >= desde.getTime())).sort((a, b) => b.assessedAt.getTime() - a.assessedAt.getTime());
  return lista[0] ?? null;
}

const viewEstrat = (e: Estratificacao | null) => (e ? { kind: e.kind, result: e.result, assessedAt: e.assessedAt.toISOString(), nextDueAt: e.nextDueAt ? iso(e.nextDueAt) : null } : null);

function linha(p: Pessoa, asOf: Date, extra: Omit<LinhaPrograma, 'patientId' | 'nome' | 'idade' | 'sexo' | 'nascimento'>): LinhaPrograma {
  return { patientId: p.id, nome: p.name, idade: idade(p, asOf), sexo: p.sex, nascimento: iso(p.birthDate), ...extra };
}

/** Doses em atraso do calendário até a idade atual da criança. */
export function vacinasEmAtraso(ix: Indice, p: Pessoa, asOf: Date): Falta[] {
  const idadeMeses = meses(p.birthDate, asOf);
  const faltas: Falta[] = [];
  const contagem = new Map<string, number>();
  for (const dose of CALENDARIO_VACINAL_0_24M) {
    if (idadeMeses * MES < dose.meses * MES + TOLERANCIA_VACINA_DIAS * DIA) continue;
    if (!contagem.has(dose.componente)) {
      const minimo = dose.componente === 'SCR' || dose.componente === 'VARICELA' ? addMeses(p.birthDate, 12) : null;
      contagem.set(dose.componente, dosesValidas(ix.vacinasCom(p.id, dose.componente, p.birthDate, asOf, asOf), minimo));
    }
    // Doses são sequenciais: cobra-se só a próxima dose em falta de cada componente.
    if ((contagem.get(dose.componente) ?? 0) === dose.dose - 1) faltas.push({ codigo: `VACINA_${dose.componente}_${dose.dose}`, descricao: `${dose.rotulo} (${dose.meses} meses)` });
  }
  return faltas;
}

function preNatal(ix: Indice, dados: DadosPrograma, asOf: Date): LinhaPrograma[] {
  const pessoas = new Map(cadastradas(dados.pessoas, asOf).map((p) => [p.id, p]));
  const out: LinhaPrograma[] = [];
  for (const g of gestacoes(ix)) {
    const p = pessoas.get(g.patientId);
    if (!p || g.dum.getTime() > asOf.getTime() || g.fimPuerperio.getTime() < asOf.getTime()) continue;
    const puerperio = asOf.getTime() > g.fimGestacao.getTime();
    const semanas = Math.floor((asOf.getTime() - g.dum.getTime()) / (7 * DIA));
    const consultas = ix
      .consultasMedEnf(p.id, g.dum, g.fimPuerperio, asOf)
      .map((c) => c.at.getTime())
      .sort((a, b) => a - b);
    const faltas: Falta[] = [];
    const risco = ultimaEstratificacao(dados, p.id, 'GESTANTE', g.dum);
    if (!puerperio) {
      const ultima = consultas.length ? new Date(consultas[consultas.length - 1]!) : null;
      const limite = intervaloPreNatalDias(semanas) + 7;
      if (!consultas.length && semanas > 12) faltas.push({ codigo: 'CAPTACAO', descricao: `Sem 1ª consulta (${semanas} semanas)` });
      else if (ultima && (asOf.getTime() - ultima.getTime()) / DIA > limite)
        faltas.push({ codigo: 'CONSULTA', descricao: `Consulta em atraso: última em ${fmt(ultima)}, intervalo de ${intervaloPreNatalDias(semanas)} dias` });
      if (consultas.length && !risco) faltas.push({ codigo: 'RISCO', descricao: 'Sem classificação de risco gestacional' });
      const t1 = [SIGTAP_APS.TESTES_SIFILIS, SIGTAP_APS.TESTES_HIV, SIGTAP_APS.TESTES_HEPATITE_B, SIGTAP_APS.TESTES_HEPATITE_C];
      if (semanas > 13 && !t1.every((codes) => ix.exame(p.id, codes, g.dum, g.fimGestacao, asOf))) faltas.push({ codigo: 'EXAMES_T1', descricao: 'Sífilis, HIV, hepatites B e C do 1º trimestre' });
      if (semanas > 30 && ![SIGTAP_APS.TESTES_SIFILIS, SIGTAP_APS.TESTES_HIV].every((codes) => ix.exame(p.id, codes, addDias(g.dum, 196), g.fimGestacao, asOf)))
        faltas.push({ codigo: 'EXAMES_T3', descricao: 'Sífilis e HIV do 3º trimestre' });
      if (semanas > 24 && !ix.vacinasCom(p.id, 'DTPA_ADULTO', addDias(g.dum, 140), g.fimGestacao, asOf).length) faltas.push({ codigo: 'DTPA', descricao: 'Vacina dTpa (a partir de 20 semanas)' });
      if (semanas > 20 && !(ix.consultas.get(p.id) ?? []).some((c) => !ehMedEnf(c.cbo) && c.kind === 'ODONTOGRAMA' && c.at.getTime() >= g.dum.getTime() && c.at.getTime() <= asOf.getTime())) {
        const odontoProd = (ix.procedimentos.get(p.id) ?? []).some((pr) => pr.cbo.startsWith('2232') && pr.at.getTime() >= g.dum.getTime() && pr.at.getTime() <= asOf.getTime());
        if (!odontoProd) faltas.push({ codigo: 'ODONTO', descricao: 'Atendimento odontológico na gestação' });
      }
    } else {
      const diasPuerperio = Math.floor((asOf.getTime() - g.fimGestacao.getTime()) / DIA);
      if (!ix.consultasMedEnf(p.id, g.fimGestacao, g.fimPuerperio, asOf).length && diasPuerperio > 10) faltas.push({ codigo: 'PUERPERIO', descricao: `Sem consulta puerperal (${diasPuerperio} dias após o desfecho)` });
    }
    const proximaAcao = puerperio
      ? faltas.length
        ? 'Consulta puerperal'
        : `Puerpério até ${fmt(g.fimPuerperio)}`
      : consultas.length
        ? `Próxima consulta até ${fmt(addDias(new Date(consultas[consultas.length - 1]!), intervaloPreNatalDias(semanas)))}`
        : 'Captar para a 1ª consulta';
    out.push(
      linha(p, asOf, {
        situacao: puerperio
          ? `Puerpério (desfecho ${g.desfechoRegistrado ? 'em ' + fmt(g.fimGestacao) : 'estimado em ' + fmt(g.fimGestacao)})`
          : `${semanas} semanas · DPP ${fmt(addDias(g.dum, 280))}${risco ? ` · ${risco.result === 'ALTO_RISCO' ? 'alto risco' : 'risco habitual'}` : ''}`,
        faltas,
        proximaAcao,
        linhas: ['GESTANTE'],
        estratificacao: viewEstrat(risco),
      }),
    );
  }
  return out;
}

function puericultura(ix: Indice, dados: DadosPrograma, asOf: Date): LinhaPrograma[] {
  const out: LinhaPrograma[] = [];
  for (const p of cadastradas(dados.pessoas, asOf)) {
    const idadeMeses = meses(p.birthDate, asOf);
    if (idadeMeses < 0 || idadeMeses >= 24) continue;
    const consultas = ix
      .consultasMedEnf(p.id, p.birthDate, asOf, asOf)
      .map((c) => c.at.getTime())
      .sort((a, b) => a - b);
    const faltas: Falta[] = [];
    const previstas = CONSULTAS_PUERICULTURA_MESES.filter((m) => idadeMeses * MES >= m * MES + TOLERANCIA_CONSULTA_PUERICULTURA_DIAS * DIA);
    if (consultas.length < previstas.length) faltas.push({ codigo: 'CONSULTA', descricao: `${consultas.length} de ${previstas.length} consultas previstas até esta idade` });
    const antropometria = ix.pesoAltura(p.id, addMeses(asOf, -6), asOf, asOf);
    if (idadeMeses >= 1 && !antropometria.length) faltas.push({ codigo: 'ANTROPOMETRIA', descricao: 'Sem peso e altura nos últimos 6 meses' });
    faltas.push(...vacinasEmAtraso(ix, p, asOf));
    const mchat = ultimaEstratificacao(dados, p.id, 'MCHAT');
    if (idadeMeses >= 16 && idadeMeses <= 30 && !mchat) faltas.push({ codigo: 'MCHAT', descricao: 'M-CHAT-R não aplicado (16 a 30 meses)' });
    const proxima = CONSULTAS_PUERICULTURA_MESES.find((m) => m > idadeMeses);
    out.push(
      linha(p, asOf, {
        situacao: `${Math.floor(idadeMeses)} meses · ${consultas.length} consulta(s)${mchat ? ` · M-CHAT ${mchat.result.toLowerCase()}` : ''}`,
        faltas,
        proximaAcao: proxima !== undefined ? `Consulta dos ${proxima} meses em ${fmt(addMeses(p.birthDate, proxima))}` : null,
        linhas: ['CRIANCA'],
        estratificacao: viewEstrat(mchat),
      }),
    );
  }
  return out;
}

function hasDm(ix: Indice, dados: DadosPrograma, asOf: Date): LinhaPrograma[] {
  const eAp = dados.team.typeCode === '76';
  const dm = new Set(cronicos(ix, 'C4', asOf).map((p) => p.id));
  const has = new Set(cronicos(ix, 'C5', asOf).map((p) => p.id));
  const out: LinhaPrograma[] = [];
  for (const p of cadastradas(dados.pessoas, asOf)) {
    const temDm = dm.has(p.id);
    const temHas = has.has(p.id);
    if (!temDm && !temHas) continue;
    const pt = temDm ? pontuarCronico('C4', ix, p, asOf, eAp) : pontuarCronico('C5', ix, p, asOf, eAp);
    // A estratificação do pé cobre a boa prática F (avaliação dos pés): a pendência aparece uma vez só.
    const faltas: Falta[] = pt.faltam.filter((bp) => bp.fonte !== 'SEM_FONTE' && !(temDm && bp.letra === 'F')).map((bp) => ({ codigo: bp.letra, descricao: bp.descricao }));
    const pe = temDm ? ultimaEstratificacao(dados, p.id, 'PE_DIABETICO') : null;
    if (temDm && (!pe || (pe.nextDueAt && pe.nextDueAt.getTime() < asOf.getTime())))
      faltas.push({ codigo: 'PE_RISCO', descricao: pe ? `Reavaliar o pé (grau ${pe.result}, prevista para ${fmt(pe.nextDueAt!)})` : 'Estratificar o risco do pé diabético' });
    const ultima = ix
      .consultasMedEnf(p.id, addMeses(asOf, -24), asOf, asOf)
      .map((c) => c.at.getTime())
      .sort((a, b) => b - a)[0];
    out.push(
      linha(p, asOf, {
        situacao: `${[temHas ? 'Hipertensão' : null, temDm ? 'Diabetes' : null].filter(Boolean).join(' + ')}${pe ? ` · pé grau ${pe.result}` : ''} · última consulta ${ultima ? fmt(new Date(ultima)) : 'sem registro'}`,
        faltas,
        proximaAcao: ultima ? `Consulta até ${fmt(addMeses(new Date(ultima), 6))}` : 'Agendar consulta',
        linhas: [temHas ? 'HIPERTENSAO' : null, temDm ? 'DIABETES' : null].filter((l): l is LinhaBuscaAtiva => l !== null),
        estratificacao: viewEstrat(pe),
        pontos: pt.pontos,
        maximo: pt.maximo,
      }),
    );
  }
  return out;
}

function idoso(ix: Indice, dados: DadosPrograma, asOf: Date): LinhaPrograma[] {
  const eAp = dados.team.typeCode === '76';
  return idosos(ix, asOf).map((p) => {
    const pt = pontuarIdoso(ix, p, asOf, eAp);
    const ultima = ix
      .consultasMedEnf(p.id, addMeses(asOf, -24), asOf, asOf)
      .map((c) => c.at.getTime())
      .sort((a, b) => b - a)[0];
    return linha(p, asOf, {
      situacao: `Última consulta ${ultima ? fmt(new Date(ultima)) : 'sem registro'}`,
      faltas: pt.faltam.filter((bp) => bp.fonte !== 'SEM_FONTE').map((bp) => ({ codigo: bp.letra, descricao: bp.descricao })),
      proximaAcao: ultima ? `Consulta até ${fmt(addMeses(new Date(ultima), 12))}` : 'Agendar consulta anual',
      linhas: ['IDOSO'],
      estratificacao: null,
      pontos: pt.pontos,
      maximo: pt.maximo,
    });
  });
}

function mulher(ix: Indice, dados: DadosPrograma, asOf: Date): LinhaPrograma[] {
  const out: LinhaPrograma[] = [];
  for (const p of cadastradas(dados.pessoas, asOf)) {
    const aplicaveis = praticasC7Aplicaveis(p, asOf);
    if (!aplicaveis.length) continue;
    const faltam = aplicaveis.filter((bp) => !cumpreC7(ix, p, bp, asOf));
    out.push(
      linha(p, asOf, {
        situacao: aplicaveis.map((bp) => ({ A: 'citopatológico', B: 'HPV', C: 'saúde sexual', D: 'mamografia' })[bp.letra] ?? bp.letra).join(' · '),
        faltas: faltam.map((bp) => ({ codigo: bp.letra, descricao: bp.descricao })),
        proximaAcao: faltam.length
          ? faltam.map((bp) => ({ A: 'Coletar citopatológico', B: 'Vacinar HPV', C: 'Consulta de saúde sexual e reprodutiva', D: 'Solicitar mamografia' })[bp.letra] ?? bp.letra).join(' · ')
          : null,
        linhas: ['MULHER'],
        estratificacao: null,
        pontos: aplicaveis.reduce((s, bp) => s + bp.pontos, 0) - faltam.reduce((s, bp) => s + bp.pontos, 0),
        maximo: aplicaveis.reduce((s, bp) => s + bp.pontos, 0),
      }),
    );
  }
  return out;
}

function bolsaFamilia(ix: Indice, dados: DadosPrograma, asOf: Date): LinhaPrograma[] {
  const vig = vigenciaBolsaFamilia(asOf);
  const gest = new Set(
    gestacoes(ix)
      .filter((g) => g.dum.getTime() <= asOf.getTime() && g.fimGestacao.getTime() >= asOf.getTime())
      .map((g) => g.patientId),
  );
  const out: LinhaPrograma[] = [];
  for (const p of cadastradas(dados.pessoas, asOf)) {
    if (!p.bolsaFamilia) continue;
    const anos = idade(p, asOf);
    const crianca = anos < 7;
    const gestante = gest.has(p.id);
    const mulherAcomp = p.sex === 'F' && anos >= 14 && anos <= 44;
    if (!crianca && !gestante && !mulherAcomp) continue;
    const faltas: Falta[] = [];
    if (!ix.pesoAltura(p.id, vig.inicio, vig.fim, asOf).length) faltas.push({ codigo: 'ANTROPOMETRIA', descricao: `Sem peso e altura na ${vig.semestre}ª vigência de ${vig.ano}` });
    if (crianca && meses(p.birthDate, asOf) < 24) faltas.push(...vacinasEmAtraso(ix, p, asOf));
    if (gestante && !ix.consultasMedEnf(p.id, addMeses(asOf, -1.5), asOf, asOf).length) faltas.push({ codigo: 'PRE_NATAL', descricao: 'Sem consulta de pré-natal nos últimos 45 dias' });
    out.push(
      linha(p, asOf, {
        situacao: `${crianca ? 'Criança' : gestante ? 'Gestante' : 'Mulher 14 a 44 anos'} · ${vig.semestre}ª vigência de ${vig.ano}`,
        faltas,
        proximaAcao: faltas.length ? 'Registrar o acompanhamento antes do fim da vigência' : `Próxima vigência a partir de ${fmt(addDias(vig.fim, 1))}`,
        linhas: ['BOLSA_FAMILIA'],
        estratificacao: null,
      }),
    );
  }
  return out;
}

function sisvan(ix: Indice, dados: DadosPrograma, asOf: Date): LinhaPrograma[] {
  const gest = new Set(
    gestacoes(ix)
      .filter((g) => g.dum.getTime() <= asOf.getTime() && g.fimGestacao.getTime() >= asOf.getTime())
      .map((g) => g.patientId),
  );
  const out: LinhaPrograma[] = [];
  for (const p of cadastradas(dados.pessoas, asOf)) {
    const anos = idade(p, asOf);
    const gestante = gest.has(p.id);
    const prioridade = anos < 5 || anos >= 60 || gestante;
    const ultimas = (ix.medicoes.get(p.id) ?? []).filter((m) => m.pesoAltura && m.at.getTime() <= asOf.getTime()).sort((a, b) => b.at.getTime() - a.at.getTime());
    const ultima = ultimas[0];
    if (!prioridade && !ultima) continue;
    const prazoMeses = anos < 5 ? 6 : gestante ? 1 : 12;
    const faltas: Falta[] = [];
    if (!ultima || ultima.at.getTime() < addMeses(asOf, -prazoMeses).getTime())
      faltas.push({ codigo: 'ANTROPOMETRIA', descricao: ultima ? `Última antropometria em ${fmt(ultima.at)} (prazo de ${prazoMeses} meses)` : 'Sem antropometria registrada' });
    let estado: string | null = null;
    if (ultima && ultima.peso && ultima.altura && anos >= 20 && !gestante) {
      const imc = ultima.peso / (ultima.altura / 100) ** 2;
      estado = `${ESTADO_NUTRICIONAL_LABEL[estadoNutricionalImc(imc, anos)] ?? ''} (IMC ${imc.toFixed(1)})`;
      if (estado.startsWith('Baixo peso') || estado.startsWith('Obesidade')) faltas.push({ codigo: 'ESTADO_NUTRICIONAL', descricao: `Estado nutricional de atenção: ${estado}` });
    }
    out.push(
      linha(p, asOf, {
        situacao: `${anos < 5 ? 'Criança' : gestante ? 'Gestante' : anos >= 60 ? 'Pessoa idosa' : 'Adulto'}${estado ? ` · ${estado}` : ''}${ultima ? ` · última medida ${fmt(ultima.at)}` : ''}`,
        faltas,
        proximaAcao: ultima ? `Antropometria até ${fmt(addMeses(ultima.at, prazoMeses))}` : 'Registrar peso e altura',
        linhas: ['SISVAN'],
        estratificacao: null,
      }),
    );
  }
  return out;
}

function tbHanseniase(ix: Indice, dados: DadosPrograma, asOf: Date): LinhaPrograma[] {
  const out: LinhaPrograma[] = [];
  for (const p of cadastradas(dados.pessoas, asOf)) {
    const conds = ix.condicoesAtivas(p.id, asOf).filter((c) => {
      const code = c.code.toUpperCase().replace('.', '');
      return c.lineOfCare === 'TUBERCULOSE' || c.lineOfCare === 'HANSENIASE' || /^A1[5-9]/.test(code) || /^A30/.test(code);
    });
    if (!conds.length) continue;
    const c = conds[0]!;
    const code = c.code.toUpperCase().replace('.', '');
    const hanseniase = c.lineOfCare === 'HANSENIASE' || /^A30/.test(code);
    const paucibacilar = /^A30[01]/.test(code);
    const inicio = c.onsetAt ?? c.recordedAt;
    const duracao = hanseniase ? (paucibacilar ? 6 : 12) : 6;
    const previsao = addMeses(inicio, duracao);
    const ultima = ix
      .consultasMedEnf(p.id, inicio, asOf, asOf)
      .map((x) => x.at.getTime())
      .sort((a, b) => b - a)[0];
    const faltas: Falta[] = [];
    if (!ultima || (asOf.getTime() - ultima) / DIA > 30)
      faltas.push({ codigo: 'CONSULTA', descricao: ultima ? `Sem consulta há ${Math.floor((asOf.getTime() - ultima) / DIA)} dias (acompanhamento mensal)` : 'Sem consulta desde o início do tratamento' });
    if (asOf.getTime() > addDias(previsao, 30).getTime()) faltas.push({ codigo: 'ALTA', descricao: `Tratamento além da previsão (${fmt(previsao)}): avaliar alta ou encerrar a condição` });
    out.push(
      linha(p, asOf, {
        situacao: `${hanseniase ? `Hanseníase ${paucibacilar ? 'paucibacilar' : 'multibacilar'}` : 'Tuberculose'} desde ${fmt(inicio)} · previsão de alta ${fmt(previsao)}`,
        faltas,
        proximaAcao: ultima ? `Consulta até ${fmt(addDias(new Date(ultima), 30))}` : 'Consulta de acompanhamento',
        linhas: [hanseniase ? 'HANSENIASE' : 'TUBERCULOSE'],
        estratificacao: null,
      }),
    );
  }
  return out;
}

export function listarPrograma(codigo: CodigoPrograma, dados: DadosPrograma, asOf: Date): ResultadoPrograma {
  const ix = new Indice(dados);
  const pessoas = (() => {
    switch (codigo) {
      case 'PRE_NATAL':
        return preNatal(ix, dados, asOf);
      case 'PUERICULTURA':
        return puericultura(ix, dados, asOf);
      case 'HAS_DM':
        return hasDm(ix, dados, asOf);
      case 'IDOSO':
        return idoso(ix, dados, asOf);
      case 'MULHER':
        return mulher(ix, dados, asOf);
      case 'BOLSA_FAMILIA':
        return bolsaFamilia(ix, dados, asOf);
      case 'SISVAN':
        return sisvan(ix, dados, asOf);
      case 'TB_HANSENIASE':
        return tbHanseniase(ix, dados, asOf);
      default:
        return [];
    }
  })();
  pessoas.sort((a, b) => b.faltas.length - a.faltas.length || a.nome.localeCompare(b.nome, 'pt-BR'));
  return { codigo, populacao: pessoas.length, faltosos: pessoas.filter((p) => p.faltas.length > 0).length, pessoas };
}
