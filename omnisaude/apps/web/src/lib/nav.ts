import type { Permission } from '@omnisaude/shared';
import { Activity, BarChart3, BedDouble, BookOpenCheck, Building2, CalendarDays, ClipboardList, FileOutput, FileSearch, HeartPulse, Home, type LucideIcon, MessagesSquare, Pill, Receipt, ScanLine, Settings, Stethoscope, UserRoundSearch, Users } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Visível se o papel ativo tiver qualquer uma destas permissões (vazio = todos). */
  any: Permission[];
}

export const NAV: NavItem[] = [
  { href: '/inicio', label: 'Início', icon: Home, any: [] },
  { href: '/recepcao', label: 'Recepção', icon: Users, any: ['paciente.cadastrar', 'fila.emitir'] },
  { href: '/agenda', label: 'Agenda', icon: CalendarDays, any: ['agenda.ler'] },
  { href: '/triagem', label: 'Classificação de risco', icon: HeartPulse, any: ['triagem.registrar'] },
  { href: '/atendimentos', label: 'Atendimentos', icon: Stethoscope, any: ['prontuario.evoluir'] },
  { href: '/pacientes', label: 'Pacientes', icon: UserRoundSearch, any: ['prontuario.ler'] },
  { href: '/farmacia', label: 'Farmácia', icon: Pill, any: ['estoque.ler', 'dispensacao.registrar'] },
  { href: '/beira-leito', label: 'Beira-leito', icon: ScanLine, any: ['administracao.registrar'] },
  { href: '/leitos', label: 'Leitos (NIR)', icon: BedDouble, any: ['leitos.ler'] },
  { href: '/faturamento', label: 'Faturamento SUS', icon: Receipt, any: ['faturamento.ler'] },
  { href: '/esus', label: 'e-SUS APS', icon: FileOutput, any: ['esus.ler'] },
  { href: '/gestao', label: 'Gestão', icon: Activity, any: ['gestao.paineis'] },
  { href: '/bi', label: 'BI conversacional', icon: BarChart3, any: ['bi.consultar'] },
  { href: '/servico-social', label: 'Busca ativa', icon: MessagesSquare, any: ['busca_ativa.gerir'] },
  { href: '/pops', label: 'POPs', icon: BookOpenCheck, any: ['pop.consultar'] },
  { href: '/auditoria', label: 'Auditoria', icon: ClipboardList, any: ['auditoria.ler'] },
  { href: '/administracao', label: 'Administração', icon: Building2, any: ['cadastros.unidades', 'cadastros.profissionais', 'seguranca.gerir'] },
  { href: '/validar', label: 'Validar documento', icon: FileSearch, any: [] },
  { href: '/configuracoes', label: 'Minha conta', icon: Settings, any: [] },
];
