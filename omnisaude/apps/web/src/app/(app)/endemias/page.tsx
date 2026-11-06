'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { AbaOrdens } from '@/components/endemias/aba-ordens';
import { AbaConfiguracao, AbaEstoque, AbaProducao } from '@/components/endemias/abas-gestao';
import { AbaPendencias, AbaVisitas, AbaZonas } from '@/components/endemias/abas-supervisao';
import { PageHeader } from '@/components/ui/card';
import { Alert } from '@/components/ui/misc';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useSession } from '@/lib/session';

/**
 * Endemias (VIG-3a): ordens de bloqueio de transmissão, zonas dos agentes, visitas, pendências (imóveis e baixas de
 * larvicida), estoque de larvicidas, produção com os índices e a configuração do bloqueio. A vigilância e a gestão
 * acompanham; a supervisão e a coordenação de endemias agem.
 */
function EndemiasConteudo() {
  const session = useSession();
  const params = useSearchParams();
  const supervisiona = session.can('endemias.supervisionar');
  const coordena = session.can('endemias.coordenar');
  const le = session.can('endemias.ler') || supervisiona;
  const abas = useMemo(
    () =>
      [
        { value: 'bloqueios', label: 'Bloqueios', ok: le },
        { value: 'zonas', label: 'Zonas', ok: le },
        { value: 'visitas', label: 'Visitas', ok: le },
        { value: 'pendencias', label: 'Pendências', ok: supervisiona },
        { value: 'estoque', label: 'Larvicidas', ok: supervisiona || session.can('estoque.ler') },
        { value: 'producao', label: 'Produção e índices', ok: le },
        { value: 'configuracao', label: 'Configuração', ok: le },
      ].filter((a) => a.ok),
    [le, supervisiona, session],
  );
  const [tab, setTab] = useState(params.get('aba') ?? 'bloqueios');
  if (!le) return <Alert tone="warn">Seu papel não tem acesso às endemias.</Alert>;
  return (
    <div className="space-y-4">
      <PageHeader title="Endemias" description="Controle vetorial do Aedes aegypti: bloqueio de transmissão, trabalho de campo dos agentes e larvicidas" />
      <Tabs value={abas.some((a) => a.value === tab) ? tab : 'bloqueios'} onValueChange={setTab} tabs={abas.map(({ value, label }) => ({ value, label }))}>
        <TabPanel value="bloqueios" className="pt-3">
          <AbaOrdens podeGerir={supervisiona} podeCancelar={coordena} ordemInicial={params.get('ordem')} />
        </TabPanel>
        <TabPanel value="zonas" className="pt-3">
          <AbaZonas podeGerir={supervisiona} />
        </TabPanel>
        <TabPanel value="visitas" className="pt-3">
          <AbaVisitas />
        </TabPanel>
        {supervisiona && (
          <TabPanel value="pendencias" className="pt-3">
            <AbaPendencias />
          </TabPanel>
        )}
        <TabPanel value="estoque" className="pt-3">
          <AbaEstoque podeLancar={coordena} />
        </TabPanel>
        <TabPanel value="producao" className="pt-3">
          <AbaProducao />
        </TabPanel>
        <TabPanel value="configuracao" className="pt-3">
          <AbaConfiguracao podeEditar={coordena} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

export default function EndemiasPage() {
  return (
    <Suspense>
      <EndemiasConteudo />
    </Suspense>
  );
}
