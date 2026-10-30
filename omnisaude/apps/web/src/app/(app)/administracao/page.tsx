'use client';

import { useState } from 'react';
import { SecurityAdmin } from '@/components/admin/security-admin';
import { UnitsAdmin } from '@/components/admin/units-admin';
import { UsersAdmin } from '@/components/admin/users-admin';
import { PageHeader } from '@/components/ui/card';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useSession } from '@/lib/session';

export default function AdminPage() {
  const session = useSession();
  const tabs = [
    ...(session.can('cadastros.profissionais') ? [{ value: 'profissionais', label: 'Profissionais' }] : []),
    ...(session.can('cadastros.unidades') ? [{ value: 'unidades', label: 'Unidades' }] : []),
    ...(session.can('seguranca.gerir') ? [{ value: 'seguranca', label: 'Segurança' }] : []),
  ];
  const [tab, setTab] = useState(tabs[0]?.value ?? 'profissionais');
  return (
    <>
      <PageHeader title="Administração" description="Unidades da rede, profissionais com suas lotações e regras de segurança. Toda alteração fica na trilha de auditoria." />
      <Tabs value={tab} onValueChange={setTab} tabs={tabs}>
        <TabPanel value="profissionais">
          <UsersAdmin />
        </TabPanel>
        <TabPanel value="unidades">
          <UnitsAdmin />
        </TabPanel>
        <TabPanel value="seguranca">
          <SecurityAdmin />
        </TabPanel>
      </Tabs>
    </>
  );
}
