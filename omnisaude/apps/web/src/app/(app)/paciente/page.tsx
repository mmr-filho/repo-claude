'use client';

import { AlertTriangle, Pencil, Plus, Printer } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { FamilyCard } from '@/components/patients/family-card';
import { PrintPortal, printSoon } from '@/components/patients/print-portal';
import { Timeline } from '@/components/patients/timeline';
import type { PatientDetail, TimelineEvent, Wristband } from '@/components/patients/types';
import { WristbandLabel } from '@/components/patients/wristband';
import { EMPTY_PATIENT, PatientFields, toPatientPayload, type PatientFormValues } from '@/components/reception/patient-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, formatCns, formatCpf, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

const LINES = [
  ['', 'Nenhuma'],
  ['HIPERTENSAO', 'Hipertensão'],
  ['DIABETES', 'Diabetes'],
  ['GESTANTE', 'Gestante'],
  ['ONCOLOGIA', 'Oncologia'],
  ['SAUDE_MENTAL', 'Saúde mental'],
  ['TUBERCULOSE', 'Tuberculose'],
  ['HANSENIASE', 'Hanseníase'],
] as const;

function toForm(p: PatientDetail): PatientFormValues {
  return {
    ...EMPTY_PATIENT,
    name: p.civilName,
    socialName: p.name !== p.civilName ? p.name : '',
    birthDate: p.birthDate,
    sex: p.sex,
    cpf: p.cpf ?? '',
    cns: p.cns ?? '',
    motherName: p.motherName ?? '',
    fatherName: p.fatherName ?? '',
    racaCor: p.racaCor,
    phone: p.phone ?? '',
    whatsappOptIn: p.whatsappOptIn,
    email: p.email ?? '',
    cep: p.address.cep ?? '',
    street: p.address.street ?? '',
    number: p.address.number ?? '',
    complement: p.address.complement ?? '',
    district: p.address.district ?? '',
    city: p.address.city ?? '',
    uf: p.address.uf ?? '',
    ibgeCode: p.address.ibgeCode ?? '',
    rg: p.rg ?? '',
    rgIssuer: p.rgIssuer ?? '',
    rgUf: p.rgUf ?? '',
    nis: p.nis ?? '',
    birthIbgeCode: p.birthIbgeCode ?? '',
    education: p.education ?? '',
    workSituation: p.workSituation ?? '',
    occupationCbo: p.occupationCbo ?? '',
    homeless: p.homeless,
  };
}

function PatientRecord() {
  const id = useSearchParams().get('id');
  const session = useSession();
  const toast = useToast();
  const canChart = session.can('prontuario.ler');
  const patient = useApi<PatientDetail>(id ? `/patients/${id}` : null);
  const timeline = useApi<{ events: TimelineEvent[] }>(id && canChart ? `/patients/${id}/timeline` : null);
  const [editing, setEditing] = useState<PatientFormValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [allergy, setAllergy] = useState({ open: false, substance: '', reaction: '' });
  const [condition, setCondition] = useState({ open: false, system: 'CID10', code: '', description: '', lineOfCare: '', onsetAt: '' });
  const [resolve, setResolve] = useState<{ open: boolean; id: string; code: string; description: string; resolvedAt: string }>({ open: false, id: '', code: '', description: '', resolvedAt: todayIso() });
  const [band, setBand] = useState<Wristband | null>(null);

  if (!id) return <Alert tone="error">Paciente não informado.</Alert>;
  if (patient.error) return <Alert tone="error">{patient.error}</Alert>;
  const p = patient.data;
  if (!p) return <Spinner />;

  async function run(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast.success(ok);
      void patient.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {p.redirectedFromId && <Alert tone="info">O cadastro consultado foi unificado neste. Atualize seus atalhos para este registro.</Alert>}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">{p.name}</h1>
            {p.name !== p.civilName && <p className="text-sm text-slate-500">Nome civil: {p.civilName}</p>}
            <p className="mt-1 text-sm text-slate-600">
              {fmtDate(p.birthDate)} · {p.age} anos · {p.sex === 'F' ? 'feminino' : 'masculino'}
              {p.cns ? ` · CNS ${formatCns(p.cns)}` : ''}
              {p.cpf ? ` · CPF ${formatCpf(p.cpf)}` : ''}
            </p>
            {p.motherName && <p className="text-sm text-slate-500">Mãe: {p.motherName}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {p.cadsusSyncedAt ? <Badge tone="green">Conferido no CADSUS {fmtDate(p.cadsusSyncedAt)}</Badge> : <Badge tone="slate">Não conferido no CADSUS</Badge>}
              {p.whatsappOptIn && <Badge tone="green">WhatsApp</Badge>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {session.can('paciente.cadastrar') && (
              <Button variant="secondary" onClick={() => setEditing(toForm(p))}>
                <Pencil className="h-4 w-4" /> Editar cadastro
              </Button>
            )}
            {session.can('pulseira.emitir') && (
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    setBand(await api.get<Wristband>(`/patients/${p.id}/wristband`));
                    printSoon();
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                <Printer className="h-4 w-4" /> Pulseira
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader
              title="Alergias"
              actions={
                session.can('prontuario.evoluir', 'triagem.registrar') && (
                  <Button size="sm" variant="ghost" onClick={() => setAllergy((a) => ({ ...a, open: true }))}>
                    <Plus className="h-4 w-4" /> Adicionar
                  </Button>
                )
              }
            />
            <CardBody className="flex flex-wrap gap-2">
              {p.allergies.length === 0 ? (
                <span className="text-sm text-slate-500">Nenhuma alergia registrada</span>
              ) : (
                p.allergies.map((a) => (
                  <Badge key={a.id} tone="red">
                    <AlertTriangle className="h-3 w-3" /> {a.substance}
                    {a.reaction ? ` (${a.reaction})` : ''}
                  </Badge>
                ))
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title="Condições e linhas de cuidado"
              actions={
                session.can('prontuario.evoluir') && (
                  <Button size="sm" variant="ghost" onClick={() => setCondition((c) => ({ ...c, open: true }))}>
                    <Plus className="h-4 w-4" /> Adicionar
                  </Button>
                )
              }
            />
            <CardBody className="flex flex-col gap-2 text-sm">
              {p.conditions.length === 0 ? (
                <span className="text-slate-500">Nenhuma condição ativa</span>
              ) : (
                p.conditions.map((c) => (
                  <p key={c.id} className="flex flex-wrap items-center gap-2">
                    <span>
                      <b>{c.code}</b> {c.description} {c.lineOfCare && <Badge tone="violet">{LINES.find(([v]) => v === c.lineOfCare)?.[1] ?? c.lineOfCare}</Badge>}
                      {c.onsetAt && <span className="text-xs text-slate-500"> · desde {fmtDate(c.onsetAt)}</span>}
                    </span>
                    {session.can('prontuario.evoluir') && (
                      <Button size="sm" variant="ghost" onClick={() => setResolve({ open: true, id: c.id, code: c.code, description: c.description, resolvedAt: todayIso() })}>
                        Encerrar
                      </Button>
                    )}
                  </p>
                ))
              )}
            </CardBody>
          </Card>
          <FamilyCard patient={p} onChanged={() => void patient.reload()} />
          <Card>
            <CardHeader title="Contato" />
            <CardBody className="text-sm text-slate-700">
              <p>{p.phone ?? 'Sem telefone'}</p>
              <p>{p.email ?? ''}</p>
              <p>{[p.address.street, p.address.number, p.address.complement, p.address.district].filter(Boolean).join(', ') || 'Sem endereço'}</p>
              {(p.address.city || p.address.cep) && (
                <p className="text-slate-500">
                  {[p.address.city && p.address.uf ? `${p.address.city}/${p.address.uf}` : p.address.city, p.address.cep ? `CEP ${p.address.cep.replace(/(\d{5})(\d{3})/, '$1-$2')}` : null].filter(Boolean).join(' · ')}
                </p>
              )}
              {p.homeless && (
                <p className="mt-1">
                  <Badge tone="amber">Situação de rua</Badge>
                </p>
              )}
            </CardBody>
          </Card>
        </div>
        <Card>
          <CardHeader title="Linha do tempo na rede" description={canChart ? 'Atendimentos, prescrições, dispensações, exames, vacinas e agendamentos de todas as unidades.' : undefined} />
          <CardBody>
            {!canChart ? (
              <Alert tone="info">Seu papel não tem acesso ao prontuário.</Alert>
            ) : timeline.loading && !timeline.data ? (
              <Spinner />
            ) : timeline.error ? (
              <Alert tone="error">{timeline.error}</Alert>
            ) : (
              <Timeline events={timeline.data?.events ?? []} />
            )}
          </CardBody>
        </Card>
      </div>

      <Dialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title="Editar cadastro"
        size="xl"
        footer={
          <Button
            loading={saving}
            onClick={async () => {
              setSaving(true);
              await run(() => api.patch(`/patients/${p.id}`, toPatientPayload(editing!)), 'Cadastro atualizado');
              setSaving(false);
              setEditing(null);
            }}
          >
            Salvar
          </Button>
        }
      >
        {editing && <PatientFields values={editing} onChange={setEditing} />}
      </Dialog>
      <Dialog
        open={allergy.open}
        onOpenChange={(o) => setAllergy((a) => ({ ...a, open: o }))}
        title="Registrar alergia"
        footer={
          <Button
            disabled={allergy.substance.trim().length < 2}
            onClick={async () => {
              await run(() => api.post(`/patients/${p.id}/allergies`, { substance: allergy.substance, ...(allergy.reaction ? { reaction: allergy.reaction } : {}) }), 'Alergia registrada');
              setAllergy({ open: false, substance: '', reaction: '' });
            }}
          >
            Registrar
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Substância ou classe" htmlFor="al-sub">
            <Input id="al-sub" value={allergy.substance} onChange={(e) => setAllergy((a) => ({ ...a, substance: e.target.value }))} placeholder="Ex.: penicilina" />
          </Field>
          <Field label="Reação" htmlFor="al-reac">
            <Input id="al-reac" value={allergy.reaction} onChange={(e) => setAllergy((a) => ({ ...a, reaction: e.target.value }))} />
          </Field>
        </div>
      </Dialog>
      <Dialog
        open={resolve.open}
        onOpenChange={(o) => setResolve((r) => ({ ...r, open: o }))}
        title={`Encerrar condição ${resolve.code}`}
        footer={
          <Button
            onClick={async () => {
              await run(() => api.patch(`/patients/${p.id}/conditions/${resolve.id}`, { active: false, resolvedAt: resolve.resolvedAt }), 'Condição encerrada');
              setResolve((r) => ({ ...r, open: false }));
            }}
          >
            Encerrar
          </Button>
        }
      >
        <p className="mb-3 text-sm text-slate-600">{resolve.description}. Na gestação, informe a data do parto ou do desfecho: ela define o puerpério nos indicadores da APS.</p>
        <Field label="Data do desfecho" htmlFor="rs-date">
          <Input id="rs-date" type="date" value={resolve.resolvedAt} max={todayIso()} onChange={(e) => setResolve((r) => ({ ...r, resolvedAt: e.target.value }))} />
        </Field>
      </Dialog>
      <Dialog
        open={condition.open}
        onOpenChange={(o) => setCondition((c) => ({ ...c, open: o }))}
        title="Registrar condição"
        footer={
          <Button
            disabled={condition.code.trim().length < 2 || condition.description.trim().length < 2}
            onClick={async () => {
              await run(
                () =>
                  api.post(`/patients/${p.id}/conditions`, {
                    system: condition.system,
                    code: condition.code.trim(),
                    description: condition.description.trim(),
                    ...(condition.onsetAt ? { onsetAt: condition.onsetAt } : {}),
                    ...(condition.lineOfCare ? { lineOfCare: condition.lineOfCare } : {}),
                  }),
                'Condição registrada',
              );
              setCondition({ open: false, system: 'CID10', code: '', description: '', lineOfCare: '', onsetAt: '' });
            }}
          >
            Registrar
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Sistema" htmlFor="cd-sys">
            <Select id="cd-sys" value={condition.system} onChange={(e) => setCondition((c) => ({ ...c, system: e.target.value }))}>
              <option value="CID10">CID-10</option>
              <option value="CIAP2">CIAP-2</option>
            </Select>
          </Field>
          <Field label="Código" htmlFor="cd-code">
            <Input id="cd-code" value={condition.code} onChange={(e) => setCondition((c) => ({ ...c, code: e.target.value }))} />
          </Field>
          <Field label="Descrição" htmlFor="cd-desc" className="sm:col-span-2">
            <Input id="cd-desc" value={condition.description} onChange={(e) => setCondition((c) => ({ ...c, description: e.target.value }))} />
          </Field>
          <Field label="Início (na gestação, a DUM)" htmlFor="cd-onset" className="sm:col-span-2">
            <Input id="cd-onset" type="date" value={condition.onsetAt} max={todayIso()} onChange={(e) => setCondition((c) => ({ ...c, onsetAt: e.target.value }))} />
          </Field>
          <Field label="Linha de cuidado (busca ativa)" htmlFor="cd-line" className="sm:col-span-2">
            <Select id="cd-line" value={condition.lineOfCare} onChange={(e) => setCondition((c) => ({ ...c, lineOfCare: e.target.value }))}>
              {LINES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Dialog>
      {band && (
        <PrintPortal>
          <WristbandLabel data={band} />
        </PrintPortal>
      )}
    </div>
  );
}

export default function PatientPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <PatientRecord />
    </Suspense>
  );
}
