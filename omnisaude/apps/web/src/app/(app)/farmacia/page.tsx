'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/ui/card';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { ControlledTab } from '@/components/pharmacy/controlled-tab';
import { DispenseTab } from '@/components/pharmacy/dispense-tab';
import { NfeTab } from '@/components/pharmacy/nfe-tab';
import { StockTab } from '@/components/pharmacy/stock-tab';
import { TransfersTab } from '@/components/pharmacy/transfers-tab';
import { UnitizeTab } from '@/components/pharmacy/unitize-tab';
import { useSession } from '@/lib/session';

export default function PharmacyPage() {
  const session = useSession();
  const tabs = [
    { value: 'estoque', label: 'Estoque', show: session.can('estoque.ler') },
    { value: 'nfe', label: 'Entrada NF-e', show: session.can('nfe.importar', 'estoque.ler') },
    { value: 'transferencias', label: 'Transferências', show: session.can('estoque.ler') },
    { value: 'unitarizacao', label: 'Unitarização', show: session.can('unitarizacao.executar') },
    { value: 'dispensacao', label: 'Dispensação', show: session.can('dispensacao.registrar') },
    { value: 'controlados', label: 'Controlados (344)', show: session.can('controlados.relatorio') },
  ].filter((t) => t.show);
  const [tab, setTab] = useState(tabs[0]?.value ?? 'estoque');

  return (
    <>
      <div className="no-print">
        <PageHeader title="Farmácia e suprimentos" description="Do fornecedor ao leito: entrada por NF-e com rastreabilidade, transferências com dupla conferência, unitarização GS1 e dispensação." />
      </div>
      <Tabs value={tab} onValueChange={setTab} tabs={tabs} className="[&>[role=tablist]]:no-print">
        <TabPanel value="estoque">
          <StockTab />
        </TabPanel>
        <TabPanel value="nfe">
          <NfeTab />
        </TabPanel>
        <TabPanel value="transferencias">
          <TransfersTab />
        </TabPanel>
        <TabPanel value="unitarizacao">
          <UnitizeTab />
        </TabPanel>
        <TabPanel value="dispensacao">
          <DispenseTab />
        </TabPanel>
        <TabPanel value="controlados">
          <ControlledTab />
        </TabPanel>
      </Tabs>
    </>
  );
}
