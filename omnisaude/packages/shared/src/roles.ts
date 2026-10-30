/**
 * Papéis operacionais (RBAC híbrido). A permissão vale para o contexto ativo da sessão:
 * Tenant_ID + Unidade_Fisica_ID + Papel_Ativo. Um mesmo profissional pode ter papéis diferentes em cada unidade.
 */

export const ROLES = [
  'RECEPCAO',
  'ENFERMAGEM',
  'MEDICO',
  'MULTIPROFISSIONAL',
  'SERVICO_SOCIAL',
  'NIR',
  'FARMACIA',
  'FATURAMENTO',
  'GESTOR',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  RECEPCAO: 'Recepção / Acolhimento',
  ENFERMAGEM: 'Enfermagem / Triagem',
  MEDICO: 'Corpo Clínico / Médico',
  MULTIPROFISSIONAL: 'Equipe Multiprofissional',
  SERVICO_SOCIAL: 'Serviço Social',
  NIR: 'Regulação Interna / NIR',
  FARMACIA: 'Farmácia',
  FATURAMENTO: 'Faturamento e Auditoria SUS',
  GESTOR: 'Gestor Executivo / Diretor Técnico',
};

export const PERMISSIONS = [
  'paciente.ler',
  'paciente.cadastrar',
  'paciente.ocr',
  'cadsus.consultar',
  'agenda.ler',
  'agenda.marcar',
  'agenda.gerir',
  'fila.emitir',
  'fila.chamar',
  'pulseira.emitir',
  'triagem.registrar',
  'prontuario.ler',
  'prontuario.evoluir',
  'prontuario.encerrar',
  'prescricao.emitir',
  'exame.solicitar',
  'odontograma.registrar',
  'busca_ativa.gerir',
  'leitos.ler',
  'leitos.gerir',
  'regulacao.solicitar',
  'estoque.ler',
  'estoque.movimentar',
  'nfe.importar',
  'unitarizacao.executar',
  'dispensacao.registrar',
  'controlados.relatorio',
  'administracao.registrar',
  'faturamento.ler',
  'faturamento.criticar',
  'faturamento.exportar',
  'sigtap.sincronizar',
  'bi.consultar',
  'gestao.paineis',
  'gestao.pautas',
  'parametros.gerir',
  'auditoria.ler',
  'pop.consultar',
  'pop.executar',
  'libras.acionar',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const COMMON: Permission[] = ['paciente.ler', 'pop.consultar', 'libras.acionar'];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  RECEPCAO: [
    ...COMMON,
    'paciente.cadastrar',
    'paciente.ocr',
    'cadsus.consultar',
    'agenda.ler',
    'agenda.marcar',
    'fila.emitir',
    'fila.chamar',
    'pulseira.emitir',
  ],
  ENFERMAGEM: [
    ...COMMON,
    'cadsus.consultar',
    'fila.chamar',
    'pulseira.emitir',
    'triagem.registrar',
    'prontuario.ler',
    'prontuario.evoluir',
    'administracao.registrar',
    'estoque.ler',
    'leitos.ler',
    'pop.executar',
  ],
  MEDICO: [
    ...COMMON,
    'agenda.ler',
    'fila.chamar',
    'prontuario.ler',
    'prontuario.evoluir',
    'prontuario.encerrar',
    'prescricao.emitir',
    'exame.solicitar',
    'leitos.ler',
    'regulacao.solicitar',
    'pop.executar',
  ],
  MULTIPROFISSIONAL: [
    ...COMMON,
    'agenda.ler',
    'fila.chamar',
    'prontuario.ler',
    'prontuario.evoluir',
    'prontuario.encerrar',
    'exame.solicitar',
    'odontograma.registrar',
  ],
  SERVICO_SOCIAL: [
    ...COMMON,
    'agenda.ler',
    'agenda.marcar',
    'prontuario.ler',
    'prontuario.evoluir',
    'busca_ativa.gerir',
  ],
  NIR: [...COMMON, 'prontuario.ler', 'leitos.ler', 'leitos.gerir', 'regulacao.solicitar'],
  FARMACIA: [
    ...COMMON,
    'prontuario.ler',
    'estoque.ler',
    'estoque.movimentar',
    'nfe.importar',
    'unitarizacao.executar',
    'dispensacao.registrar',
    'controlados.relatorio',
    'pop.executar',
  ],
  FATURAMENTO: [
    ...COMMON,
    'prontuario.ler',
    'faturamento.ler',
    'faturamento.criticar',
    'faturamento.exportar',
    'sigtap.sincronizar',
    'auditoria.ler',
  ],
  GESTOR: [
    ...COMMON,
    'agenda.ler',
    'agenda.gerir',
    'leitos.ler',
    'estoque.ler',
    'faturamento.ler',
    'busca_ativa.gerir',
    'bi.consultar',
    'gestao.paineis',
    'gestao.pautas',
    'parametros.gerir',
    'auditoria.ler',
  ],
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
