'use client';

import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { NAV } from '@/lib/nav';
import { useSession } from '@/lib/session';

const DESCRIPTIONS: Record<string, string> = {
  '/recepcao': 'Cadastro com leitura de documentos, CADSUS, senhas e acolhimento.',
  '/agenda': 'Agendas eletivas, cotas, faltas, lista de espera e confirmações por WhatsApp.',
  '/triagem': 'Acolhimento com classificação de risco, sinais vitais e mapa da dor.',
  '/atendimentos': 'Fila por gravidade, prontuário SOAP com ditado e prescrição com copiloto.',
  '/pacientes': 'Linha do tempo única do paciente em toda a rede.',
  '/farmacia': 'NF-e, estoque, transferências, unitarização e dispensação.',
  '/beira-leito': 'Administração com leitura da pulseira e da dose (5 certos).',
  '/leitos': 'Censo de leitos em tempo real, internações e altas.',
  '/faturamento': 'SIGTAP, crítica pré-glosa e exportação BPA.',
  '/gestao': 'Produtividade, SLAs e pautas de reunião.',
  '/bi': 'Perguntas em linguagem natural sobre os dados da rede.',
  '/servico-social': 'Busca ativa humanizada de pacientes crônicos em atraso.',
  '/pops': 'Biblioteca de procedimentos operacionais padrão.',
  '/auditoria': 'Integridade da trilha de auditoria.',
  '/configuracoes': 'Senha e verificação em duas etapas.',
};

export default function HomePage() {
  const { me } = useSession();
  if (!me) return null;
  const items = NAV.filter((n) => n.href !== '/inicio' && (n.any.length === 0 || n.any.some((p) => me.permissions.includes(p))));
  return (
    <>
      <PageHeader title={`Olá, ${me.user.name.split(' ')[0]}`} description={`${me.context.roleLabel} em ${me.context.unitName}`} />
      <div className="mb-6 flex flex-wrap gap-2">
        {me.features.aiEnabled && <Badge tone="violet">IA ativada</Badge>}
        {me.features.whatsappEnabled && <Badge tone="green">WhatsApp ativo</Badge>}
        {me.features.rndsEnabled && <Badge tone="blue">Envio à RNDS ativo</Badge>}
        {!me.context.mfa && <Badge tone="amber">Sessão sem verificação em duas etapas</Badge>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <Link key={item.href} href={item.href}>
            <Card className="flex h-full gap-4 p-5 transition-shadow hover:shadow-md">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                <item.icon className="h-5 w-5" />
              </div>
              <div>
                <p className="font-semibold">{item.label}</p>
                <p className="mt-1 text-sm text-slate-600">{DESCRIPTIONS[item.href] ?? ''}</p>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
