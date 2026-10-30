'use client';

import { GitMerge, Users } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime, formatCns, formatCpf } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Candidate {
  id: string;
  name: string;
  civilName: string;
  cpf: string | null;
  cns: string | null;
  motherName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  cadsusSyncedAt: string | null;
  createdAt: string;
  records: number;
  counts: Record<string, number>;
}
interface Group {
  key: string;
  name: string;
  birthDate: string;
  patients: Candidate[];
}

const COUNT_LABELS: Record<string, string> = { encounters: 'atendimentos', appointments: 'agendamentos', prescriptions: 'prescrições', vaccinations: 'vacinas', dispensations: 'dispensações', documents: 'documentos' };

/** Cadastros com o mesmo nome e data de nascimento: a recepção escolhe qual fica e unifica os demais nele. */
export function Duplicates() {
  const toast = useToast();
  const { data, loading, error, reload } = useApi<Group[]>('/patients/duplicates/candidates');
  const [group, setGroup] = useState<Group | null>(null);
  const [keep, setKeep] = useState<string>('');
  const [busy, setBusy] = useState(false);

  async function merge() {
    if (!group || !keep) return;
    setBusy(true);
    try {
      for (const p of group.patients.filter((x) => x.id !== keep)) {
        await api.post(`/patients/${keep}/merge`, { duplicateId: p.id });
      }
      toast.success('Cadastros unificados; o histórico foi reunido no que ficou');
      setGroup(null);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Possíveis duplicidades" description="Pessoas com o mesmo nome e a mesma data de nascimento em mais de um cadastro. Ao unificar, atendimentos, prescrições, vacinas e documentos passam para o cadastro que fica; o outro passa a redirecionar." />
      <CardBody>
        {error && <Alert tone="error">{error}</Alert>}
        {loading && !data ? (
          <Spinner className="py-8" />
        ) : !data?.length ? (
          <EmptyState title="Nenhuma duplicidade encontrada" icon={<Users className="h-6 w-6" />} />
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {data.map((g) => (
              <li key={g.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium">{g.name}</p>
                  <p className="text-xs text-slate-500">
                    Nascimento {fmtDate(g.birthDate)} · {g.patients.length} cadastros · {g.patients.map((p) => `${p.records} registro(s)`).join(' / ')}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setGroup(g);
                    setKeep([...g.patients].sort((a, b) => b.records - a.records || a.createdAt.localeCompare(b.createdAt))[0]!.id);
                  }}
                >
                  <GitMerge className="h-4 w-4" /> Comparar e unificar
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      <Dialog
        open={!!group}
        onOpenChange={(o) => !o && setGroup(null)}
        title={group ? `Unificar: ${group.name}` : ''}
        description="Marque o cadastro que fica. Os campos vazios dele são completados com os dos outros; nada é apagado."
        size="xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setGroup(null)}>
              Cancelar
            </Button>
            <Button loading={busy} disabled={!keep} onClick={merge}>
              <GitMerge className="h-4 w-4" /> Unificar no selecionado
            </Button>
          </>
        }
      >
        {group && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {group.patients.map((p) => (
              <label key={p.id} className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-sm ${keep === p.id ? 'border-brand-500 bg-brand-50' : 'border-slate-200'}`}>
                <span className="flex items-center justify-between">
                  <span className="flex items-center gap-2 font-medium">
                    <input type="radio" name="keep" checked={keep === p.id} onChange={() => setKeep(p.id)} /> {keep === p.id ? 'Fica' : 'Será unificado'}
                  </span>
                  <Badge tone={p.records ? 'blue' : 'slate'}>{p.records} registro(s)</Badge>
                </span>
                <span>{p.civilName}</span>
                <span className="text-xs text-slate-600">
                  {p.cpf ? `CPF ${formatCpf(p.cpf)}` : 'sem CPF'} · {p.cns ? `CNS ${formatCns(p.cns)}` : 'sem CNS'}
                </span>
                <span className="text-xs text-slate-600">Mãe: {p.motherName ?? '—'}</span>
                <span className="text-xs text-slate-600">
                  {p.phone ?? 'sem telefone'} · {p.email ?? 'sem e-mail'}
                </span>
                <span className="text-xs text-slate-600">{p.address ?? 'sem endereço'}</span>
                <span className="text-xs text-slate-500">
                  Criado em {fmtDateTime(p.createdAt)}
                  {p.cadsusSyncedAt ? ' · conferido no CADSUS' : ''}
                </span>
                <span className="text-xs text-slate-500">
                  {Object.entries(p.counts)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => `${n} ${COUNT_LABELS[k] ?? k}`)
                    .join(', ') || 'sem registros clínicos'}
                </span>
              </label>
            ))}
          </div>
        )}
      </Dialog>
    </Card>
  );
}
