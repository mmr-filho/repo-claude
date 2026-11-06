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
  '/regulacao': 'Fila única de consultas especializadas, exames e procedimentos, com protocolos e devolutiva.',
  '/central-leitos': 'Mapa de leitos da rede, solicitações de vaga, regulação com reserva de leito, transferência e AIH.',
  '/tfd': 'Tratamento Fora do Domicílio: laudo, parecer, agendamento, ajuda de custo e transporte.',
  '/assistente': 'Conversas do cidadão com o assistente virtual do WhatsApp: pedidos de atendente, triagens e consultas marcadas por conversa.',
  '/ouvidoria': 'Manifestações do cidadão com protocolo e prazo legal, resposta conclusiva e pesquisa de satisfação após o atendimento.',
  '/transporte': 'Frota, motoristas, rotas, viagens com passageiros e roteiro do dia.',
  '/faturamento': 'SIGTAP, crítica pré-glosa e exportação BPA.',
  '/gestao': 'Produtividade, SLAs e pautas de reunião.',
  '/bi': 'Perguntas em linguagem natural sobre os dados da rede.',
  '/servico-social': 'Busca ativa humanizada de pacientes crônicos em atraso.',
  '/acs': 'Território do agente, visitas domiciliares e cadastros em campo, também sem internet.',
  '/vacinas': 'Sala de vacina, cartão, aprazamento, faltosos e estoque por lote.',
  '/vigilancia': 'Notificação compulsória com prazo de 24 h ou 7 dias, ciência e repasse da vigilância, lista vigente e de-para de códigos.',
  '/territorio': 'Localidades, bairros, quarteirões e imóveis no mapa: importação da malha, editor de quarteirões e raio do bloqueio.',
  '/campo-ace': 'Zona e ordens de bloqueio do agente de endemias: visita ao imóvel com depósitos, focos e larvicida, também sem internet.',
  '/endemias': 'Ordens de bloqueio de transmissão abertas pelas notificações, zonas dos agentes, pendências, larvicidas e índices larvários.',
  '/programas': 'Programas da APS com faltosos, busca ativa e estratificações.',
  '/indicadores': 'Os 15 indicadores do cofinanciamento, por equipe e competência.',
  '/esus': 'Lotes de fichas do e-SUS APS e envio ao PEC.',
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
