import type { TenantPrisma } from '@omnisaude/database';

/**
 * Um pré-cadastro do CNES vira um profissional com acesso: o registro fica VINCULADO e as participações em
 * equipe passam a apontar para o usuário.
 */
export async function linkStaged(tx: TenantPrisma.TransactionClient, stagedId: string, userId: string) {
  const staged = await tx.cnesProfessional.findUnique({ where: { id: stagedId }, include: { teamMembers: true } });
  if (!staged) return;
  await tx.cnesProfessional.update({ where: { id: stagedId }, data: { status: 'VINCULADO', userId } });
  for (const m of staged.teamMembers) {
    const already = await tx.teamMember.findFirst({ where: { teamId: m.teamId, userId } });
    if (already) await tx.teamMember.delete({ where: { id: m.id } });
    else await tx.teamMember.update({ where: { id: m.id }, data: { userId, stagedId: null } });
  }
}
