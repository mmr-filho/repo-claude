import type { TenantClient, TenantInfo } from '@omnisaude/database';
import { isValidCpf } from '@omnisaude/shared';

/** Endereço público do app do Ministério da Saúde (ex-Conecte SUS Cidadão). */
export const MEU_SUS_DIGITAL_URL = 'https://meususdigital.saude.gov.br/';

export interface ResumoMeuSusDigital {
  /** O que o cidadão precisa ter para os registros aparecerem no app do Ministério (identificação por CPF, via gov.br). */
  prontidao: { cpf: boolean; cns: boolean; rndsAtiva: boolean; pronto: boolean; pendencias: string[] };
  /** Registros deste cidadão enviados à RNDS por tipo (é deles que o Meu SUS Digital se alimenta). */
  enviados: { atendimentos: number; vacinas: number; dispensacoes: number; altas: number; regulacao: number; total: number };
  pendentes: number;
  falhas: number;
  ultimoEnvio: string | null;
  link: string;
}

/**
 * Compatibilidade com o Meu SUS Digital (CID-4): o app do Ministério mostra ao cidadão o que chegou à RNDS em
 * seu CPF. Aqui resumimos, por pessoa, o que já foi enviado (RAC, RIA, RDM, sumário de alta, regulação) e o
 * que impede os registros de aparecerem (sem CPF válido, sem CNS, RNDS desligada).
 */
export async function resumoMeuSusDigital(db: TenantClient, tenant: TenantInfo, patientId: string): Promise<ResumoMeuSusDigital> {
  const p = await db.patient.findUniqueOrThrow({ where: { id: patientId }, select: { cpf: true, cns: true } });
  // Cada tipo de documento aponta para um registro: RAC → registro clínico (SOAP); RIA → vacinação; RDM → dispensação;
  // sumário de alta → internação; regulação → solicitação ambulatorial ou de leito.
  const encontros = await db.encounter.findMany({ where: { patientId }, select: { id: true } });
  const [notas, vacinas, dispensacoes, internacoes, regulacoes, leitos] = await Promise.all([
    encontros.length ? db.clinicalNote.findMany({ where: { encounterId: { in: encontros.map((e) => e.id) } }, select: { id: true } }) : [],
    db.vaccination.findMany({ where: { patientId }, select: { id: true } }),
    db.dispensation.findMany({ where: { patientId }, select: { id: true } }),
    db.admission.findMany({ where: { patientId }, select: { id: true } }),
    db.regulationRequest.findMany({ where: { patientId }, select: { id: true } }),
    db.bedRequest.findMany({ where: { patientId }, select: { id: true } }),
  ]);
  const ids = [...notas, ...vacinas, ...dispensacoes, ...internacoes, ...regulacoes, ...leitos].map((r) => r.id);
  const outbox = ids.length
    ? await db.outboxMessage.findMany({
        where: { aggregateId: { in: ids }, kind: { in: ['RNDS_RAC', 'RNDS_IMUNIZACAO', 'RNDS_DISPENSACAO', 'RNDS_SUMARIO_ALTA', 'RNDS_REGULACAO'] } },
        select: { kind: true, status: true, sentAt: true },
      })
    : [];
  const enviados = outbox.filter((o) => o.status === 'ENVIADO');
  const conta = (kind: string) => enviados.filter((o) => o.kind === kind).length;
  const cpfOk = !!p.cpf && isValidCpf(p.cpf);
  const pendencias = [
    ...(cpfOk ? [] : ['Cadastro sem CPF válido: o Meu SUS Digital identifica a pessoa pelo CPF (conta gov.br).']),
    ...(p.cns ? [] : ['Cadastro sem CNS: confira no CADSUS pela recepção.']),
    ...(tenant.settings.rndsEnabled ? [] : ['Envio à RNDS desligado nesta instituição.']),
  ];
  const ultimo = enviados
    .map((o) => o.sentAt)
    .filter((d): d is Date => !!d)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return {
    prontidao: { cpf: cpfOk, cns: !!p.cns, rndsAtiva: tenant.settings.rndsEnabled, pronto: pendencias.length === 0, pendencias },
    enviados: {
      atendimentos: conta('RNDS_RAC'),
      vacinas: conta('RNDS_IMUNIZACAO'),
      dispensacoes: conta('RNDS_DISPENSACAO'),
      altas: conta('RNDS_SUMARIO_ALTA'),
      regulacao: conta('RNDS_REGULACAO'),
      total: enviados.length,
    },
    pendentes: outbox.filter((o) => o.status === 'PENDENTE').length,
    falhas: outbox.filter((o) => o.status === 'ERRO').length,
    ultimoEnvio: ultimo?.toISOString() ?? null,
    link: MEU_SUS_DIGITAL_URL,
  };
}
