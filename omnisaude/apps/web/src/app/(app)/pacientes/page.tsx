'use client';

import { useRouter } from 'next/navigation';
import { PatientSearch } from '@/components/patients/patient-search';
import { Card, CardBody, PageHeader } from '@/components/ui/card';

export default function PatientsPage() {
  const router = useRouter();
  return (
    <>
      <PageHeader title="Pacientes" description="O prontuário é único em toda a rede: atendimentos da UBS, UPA, hospital e farmácia aparecem juntos." />
      <Card>
        <CardBody>
          <PatientSearch onSelect={(p) => router.push(`/paciente?id=${p.id}`)} autoFocus />
          <p className="mt-3 text-xs text-slate-500">Cada acesso ao prontuário fica registrado na trilha de auditoria (LGPD).</p>
        </CardBody>
      </Card>
    </>
  );
}
