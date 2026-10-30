'use client';

import { MfaSetup, PasswordForm } from '@/components/account/account-forms';
import { Card, CardBody, CardHeader, PageHeader } from '@/components/ui/card';
import { formatCpf } from '@/lib/format';
import { useSession } from '@/lib/session';

export default function SettingsPage() {
  const { me } = useSession();
  if (!me) return null;
  return (
    <>
      <PageHeader title="Minha conta" description={`${me.user.name} · CPF ${formatCpf(me.user.cpf)}`} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <MfaSetup />
        <PasswordForm />
        <Card>
          <CardHeader title="Lotações" description="Unidades e papéis em que você atua." />
          <CardBody>
            <ul className="flex flex-col gap-1 text-sm">
              {me.assignments.map((a) => (
                <li key={`${a.unitId}-${a.role}`}>
                  <b>{a.unitName}</b> · {a.roleLabel} · CBO {a.cbo}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
