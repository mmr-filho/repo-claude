'use client';

import { ABASTECIMENTO_AGUA, codeIn, DESTINO_LIXO, ESGOTAMENTO, PARENTESCO, RENDA_FAMILIAR, SITUACAO_MORADIA, TIPO_DOMICILIO, TRATAMENTO_AGUA } from '@omnisaude/shared';
import { Home, Pencil, Plus, UserMinus, Users } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { PatientSummary } from '@/lib/types';
import { PatientSearch } from './patient-search';
import type { PatientDetail, PatientFamily } from './types';

type HouseholdForm = { dwellingType: string; tenure: string; waterSupply: string; waterTreatment: string; sewage: string; garbage: string; electricity: '' | 'sim' | 'nao'; rooms: string; microArea: string; incomeBracket: string };

const label = (table: Record<string, string>, code: string | null | undefined) => (code ? (table[code] ?? code) : null);

/** Domicílio e família do paciente (cadastro domiciliar do e-SUS): responsável, membros e condições de moradia. */
export function FamilyCard({ patient, onChanged }: { patient: PatientDetail; onChanged: () => void }) {
  const session = useSession();
  const toast = useToast();
  const canEdit = session.can('paciente.cadastrar');
  const family = patient.family;
  const [adding, setAdding] = useState(false);
  const [joining, setJoining] = useState(false);
  const [member, setMember] = useState<PatientSummary | null>(null);
  const [kinship, setKinship] = useState('02');
  const [responsibleFamily, setResponsibleFamily] = useState<PatientFamily | null>(null);
  const [editing, setEditing] = useState<HouseholdForm | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      onChanged();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function startEdit() {
    const h = family?.household;
    setEditing({
      dwellingType: h?.dwellingType ?? '',
      tenure: h?.tenure ?? '',
      waterSupply: h?.waterSupply ?? '',
      waterTreatment: h?.waterTreatment ?? '',
      sewage: h?.sewage ?? '',
      garbage: h?.garbage ?? '',
      electricity: h?.electricity == null ? '' : h.electricity ? 'sim' : 'nao',
      rooms: h?.rooms?.toString() ?? '',
      microArea: h?.microArea ?? '',
      incomeBracket: family?.incomeBracket ?? '',
    });
  }

  const opt = (v: string) => (v ? v : null);
  const h = family?.household;

  return (
    <Card>
      <CardHeader
        title="Domicílio e família"
        actions={
          canEdit && family ? (
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={startEdit}>
                <Pencil className="h-4 w-4" /> Moradia
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" /> Membro
              </Button>
            </div>
          ) : undefined
        }
      />
      <CardBody className="flex flex-col gap-3 text-sm">
        {!family ? (
          <>
            <p className="text-slate-500">Sem domicílio ou família vinculados.</p>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  onClick={() =>
                    run(
                      () =>
                        api.post('/households', {
                          cep: patient.address.cep,
                          street: patient.address.street,
                          number: patient.address.number,
                          complement: patient.address.complement,
                          district: patient.address.district,
                          city: patient.address.city,
                          uf: patient.address.uf,
                          ibgeCode: patient.address.ibgeCode,
                          family: { responsibleId: patient.id },
                        }),
                      'Domicílio criado com este paciente como responsável familiar',
                    )
                  }
                >
                  <Home className="h-4 w-4" /> Criar domicílio com este endereço
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setJoining(true)}>
                  <Users className="h-4 w-4" /> Incluir em família existente
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <div>
              <p className="font-medium">{h?.addressLine ?? 'Endereço não informado'}</p>
              <p className="text-xs text-slate-500">
                {[h?.city && h?.uf ? `${h.city}/${h.uf}` : null, label(TIPO_DOMICILIO, h?.dwellingType), label(SITUACAO_MORADIA, h?.tenure), h?.rooms ? `${h.rooms} cômodos` : null, h?.microArea ? `microárea ${h.microArea}` : null]
                  .filter(Boolean)
                  .join(' · ') || 'Condições de moradia não informadas'}
              </p>
              <p className="text-xs text-slate-500">
                {[label(ABASTECIMENTO_AGUA, h?.waterSupply) && `água: ${label(ABASTECIMENTO_AGUA, h?.waterSupply)}`, label(ESGOTAMENTO, h?.sewage) && `esgoto: ${label(ESGOTAMENTO, h?.sewage)}`, label(DESTINO_LIXO, h?.garbage) && `lixo: ${label(DESTINO_LIXO, h?.garbage)}`, h?.electricity === false ? 'sem energia elétrica' : null]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {family.incomeBracket && <p className="text-xs text-slate-500">Renda familiar: {label(RENDA_FAMILIAR, family.incomeBracket)}</p>}
            </div>
            <ul className="flex flex-col divide-y divide-slate-100">
              {family.members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 py-1.5">
                  <span>
                    <a className="font-medium text-brand-700 hover:underline" href={`/paciente?id=${m.id}`}>
                      {m.name}
                    </a>
                    <span className="text-xs text-slate-500">
                      {' '}
                      · {m.age} anos · {fmtDate(m.birthDate)}
                    </span>
                  </span>
                  <span className="flex items-center gap-1">
                    <Badge tone={m.kinship === '00' ? 'blue' : 'slate'}>{label(PARENTESCO, m.kinship) ?? 'Sem parentesco'}</Badge>
                    {canEdit && m.id !== patient.id && (
                      <Button size="icon" variant="ghost" aria-label={`Remover ${m.name} da família`} onClick={() => run(() => api.delete(`/families/${family.id}/members/${m.id}`), 'Membro removido da família')}>
                        <UserMinus className="h-4 w-4" />
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {canEdit && (
              <button className="self-start text-xs text-slate-500 underline-offset-2 hover:underline" onClick={() => run(() => api.delete(`/families/${family.id}/members/${patient.id}`), 'Paciente retirado da família')}>
                Retirar este paciente da família
              </button>
            )}
          </>
        )}
      </CardBody>

      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title="Incluir membro na família"
        description="Busque o paciente e informe o parentesco com o responsável familiar."
        footer={
          <Button
            loading={busy}
            disabled={!member}
            onClick={async () => {
              if (!family || !member) return;
              if (await run(() => api.post(`/families/${family.id}/members`, { patientId: member.id, kinship }), 'Membro incluído')) {
                setAdding(false);
                setMember(null);
              }
            }}
          >
            Incluir
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {member ? (
            <Alert tone="info">
              {member.name} · {fmtDate(member.birthDate)}{' '}
              <button className="underline" onClick={() => setMember(null)}>
                trocar
              </button>
            </Alert>
          ) : (
            <PatientSearch onSelect={setMember} autoFocus />
          )}
          <Field label="Parentesco com o responsável" htmlFor="fam-kin">
            <Select id="fam-kin" value={kinship} onChange={(e) => setKinship(e.target.value)}>
              {codeIn(PARENTESCO).map((k) => (
                <option key={k} value={k}>
                  {PARENTESCO[k]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={joining}
        onOpenChange={(o) => {
          setJoining(o);
          if (!o) setResponsibleFamily(null);
        }}
        title="Incluir em família existente"
        description="Busque o responsável familiar (ou qualquer membro) da família."
        footer={
          <Button
            loading={busy}
            disabled={!responsibleFamily}
            onClick={async () => {
              if (!responsibleFamily) return;
              if (await run(() => api.post(`/families/${responsibleFamily.id}/members`, { patientId: patient.id, kinship }), 'Incluído na família')) {
                setJoining(false);
                setResponsibleFamily(null);
              }
            }}
          >
            Incluir
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {responsibleFamily ? (
            <Alert tone="info">
              Família de {responsibleFamily.responsible?.name ?? 'sem responsável'} · {responsibleFamily.household?.addressLine ?? 'sem endereço'} · {responsibleFamily.members.length} membro(s){' '}
              <button className="underline" onClick={() => setResponsibleFamily(null)}>
                trocar
              </button>
            </Alert>
          ) : (
            <PatientSearch
              autoFocus
              onSelect={async (p) => {
                try {
                  const detail = await api.get<PatientDetail>(`/patients/${p.id}`);
                  if (!detail.family) toast.error(`${p.name} não tem família cadastrada. Abra o cadastro dessa pessoa e crie o domicílio primeiro.`);
                  else setResponsibleFamily(detail.family);
                } catch (err) {
                  toast.error(errorMessage(err));
                }
              }}
            />
          )}
          <Field label="Parentesco com o responsável" htmlFor="join-kin">
            <Select id="join-kin" value={kinship} onChange={(e) => setKinship(e.target.value)}>
              {codeIn(PARENTESCO).map((k) => (
                <option key={k} value={k}>
                  {PARENTESCO[k]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title="Condições de moradia"
        description="Campos do cadastro domiciliar do e-SUS."
        size="lg"
        footer={
          <Button
            loading={busy}
            onClick={async () => {
              if (!editing || !family?.household) return;
              const e = editing;
              const ok = await run(async () => {
                await api.patch(`/households/${family.household!.id}`, {
                  dwellingType: opt(e.dwellingType),
                  tenure: opt(e.tenure),
                  waterSupply: opt(e.waterSupply),
                  waterTreatment: opt(e.waterTreatment),
                  sewage: opt(e.sewage),
                  garbage: opt(e.garbage),
                  electricity: e.electricity ? e.electricity === 'sim' : null,
                  rooms: e.rooms ? Number(e.rooms) : null,
                  microArea: opt(e.microArea),
                });
                await api.patch(`/families/${family.id}`, { incomeBracket: opt(e.incomeBracket) });
              }, 'Domicílio atualizado');
              if (ok) setEditing(null);
            }}
          >
            Salvar
          </Button>
        }
      >
        {editing && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(
              [
                ['dwellingType', 'Tipo de domicílio', TIPO_DOMICILIO],
                ['tenure', 'Situação de moradia', SITUACAO_MORADIA],
                ['waterSupply', 'Abastecimento de água', ABASTECIMENTO_AGUA],
                ['waterTreatment', 'Tratamento da água', TRATAMENTO_AGUA],
                ['sewage', 'Escoamento do banheiro', ESGOTAMENTO],
                ['garbage', 'Destino do lixo', DESTINO_LIXO],
                ['incomeBracket', 'Renda familiar', RENDA_FAMILIAR],
              ] as const
            ).map(([key, lbl, table]) => (
              <Field key={key} label={lbl} htmlFor={`hh-${key}`}>
                <Select id={`hh-${key}`} value={editing[key]} onChange={(e) => setEditing({ ...editing, [key]: e.target.value })}>
                  <option value="">Não informado</option>
                  {codeIn(table).map((k) => (
                    <option key={k} value={k}>
                      {table[k]}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
            <Field label="Energia elétrica" htmlFor="hh-el">
              <Select id="hh-el" value={editing.electricity} onChange={(e) => setEditing({ ...editing, electricity: e.target.value as HouseholdForm['electricity'] })}>
                <option value="">Não informado</option>
                <option value="sim">Sim</option>
                <option value="nao">Não</option>
              </Select>
            </Field>
            <Field label="Número de cômodos" htmlFor="hh-rooms">
              <Input id="hh-rooms" inputMode="numeric" value={editing.rooms} onChange={(e) => setEditing({ ...editing, rooms: e.target.value.replace(/\D/g, '') })} />
            </Field>
            <Field label="Microárea" htmlFor="hh-micro">
              <Input id="hh-micro" value={editing.microArea} onChange={(e) => setEditing({ ...editing, microArea: e.target.value })} />
            </Field>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
