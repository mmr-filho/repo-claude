'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Duplicates } from '@/components/patients/duplicates';
import { PatientSearch } from '@/components/patients/patient-search';
import { Card, CardBody, PageHeader } from '@/components/ui/card';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useSession } from '@/lib/session';

export default function PatientsPage() {
  const router = useRouter();
  const session = useSession();
  const [tab, setTab] = useState('buscar');
  const canMerge = session.can('paciente.unificar');
  return (
    <>
      <PageHeader title="Pacientes" description="O prontuário é único em toda a rede: atendimentos da UBS, UPA, hospital e farmácia aparecem juntos." />
      <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'buscar', label: 'Buscar' }, ...(canMerge ? [{ value: 'duplicidades', label: 'Possíveis duplicidades' }] : [])]}>
        <TabPanel value="buscar">
          <Card>
            <CardBody>
              <PatientSearch onSelect={(p) => router.push(`/paciente?id=${p.id}`)} autoFocus />
              <p className="mt-3 text-xs text-slate-500">Cada acesso ao prontuário fica registrado na trilha de auditoria (LGPD).</p>
            </CardBody>
          </Card>
        </TabPanel>
        {canMerge && (
          <TabPanel value="duplicidades">
            <Duplicates />
          </TabPanel>
        )}
      </Tabs>
    </>
  );
}
