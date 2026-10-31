import { caraterMira, modalidadeMira, statusMiraAmbulatorial, statusMiraLeito, type FonteRegulacao, type StatusMira } from '@omnisaude/shared';
import { buildRegulationBundle, type FhirBundle, type ProblemInput, type RegulationDocumentInput } from '@omnisaude/fhir';
import type { SystemContext } from './messaging.service';

/** Carga gravada no outbox a cada mudança de situação da solicitação (o documento é montado na hora do envio). */
export interface RegulacaoOutboxPayload {
  fonte: FonteRegulacao;
  /** Situação do OmniSaúde no momento da transição e o evento (FALTOU vira "absence"). */
  status: string;
  evento?: string | null;
  /** Data/hora da alteração e unidade (CNES resolvido no envio) de quem alterou. */
  at: string;
  unitId: string;
  /** Sequência do documento para esta solicitação (identificador local). */
  sequencia?: number;
}

export class RegulacaoIncompleta extends Error {}

function cid(code: string | null | undefined): ProblemInput | undefined {
  if (!code) return undefined;
  const [system, value] = code.includes(':') ? code.split(':', 2) : ['CID10', code];
  return { system: system === 'CIAP2' ? 'CIAP2' : 'CID10', code: value!.toUpperCase().replace('.', '') };
}

/**
 * Monta o Registro de Regulação Assistencial (RIRA) de uma solicitação ambulatorial ou de vaga de leito a
 * partir do estado atual no banco e da carga do outbox. Os CNES vêm das unidades; o autor é a central
 * reguladora configurada (ou a unidade que alterou a situação).
 */
export async function montarRegulacaoRnds(
  sys: SystemContext,
  aggregateId: string,
  payload: RegulacaoOutboxPayload,
  meta: { rndsRequesterId: string; localId: string; regulatorCnes?: string; replaces?: string },
): Promise<FhirBundle> {
  const units = new Map((await sys.db.unit.findMany({ select: { id: true, cnes: true, name: true } })).map((u) => [u.id, u]));
  const unit = (id: string | null | undefined) => {
    const u = id ? units.get(id) : undefined;
    if (!u) throw new RegulacaoIncompleta('Unidade da solicitação não encontrada');
    return { cnes: u.cnes, name: u.name };
  };
  const changedBy = unit(payload.unitId);
  const author = meta.regulatorCnes ? { cnes: meta.regulatorCnes } : changedBy;
  const regulator = meta.regulatorCnes ? { cnes: meta.regulatorCnes } : undefined;
  const statusChangedAt = new Date(payload.at);

  let input: Omit<RegulationDocumentInput, 'rndsRequesterId' | 'localId' | 'replaces'>;
  if (payload.fonte === 'LEITO') {
    const r = await sys.db.bedRequest.findUnique({
      where: { id: aggregateId },
      include: {
        patient: { select: { cpf: true, cns: true } },
        aihRequests: { where: { status: { in: ['PENDENTE', 'AUTORIZADA'] } }, select: { procedureCode: true, procedureName: true }, take: 1 },
        admission: { select: { admittedAt: true } },
      },
    });
    if (!r) throw new RegulacaoIncompleta('Solicitação de vaga não encontrada');
    const status: StatusMira = statusMiraLeito(payload.status as never);
    const procedure = r.procedureCode ?? r.aihRequests[0]?.procedureCode;
    if (!procedure) throw new RegulacaoIncompleta('Solicitação de vaga sem procedimento SIGTAP (informe na solicitação ou emita o laudo de AIH)');
    const quando = r.admission?.admittedAt ?? r.transferAt ?? r.decisionAt ?? statusChangedAt;
    input = {
      patient: { ...(r.patient.cpf ? { cpf: r.patient.cpf } : {}), ...(r.patient.cns ? { cns: r.patient.cns } : {}) },
      author,
      statusChangedBy: changedBy,
      status,
      statusChangedAt,
      modality: modalidadeMira('LEITO'),
      priority: caraterMira(r.priority),
      procedure: { sigtapCode: procedure, ...(r.aihRequests[0]?.procedureName ? { display: r.aihRequests[0].procedureName } : {}) },
      requester: unit(r.originUnitId),
      authoredOn: r.createdAt,
      ...(r.destinationUnitId ? { performer: unit(r.destinationUnitId) } : {}),
      regulator,
      reason: cid(r.cid),
      ...(r.destinationUnitId ? { appointment: { start: quando, created: r.decisionAt ?? undefined } } : {}),
      ...(status === 'attended' ? { occurrence: r.admission?.admittedAt ?? quando } : {}),
    };
  } else {
    const r = await sys.db.regulationRequest.findUnique({ where: { id: aggregateId }, include: { patient: { select: { cpf: true, cns: true } }, provider: { select: { unitId: true, cnes: true } } } });
    if (!r) throw new RegulacaoIncompleta('Solicitação de regulação não encontrada');
    const status = statusMiraAmbulatorial(payload.status as never, payload.evento);
    const executante = r.providerUnitId ? unit(r.providerUnitId) : r.provider?.cnes ? { cnes: r.provider.cnes } : undefined;
    const agendamento = r.scheduledAt ?? (status === 'absence' || status === 'attended' ? (r.decisionAt ?? statusChangedAt) : undefined);
    input = {
      patient: { ...(r.patient.cpf ? { cpf: r.patient.cpf } : {}), ...(r.patient.cns ? { cns: r.patient.cns } : {}) },
      author,
      statusChangedBy: changedBy,
      status,
      statusChangedAt,
      modality: modalidadeMira('AMBULATORIAL'),
      priority: caraterMira(r.priority),
      procedure: { sigtapCode: r.procedureCode, display: r.procedureName },
      requester: unit(r.unitId),
      authoredOn: r.createdAt,
      ...(executante ? { performer: executante } : {}),
      regulator,
      reason: cid(r.cid),
      ...(agendamento ? { appointment: { start: agendamento, end: new Date(agendamento.getTime() + 20 * 60_000), created: r.decisionAt ?? undefined } } : {}),
      ...(status === 'attended' || status === 'absence' ? { occurrence: status === 'attended' ? (r.closedAt ?? statusChangedAt) : (agendamento ?? statusChangedAt) } : {}),
    };
  }
  return buildRegulationBundle({ ...input, rndsRequesterId: meta.rndsRequesterId, localId: meta.localId, timestamp: new Date(), ...(meta.replaces ? { replaces: meta.replaces } : {}) });
}
