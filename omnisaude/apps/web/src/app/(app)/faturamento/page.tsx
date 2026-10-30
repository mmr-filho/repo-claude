'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { AihTab, ExportsTab, SigtapTab } from '@/components/billing/other-tabs';
import { ProductionTab } from '@/components/billing/production-tab';
import { fmtCompetencia } from '@/components/billing/types';
import { todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

export default function BillingPage() {
  const { me } = useSession();
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const competencia = month.replace('-', '');
  const [tab, setTab] = useState('producao');
  const directory = useApi<{ units: { id: string; name: string; type: string }[] }>('/directory');
  const assigned = new Set(me?.assignments.filter((a) => a.role === 'FATURAMENTO' || a.role === 'GESTOR').map((a) => a.unitId));
  const units = (directory.data?.units ?? []).filter((u) => assigned.size === 0 || assigned.has(u.id));
  const unitName = (id: string) => directory.data?.units.find((u) => u.id === id)?.name ?? '—';

  return (
    <>
      <PageHeader
        title="Faturamento SUS"
        description={`Competência ${fmtCompetencia(competencia)}: produção ambulatorial (BPA-I/BPA-C), crítica pré-glosa, SIGTAP e espelho de AIH.`}
        actions={
          <label className="flex items-center gap-2 text-sm">
            Competência
            <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-44" />
          </label>
        }
      />
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'producao', label: 'Produção e crítica' },
          { value: 'arquivos', label: 'Arquivos BPA' },
          { value: 'sigtap', label: 'SIGTAP' },
          { value: 'aih', label: 'Espelho AIH' },
        ]}
      >
        <TabPanel value="producao">
          <ProductionTab competencia={competencia} units={units} />
        </TabPanel>
        <TabPanel value="arquivos">
          <ExportsTab competencia={competencia} unitName={unitName} />
        </TabPanel>
        <TabPanel value="sigtap">
          <SigtapTab competencia={competencia} />
        </TabPanel>
        <TabPanel value="aih">
          <AihTab competencia={competencia} />
        </TabPanel>
      </Tabs>
    </>
  );
}
