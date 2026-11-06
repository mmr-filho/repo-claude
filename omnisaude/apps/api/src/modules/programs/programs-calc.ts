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
import {
  cadastradas,
  cronicos,
  cumpreC7,
  diaDe,
  diasEntre,
  dosesValidas,
  gestacoes,
  idosos,
  Indice,
  maisDias,
  maisMeses,
  mesesCompletos,
  pontuarCronico,
  pontuarIdoso,
  praticasC7Aplicaveis,
  type DadosEquipe,
  type Pessoa,
} from '../indicators/indicators-calc';

/**
 * Listas dos programas da APS: quem está em acompanhamento, o que está em atraso e qual a próxima ação.
 * Reaproveita a apuração dos indicadores (as faltas pontuam nos indicadores) e acrescenta as ações
 * programáticas que o cofinanciamento não mede (agenda de consultas por idade, calendário vacinal,
 * estratificações, vigências do Bolsa Família, previsão de alta de TB/hanseníase).
 *
 * Idades, marcos (30 dias, meses de vida, previsões) e datas exibidas seguem o dia do calendário da instituição
 * (`ix.cal`, fuso do tenant), como nos indicadores: um registro das 22h aparece com a data local, não a de UTC.
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

const addMeses = (d: Date, n: number) => new Date(d.getTime() + n * MES);
/** Data sem hora (AAAA-MM-DD) como DD/MM/AAAA. */
const fmtDia = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}/${dia.slice(0, 4)}`;
/** Dia local de um instante, como DD/MM/AAAA. */
const fmtLocal = (ix: Indice, at: Date | number) => fmtDia(ix.cal.dia(new Date(at)));
/** Dia em que a criança completa `m` meses de vida; frações de mês (0,25: 1ª semana) contam em dias. */
const marco = (nasc: string, m: number) => (Number.isInteger(m) ? maisMeses(nasc, m) : maisDias(nasc, Math.floor((m * MES) / DIA)));
const ehMedEnf = (cbo: string) => CBO_MEDICO_ENFERMEIRO_PREFIXOS.some((p) => cbo.startsWith(p));

function ultimaEstratificacao(dados: DadosPrograma, patientId: string, kind: TipoEstratificacao, desde?: Date): Estratificacao | null {
  const lista = dados.estratificacoes.filter((e) => e.patientId === patientId && e.kind === kind && (!desde || e.assessedAt.getTime() >= desde.getTime())).sort((a, b) => b.assessedAt.getTime() - a.assessedAt.getTime());
  return lista[0] ?? null;
}

const viewEstrat = (e: Estratificacao | null) => (e ? { kind: e.kind, result: e.result, assessedAt: e.assessedAt.toISOString(), nextDueAt: e.nextDueAt ? diaDe(e.nextDueAt) : null } : null);

function linha(ix: Indice, p: Pessoa, asOf: Date, extra: Omit<LinhaPrograma, 'patientId' | 'nome' | 'idade' | 'sexo' | 'nascimento'>): LinhaPrograma {
  return { patientId: p.id, nome: p.name, idade: ix.idade(p, asOf), sexo: p.sex, nascimento: diaDe(p.birthDate), ...extra };
}

/** Doses em atraso do calendário até a idade atual da criança (atrasada a partir do dia da idade recomendada + tolerância). */
export function vacinasEmAtraso(ix: Indice, p: Pessoa, asOf: Date): Falta[] {
  const nasc = diaDe(p.birthDate);
  const hoje = ix.cal.dia(asOf);
  const inicio = ix.cal.inicioDoDia(nasc);
  const faltas: Falta[] = [];
  const contagem = new Map<string, number>();
  for (const dose of CALENDARIO_VACINAL_0_24M) {
    if (hoje < maisDias(maisMeses(nasc, dose.meses), TOLERANCIA_VACINA_DIAS)) continue;
    if (!contagem.has(dose.componente)) {
      // SCR e varicela contam a partir do dia em que a criança completa 12 meses, como no C2.
      const minimo = dose.componente === 'SCR' || dose.componente === 'VARICELA' ? ix.cal.inicioDoDia(maisMeses(nasc, 12)) : null;
      contagem.set(dose.componente, dosesValidas(ix.vacinasCom(p.id, dose.componente, inicio, asOf, asOf), minimo));
    }
    // Doses são sequenciais: cobra-se só a próxima dose em falta de cada componente.
    if ((contagem.get(dose.componente) ?? 0) === dose.dose - 1) faltas.push({ codigo: `VACINA_${dose.componente}_${dose.dose}`, descricao: `${dose.rotulo} (${dose.meses} meses)` });
  }
  return faltas;
}

function preNatal(ix: Indice, dados: DadosPrograma, asOf: Date): LinhaPrograma[] {
  const pessoas = new Map(cadastradas(dados.pessoas, asOf).map((p) => [p.id, p]));
  const hoje = ix.cal.dia(asOf);
  const out: LinhaPrograma[] = [];
  for (const g of gestacoes(ix)) {
    const p = pessoas.get(g.patientId);
    if (!p || g.dum > hoje || g.ultimoDiaPuerperio < hoje) continue;
    const puerperio = hoje >= g.desfecho;
    const semanas = Math.floor(diasEntre(g.dum, hoje) / 7);
    const consultas = ix
      .consultasMedEnf(p.id, g.inicioGestacao, g.fimPuerperio, asOf)
      .map((c) => c.at.getTime())
      .sort((a, b) => a - b);
    const faltas: Falta[] = [];
    const risco = ultimaEstratificacao(dados, p.id, 'GESTANTE', g.inicioGestacao);
    if (!puerperio) {
      const ultima = consultas.length ? new Date(consultas[consultas.length - 1]!) : null;
      const limite = intervaloPreNatalDias(semanas) + 7;
      if (!consultas.length && semanas > 12) faltas.push({ codigo: 'CAPTACAO', descricao: `Sem 1ª consulta (${semanas} semanas)` });
      else if (ultima && (asOf.getTime() - ultima.getTime()) / DIA > limite)
        faltas.push({ codigo: 'CONSULTA', descricao: `Consulta em atraso: última em ${fmtLocal(ix, ultima)}, intervalo de ${intervaloPreNatalDias(semanas)} dias` });
      if (consultas.length && !risco) faltas.push({ codigo: 'RISCO', descricao: 'Sem classificação de risco gestacional' });
      const t1 = [SIGTAP_APS.TESTES_SIFILIS, SIGTAP_APS.TESTES_HIV, SIGTAP_APS.TESTES_HEPATITE_B, SIGTAP_APS.TESTES_HEPATITE_C];
      if (semanas > 13 && !t1.every((codes) => ix.exame(p.id, codes, g.inicioGestacao, g.fimGestacao, asOf))) faltas.push({ codigo: 'EXAMES_T1', descricao: 'Sífilis, HIV, hepatites B e C do 1º trimestre' });
      if (semanas > 30 && ![SIGTAP_APS.TESTES_SIFILIS, SIGTAP_APS.TESTES_HIV].every((codes) => ix.exame(p.id, codes, ix.cal.inicioDoDia(maisDias(g.dum, 196)), g.fimGestacao, asOf)))
        faltas.push({ codigo: 'EXAMES_T3', descricao: 'Sífilis e HIV do 3º trimestre' });
      if (semanas > 24 && !ix.vacinasCom(p.id, 'DTPA_ADULTO', ix.cal.inicioDoDia(maisDias(g.dum, 140)), g.fimGestacao, asOf).length) faltas.push({ codigo: 'DTPA', descricao: 'Vacina dTpa (a partir de 20 semanas)' });
      if (semanas > 20 && !(ix.consultas.get(p.id) ?? []).some((c) => !ehMedEnf(c.cbo) && c.kind === 'ODONTOGRAMA' && c.at.getTime() >= g.inicioGestacao.getTime() && c.at.getTime() <= asOf.getTime())) {
        const odontoProd = (ix.procedimentos.get(p.id) ?? []).some((pr) => pr.cbo.startsWith('2232') && pr.at.getTime() >= g.inicioGestacao.getTime() && pr.at.getTime() <= asOf.getTime());
        if (!odontoProd) faltas.push({ codigo: 'ODONTO', descricao: 'Atendimento odontológico na gestação' });
      }
    } else {
      const diasPuerperio = diasEntre(g.desfecho, hoje);
      if (!ix.consultasMedEnf(p.id, g.inicioPuerperio, g.fimPuerperio, asOf).length && diasPuerperio > 10)
        faltas.push({ codigo: 'PUERPERIO', descricao: `Sem consulta puerperal (${diasPuerperio} dias após o desfecho)` });
      if (!ix.visitasEm(p.id, g.inicioPuerperio, g.fimPuerperio, asOf).length && diasPuerperio > 10) faltas.push({ codigo: 'VISITA', descricao: 'Sem visita do ACS no puerpério' });
    }
    // Visitas do ACS na gestação: 3 após a 1ª consulta (boa prática E do C3); cobra-se a partir da 20ª semana.
    if (!puerperio && consultas.length && semanas > 20) {
      const visitas = ix.visitasEm(p.id, new Date(consultas[0]!), g.fimGestacao, asOf).length;
      if (visitas < 3) faltas.push({ codigo: 'VISITA', descricao: `${visitas} de 3 visitas do ACS desde a 1ª consulta de pré-natal` });
    }
    const proximaAcao = puerperio
      ? faltas.length
        ? 'Consulta puerperal'
        : `Puerpério até ${fmtDia(g.ultimoDiaPuerperio)}`
      : consultas.length
        ? `Próxima consulta até ${fmtDia(maisDias(ix.cal.dia(new Date(consultas[consultas.length - 1]!)), intervaloPreNatalDias(semanas)))}`
        : 'Captar para a 1ª consulta';
    out.push(
      linha(ix, p, asOf, {
        situacao: puerperio
          ? `Puerpério (desfecho ${g.desfechoRegistrado ? 'em ' + fmtDia(g.desfecho) : 'estimado em ' + fmtDia(g.desfecho)})`
          : `${semanas} semanas · DPP ${fmtDia(maisDias(g.dum, 280))}${risco ? ` · ${risco.result === 'ALTO_RISCO' ? 'alto risco' : 'risco habitual'}` : ''}`,
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
  const hoje = ix.cal.dia(asOf);
  const out: LinhaPrograma[] = [];
  for (const p of cadastradas(dados.pessoas, asOf)) {
    const nasc = diaDe(p.birthDate);
    // Acompanhada do nascimento até a véspera do segundo aniversário.
    if (nasc > hoje || hoje >= maisMeses(nasc, 24)) continue;
    const completou = (m: number) => hoje >= marco(nasc, m);
    const inicio = ix.cal.inicioDoDia(nasc);
    const consultas = ix
      .consultasMedEnf(p.id, inicio, asOf, asOf)
      .map((c) => c.at.getTime())
      .sort((a, b) => a - b);
    const faltas: Falta[] = [];
    const previstas = CONSULTAS_PUERICULTURA_MESES.filter((m) => hoje >= maisDias(marco(nasc, m), TOLERANCIA_CONSULTA_PUERICULTURA_DIAS));
    if (consultas.length < previstas.length) faltas.push({ codigo: 'CONSULTA', descricao: `${consultas.length} de ${previstas.length} consultas previstas até esta idade` });
    const antropometria = ix.pesoAltura(p.id, addMeses(asOf, -6), asOf, asOf);
    if (completou(1) && !antropometria.length) faltas.push({ codigo: 'ANTROPOMETRIA', descricao: 'Sem peso e altura nos últimos 6 meses' });
    faltas.push(...vacinasEmAtraso(ix, p, asOf));
    // Visitas do ACS: a 1ª até 30 dias e a 2ª até 6 meses de vida (boa prática D do C2, com os mesmos limites).
    const visitas = ix.visitasEm(p.id, inicio, asOf, asOf);
    const ate30Dias = ix.cal.fimDoDia(maisDias(nasc, 30)).getTime();
    const ate6Meses = ix.cal.fimDoDia(maisMeses(nasc, 6)).getTime();
    if (completou(1) && !visitas.some((d) => d.getTime() <= ate30Dias)) faltas.push({ codigo: 'VISITA', descricao: 'Sem visita do ACS no 1º mês de vida' });
    else if (completou(7) && visitas.filter((d) => d.getTime() <= ate6Meses).length < 2) faltas.push({ codigo: 'VISITA', descricao: 'Menos de 2 visitas do ACS até os 6 meses' });
    const mchat = ultimaEstratificacao(dados, p.id, 'MCHAT');
    if (completou(16) && hoje <= maisMeses(nasc, 30) && !mchat) faltas.push({ codigo: 'MCHAT', descricao: 'M-CHAT-R não aplicado (16 a 30 meses)' });
    const proxima = CONSULTAS_PUERICULTURA_MESES.find((m) => !completou(m));
    out.push(
      linha(ix, p, asOf, {
        situacao: `${mesesCompletos(nasc, hoje)} meses · ${consultas.length} consulta(s)${mchat ? ` · M-CHAT ${mchat.result.toLowerCase()}` : ''}`,
        faltas,
        proximaAcao: proxima !== undefined ? `Consulta dos ${proxima} meses em ${fmtDia(marco(nasc, proxima))}` : null,
        linhas: ['CRIANCA'],
        estratificacao: viewEstrat(mchat),
      }),
    );
  }
  return out;
}

function hasDm(ix: Indice, dados: DadosPrograma, asOf: Date): LinhaPrograma[] {
  const eAp = dados.team.typeCode === '76';
  const hoje = ix.cal.dia(asOf);
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
    // A reavaliação vence no dia previsto (data sem hora), no calendário da instituição.
    const vencida = pe?.nextDueAt ? diaDe(pe.nextDueAt) <= hoje : false;
    if (temDm && (!pe || vencida)) faltas.push({ codigo: 'PE_RISCO', descricao: pe ? `Reavaliar o pé (grau ${pe.result}, prevista para ${fmtDia(diaDe(pe.nextDueAt!))})` : 'Estratificar o risco do pé diabético' });
    const ultima = ix
      .consultasMedEnf(p.id, addMeses(asOf, -24), asOf, asOf)
      .map((c) => c.at.getTime())
      .sort((a, b) => b - a)[0];
    out.push(
      linha(ix, p, asOf, {
        situacao: `${[temHas ? 'Hipertensão' : null, temDm ? 'Diabetes' : null].filter(Boolean).join(' + ')}${pe ? ` · pé grau ${pe.result}` : ''} · última consulta ${ultima ? fmtLocal(ix, ultima) : 'sem registro'}`,
        faltas,
        proximaAcao: ultima ? `Consulta até ${fmtDia(maisMeses(ix.cal.dia(new Date(ultima)), 6))}` : 'Agendar consulta',
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
    return linha(ix, p, asOf, {
      situacao: `Última consulta ${ultima ? fmtLocal(ix, ultima) : 'sem registro'}`,
      faltas: pt.faltam.filter((bp) => bp.fonte !== 'SEM_FONTE').map((bp) => ({ codigo: bp.letra, descricao: bp.descricao })),
      proximaAcao: ultima ? `Consulta até ${fmtDia(maisMeses(ix.cal.dia(new Date(ultima)), 12))}` : 'Agendar consulta anual',
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
    const aplicaveis = praticasC7Aplicaveis(ix, p, asOf);
    if (!aplicaveis.length) continue;
    const faltam = aplicaveis.filter((bp) => !cumpreC7(ix, p, bp, asOf));
    out.push(
      linha(ix, p, asOf, {
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
  const hoje = ix.cal.dia(asOf);
  // Vigência (semestre) pelo dia local; vale de 00:00 do primeiro dia a 23:59 do último, no fuso da instituição.
  const vig = vigenciaBolsaFamilia(new Date(hoje));
  const ultimoDiaVigencia = diaDe(vig.fim);
  const inicioVigencia = ix.cal.inicioDoDia(diaDe(vig.inicio));
  const fimVigencia = ix.cal.fimDoDia(ultimoDiaVigencia);
  const gest = new Set(
    gestacoes(ix)
      .filter((g) => g.inicioGestacao.getTime() <= asOf.getTime() && g.fimGestacao.getTime() >= asOf.getTime())
      .map((g) => g.patientId),
  );
  const out: LinhaPrograma[] = [];
  for (const p of cadastradas(dados.pessoas, asOf)) {
    if (!p.bolsaFamilia) continue;
    const anos = ix.idade(p, asOf);
    const crianca = anos < 7;
    const gestante = gest.has(p.id);
    const mulherAcomp = p.sex === 'F' && anos >= 14 && anos <= 44;
    if (!crianca && !gestante && !mulherAcomp) continue;
    const faltas: Falta[] = [];
    if (!ix.pesoAltura(p.id, inicioVigencia, fimVigencia, asOf).length) faltas.push({ codigo: 'ANTROPOMETRIA', descricao: `Sem peso e altura na ${vig.semestre}ª vigência de ${vig.ano}` });
    if (crianca && hoje < maisMeses(diaDe(p.birthDate), 24)) faltas.push(...vacinasEmAtraso(ix, p, asOf));
    if (gestante && !ix.consultasMedEnf(p.id, addMeses(asOf, -1.5), asOf, asOf).length) faltas.push({ codigo: 'PRE_NATAL', descricao: 'Sem consulta de pré-natal nos últimos 45 dias' });
    out.push(
      linha(ix, p, asOf, {
        situacao: `${crianca ? 'Criança' : gestante ? 'Gestante' : 'Mulher 14 a 44 anos'} · ${vig.semestre}ª vigência de ${vig.ano}`,
        faltas,
        proximaAcao: faltas.length ? 'Registrar o acompanhamento antes do fim da vigência' : `Próxima vigência a partir de ${fmtDia(maisDias(ultimoDiaVigencia, 1))}`,
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
      .filter((g) => g.inicioGestacao.getTime() <= asOf.getTime() && g.fimGestacao.getTime() >= asOf.getTime())
      .map((g) => g.patientId),
  );
  const out: LinhaPrograma[] = [];
  for (const p of cadastradas(dados.pessoas, asOf)) {
    const anos = ix.idade(p, asOf);
    const gestante = gest.has(p.id);
    const prioridade = anos < 5 || anos >= 60 || gestante;
    const ultimas = (ix.medicoes.get(p.id) ?? []).filter((m) => m.pesoAltura && m.at.getTime() <= asOf.getTime()).sort((a, b) => b.at.getTime() - a.at.getTime());
    const ultima = ultimas[0];
    if (!prioridade && !ultima) continue;
    const prazoMeses = anos < 5 ? 6 : gestante ? 1 : 12;
    const faltas: Falta[] = [];
    if (!ultima || ultima.at.getTime() < addMeses(asOf, -prazoMeses).getTime())
      faltas.push({ codigo: 'ANTROPOMETRIA', descricao: ultima ? `Última antropometria em ${fmtLocal(ix, ultima.at)} (prazo de ${prazoMeses} meses)` : 'Sem antropometria registrada' });
    let estado: string | null = null;
    if (ultima && ultima.peso && ultima.altura && anos >= 20 && !gestante) {
      const imc = ultima.peso / (ultima.altura / 100) ** 2;
      estado = `${ESTADO_NUTRICIONAL_LABEL[estadoNutricionalImc(imc, anos)] ?? ''} (IMC ${imc.toFixed(1)})`;
      if (estado.startsWith('Baixo peso') || estado.startsWith('Obesidade')) faltas.push({ codigo: 'ESTADO_NUTRICIONAL', descricao: `Estado nutricional de atenção: ${estado}` });
    }
    out.push(
      linha(ix, p, asOf, {
        situacao: `${anos < 5 ? 'Criança' : gestante ? 'Gestante' : anos >= 60 ? 'Pessoa idosa' : 'Adulto'}${estado ? ` · ${estado}` : ''}${ultima ? ` · última medida ${fmtLocal(ix, ultima.at)}` : ''}`,
        faltas,
        proximaAcao: ultima ? `Antropometria até ${fmtDia(maisMeses(ix.cal.dia(ultima.at), prazoMeses))}` : 'Registrar peso e altura',
        linhas: ['SISVAN'],
        estratificacao: null,
      }),
    );
  }
  return out;
}

function tbHanseniase(ix: Indice, dados: DadosPrograma, asOf: Date): LinhaPrograma[] {
  const hoje = ix.cal.dia(asOf);
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
    // Início do tratamento: data sem hora da condição ou, sem ela, o dia local do registro.
    const inicio = c.onsetAt ? diaDe(c.onsetAt) : ix.cal.dia(c.recordedAt);
    const duracao = hanseniase ? (paucibacilar ? 6 : 12) : 6;
    const previsao = maisMeses(inicio, duracao);
    const ultima = ix
      .consultasMedEnf(p.id, ix.cal.inicioDoDia(inicio), asOf, asOf)
      .map((x) => x.at.getTime())
      .sort((a, b) => b - a)[0];
    const faltas: Falta[] = [];
    if (!ultima || (asOf.getTime() - ultima) / DIA > 30)
      faltas.push({ codigo: 'CONSULTA', descricao: ultima ? `Sem consulta há ${Math.floor((asOf.getTime() - ultima) / DIA)} dias (acompanhamento mensal)` : 'Sem consulta desde o início do tratamento' });
    if (hoje > maisDias(previsao, 30)) faltas.push({ codigo: 'ALTA', descricao: `Tratamento além da previsão (${fmtDia(previsao)}): avaliar alta ou encerrar a condição` });
    out.push(
      linha(ix, p, asOf, {
        situacao: `${hanseniase ? `Hanseníase ${paucibacilar ? 'paucibacilar' : 'multibacilar'}` : 'Tuberculose'} desde ${fmtDia(inicio)} · previsão de alta ${fmtDia(previsao)}`,
        faltas,
        proximaAcao: ultima ? `Consulta até ${fmtDia(maisDias(ix.cal.dia(new Date(ultima)), 30))}` : 'Consulta de acompanhamento',
        linhas: [hanseniase ? 'HANSENIASE' : 'TUBERCULOSE'],
        estratificacao: null,
      }),
    );
  }
  return out;
}

/** Lista de um programa no corte `asOf`; datas sem hora (nascimento, DUM) no calendário de `timeZone` (tenant). */
export function listarPrograma(codigo: CodigoPrograma, dados: DadosPrograma, asOf: Date, timeZone: string): ResultadoPrograma {
  const ix = new Indice(dados, timeZone);
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
