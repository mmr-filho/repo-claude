'use client';

import { ROLE_LABELS, ROLES, type Role } from '@omnisaude/shared';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useApi } from '@/lib/hooks';

/** Papéis que só abrem sessão com verificação em duas etapas; vale para toda a instituição. */
export function SecurityAdmin() {
  const toast = useToast();
  const { data, loading, error, reload } = useApi<{ mfaRequiredRoles: Role[] }>('/admin/security');
  const [selected, setSelected] = useState<Role[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setSelected(data.mfaRequiredRoles);
  }, [data]);
  const changed = !!data && (selected.length !== data.mfaRequiredRoles.length || selected.some((r) => !data.mfaRequiredRoles.includes(r)));

  return (
    <Card>
      <CardHeader title="Verificação em duas etapas por papel" description="Quem assume um papel marcado precisa configurar o aplicativo autenticador na primeira entrada e informar o código a cada login." />
      <CardBody className="flex flex-col gap-4">
        {error && <Alert tone="error">{error}</Alert>}
        {loading && !data ? (
          <Spinner className="py-6" />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {ROLES.map((r) => (
                <label key={r} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                  <input type="checkbox" checked={selected.includes(r)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, r] : s.filter((x) => x !== r)))} />
                  {ROLE_LABELS[r]}
                </label>
              ))}
            </div>
            <Alert tone="info">Recomendado para gestão, faturamento, farmácia e corpo clínico: são os papéis que assinam registros, movimentam estoque e enviam dados ao SUS.</Alert>
            <Button
              className="self-start"
              loading={busy}
              disabled={!changed}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.patch('/admin/security', { mfaRequiredRoles: selected });
                  toast.success('Regra de 2FA atualizada');
                  await reload();
                } catch (err) {
                  toast.error(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <ShieldCheck className="h-4 w-4" /> Salvar
            </Button>
          </>
        )}
      </CardBody>
    </Card>
  );
}
