import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient as TenantClient } from '../generated/tenant/client';
import { hashPassword } from '../passwords';
import { DEMO_PASSWORD, DEMO_TENANT, STAFF, UNITS } from './fixtures';

export interface ComplementoDemo {
  unidades: string[];
  profissionais: string[];
  lotacoes: string[];
}

/**
 * Completa uma instituição de demonstração já populada com as unidades, os profissionais e as lotações que a carga atual
 * cria e que faltam nela. A carga só roda em instituição vazia, e a demonstração ganha pessoas novas ao longo das semanas:
 * sem isto, o ambiente publicado ficava sem os acessos novos da tabela do README. Só cria e inclui: não muda nome, senha
 * nem lotação de quem já existe, e não recria o que foi desativado (unidade, pessoa ou lotação que já existe fica como está).
 */
export async function completarDemo(db: TenantClient): Promise<ComplementoDemo> {
  const feito: ComplementoDemo = { unidades: [], profissionais: [], lotacoes: [] };
  const unidades = await db.unit.findMany({ select: { id: true, cnes: true, ibgeCode: true } });
  const porCnes = new Map(unidades.map((u) => [u.cnes, u.id]));
  const ibge = unidades[0]?.ibgeCode ?? DEMO_TENANT.ibgeCode;
  for (const u of UNITS) {
    if (porCnes.has(u.cnes)) continue;
    const criada = await db.unit.create({ data: { cnes: u.cnes, name: u.name, type: u.type, ibgeCode: ibge } });
    porCnes.set(u.cnes, criada.id);
    feito.unidades.push(u.name);
  }
  const unitId = (key: string) => porCnes.get(UNITS.find((u) => u.key === key)!.cnes)!;
  let passwordHash: string | undefined;
  for (const s of STAFF) {
    const existente = await db.user.findUnique({ where: { cpf: s.cpf }, select: { id: true, assignments: { select: { unitId: true, role: true } } } });
    if (!existente) {
      passwordHash ??= await hashPassword(DEMO_PASSWORD);
      await db.user.create({
        data: {
          cpf: s.cpf,
          cns: s.cns,
          name: s.name,
          email: `${s.key}@demo.omnisaude.dev`,
          passwordHash,
          assignments: { create: s.assignments.map((a) => ({ unitId: unitId(a.unit), role: a.role, cbo: a.cbo, council: s.council ?? null })) },
        },
      });
      feito.profissionais.push(s.name);
      continue;
    }
    for (const a of s.assignments) {
      const id = unitId(a.unit);
      if (existente.assignments.some((x) => x.unitId === id && x.role === a.role)) continue;
      await db.userAssignment.create({ data: { userId: existente.id, unitId: id, role: a.role, cbo: a.cbo, council: s.council ?? null } });
      feito.lotacoes.push(`${s.name} (${a.role})`);
    }
  }
  return feito;
}

/** Abre o banco da instituição de demonstração, completa e fecha. */
export async function completarDemoNoBanco(connectionString: string): Promise<ComplementoDemo> {
  const db = new TenantClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    return await completarDemo(db);
  } finally {
    await db.$disconnect();
  }
}
