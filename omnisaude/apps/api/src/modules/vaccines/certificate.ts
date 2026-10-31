import type { TenantClient } from '@omnisaude/database';
import { ROLE_LABELS, type Role } from '@omnisaude/shared';
import { notFound } from '../../core/errors';
import { formatDate, formatDateTime, type DocumentModel } from '../signatures/pdf';

/**
 * Modelo do certificado de vacinação (PDF): doses aplicadas e transcritas, com lote, fabricante, unidade e
 * profissional. Usado sem assinatura (download) e com assinatura ICP-Brasil (módulo de assinaturas).
 */
export async function certificadoVacinacaoModel(
  db: TenantClient,
  input: { patientId: string; unitId: string; userId: string; role: Role; cbo: string; signer: { name: string; cpf: string }; issuedAt: Date; timeZone: string },
): Promise<DocumentModel> {
  const [patient, unit, user, assignment, doses] = await Promise.all([
    db.patient.findUnique({ where: { id: input.patientId } }),
    db.unit.findUniqueOrThrow({ where: { id: input.unitId } }),
    db.user.findUniqueOrThrow({ where: { id: input.userId }, select: { name: true, socialName: true } }),
    db.userAssignment.findFirst({ where: { userId: input.userId, unitId: input.unitId }, select: { council: true } }),
    db.vaccination.findMany({ where: { patientId: input.patientId }, orderBy: { appliedAt: 'asc' } }),
  ]);
  if (!patient) throw notFound('Paciente');
  const unidades = new Map((await db.unit.findMany({ where: { id: { in: [...new Set(doses.map((d) => d.unitId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const linhas = doses.map(
    (d) =>
      `${formatDate(d.appliedAt, input.timeZone)} · ${d.vaccineName} · ${d.dose} · lote ${d.lot} (${d.manufacturer}${d.expiry ? `, validade ${formatDate(d.expiry)}` : ''}) · ${d.route}${d.site ? `, ${d.site}` : ''} · ${d.transcription ? 'transcrita da caderneta' : (unidades.get(d.unitId) ?? 'unidade')}`,
  );
  return {
    title: 'Certificado de vacinação',
    unit: { name: unit.name, cnes: unit.cnes, address: unit.address },
    patient: { name: patient.socialName ?? patient.name, cpf: patient.cpf, cns: patient.cns, birthDate: patient.birthDate },
    professional: { name: user.socialName ?? user.name, council: assignment?.council ?? null, cbo: input.cbo, roleLabel: ROLE_LABELS[input.role] },
    issuedAt: input.issuedAt,
    timeZone: input.timeZone,
    sections: [
      { paragraphs: [`Certificamos que ${patient.socialName ?? patient.name} recebeu os imunobiológicos abaixo, conforme os registros do sistema de informação da unidade.`] },
      { heading: `Doses registradas (${doses.length})`, paragraphs: doses.length ? linhas : ['Nenhuma dose registrada.'] },
      {
        heading: 'Observações',
        paragraphs: ['Doses marcadas como transcritas foram registradas a partir da caderneta apresentada pelo cidadão. As demais foram aplicadas na rede e informadas à RNDS (Registro de Imunobiológico Administrado).'],
      },
    ],
    footer: [`Emitido em ${formatDateTime(input.issuedAt, input.timeZone)} por ${user.socialName ?? user.name} · ${unit.name} (CNES ${unit.cnes})`],
    signer: input.signer,
  };
}
