'use client';

import { UNIT_TYPE_LABELS, UNIT_TYPES, type UnitType } from '@omnisaude/shared';
import { Building2, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import type { AdminUnit } from './types';

const empty = { name: '', type: 'UBS' as UnitType, cnes: '', ibgeCode: '', address: '', phone: '', email: '', openingHours: '' };
type Form = typeof empty;

/** Cadastro das unidades da rede (CNES, tipo, contato, horário). Desativar esconde a unidade das lotações e agendas. */
export function UnitsAdmin() {
  const toast = useToast();
  const [showInactive, setShowInactive] = useState(false);
  const { data, loading, error, reload } = useApi<AdminUnit[]>(`/admin/units?includeInactive=${showInactive}`, [showInactive]);
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const [busy, setBusy] = useState(false);

  function open(unit?: AdminUnit) {
    const ibge = unit?.ibgeCode ?? data?.[0]?.ibgeCode ?? '';
    setEditing(
      unit
        ? { id: unit.id, form: { name: unit.name, type: unit.type, cnes: unit.cnes, ibgeCode: unit.ibgeCode, address: unit.address ?? '', phone: unit.phone ?? '', email: unit.email ?? '', openingHours: unit.openingHours ?? '' } }
        : { id: null, form: { ...empty, ibgeCode: ibge } },
    );
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      const body = { ...editing.form, cnes: editing.form.cnes.replace(/\D/g, ''), ibgeCode: editing.form.ibgeCode.replace(/\D/g, '') };
      if (editing.id) await api.patch(`/admin/units/${editing.id}`, body);
      else await api.post('/admin/units', body);
      toast.success(editing.id ? 'Unidade atualizada' : 'Unidade cadastrada');
      setEditing(null);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(unit: AdminUnit) {
    try {
      await api.patch(`/admin/units/${unit.id}`, { active: !unit.active });
      toast.success(unit.active ? 'Unidade desativada' : 'Unidade reativada');
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const f = editing?.form;
  const set = (patch: Partial<Form>) => setEditing((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));

  return (
    <Card>
      <CardHeader
        title="Unidades"
        description="Estabelecimentos da rede com o código CNES. Profissionais são lotados em unidades."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Mostrar desativadas
            </label>
            <Button onClick={() => open()}>
              <Plus className="h-4 w-4" /> Nova unidade
            </Button>
          </div>
        }
      />
      <CardBody className="overflow-x-auto p-0">
        {error && <Alert tone="error" className="m-4">{error}</Alert>}
        {loading && !data ? (
          <Spinner className="py-10" />
        ) : !data?.length ? (
          <EmptyState title="Nenhuma unidade cadastrada" icon={<Building2 className="h-6 w-6" />} />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Unidade</TH>
                <TH>Tipo</TH>
                <TH>CNES</TH>
                <TH>Contato</TH>
                <TH>Profissionais</TH>
                <TH>Situação</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {data.map((u) => (
                <TR key={u.id}>
                  <TD>
                    <p className="font-medium">{u.name}</p>
                    {u.openingHours && <p className="text-xs text-slate-500">{u.openingHours}</p>}
                  </TD>
                  <TD>{UNIT_TYPE_LABELS[u.type] ?? u.type}</TD>
                  <TD className="font-mono">{u.cnes}</TD>
                  <TD className="text-sm text-slate-600">
                    {u.phone && <p>{u.phone}</p>}
                    {u.email && <p>{u.email}</p>}
                    {u.address && <p className="text-xs">{u.address}</p>}
                  </TD>
                  <TD>{u._count.assignments}</TD>
                  <TD>{u.active ? <Badge tone="green">Ativa</Badge> : <Badge tone="slate">Desativada</Badge>}</TD>
                  <TD className="whitespace-nowrap text-right">
                    <Button size="sm" variant="ghost" onClick={() => open(u)}>
                      <Pencil className="h-4 w-4" /> Editar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggle(u)}>
                      {u.active ? 'Desativar' : 'Reativar'}
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardBody>
      <Dialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing?.id ? 'Editar unidade' : 'Nova unidade'}
        description="O CNES é o código do estabelecimento no Cadastro Nacional (7 dígitos)."
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button loading={busy} disabled={!f || f.name.trim().length < 3 || !/^\d{7}$/.test(f.cnes.replace(/\D/g, '')) || !/^\d{6,7}$/.test(f.ibgeCode.replace(/\D/g, ''))} onClick={save}>
              Salvar
            </Button>
          </>
        }
      >
        {f && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Nome" htmlFor="u-name" className="sm:col-span-2">
              <Input id="u-name" value={f.name} onChange={(e) => set({ name: e.target.value })} autoFocus />
            </Field>
            <Field label="Tipo" htmlFor="u-type">
              <Select id="u-type" value={f.type} onChange={(e) => set({ type: e.target.value as UnitType })}>
                {UNIT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {UNIT_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="CNES" htmlFor="u-cnes" hint="7 dígitos">
              <Input id="u-cnes" inputMode="numeric" maxLength={7} value={f.cnes} onChange={(e) => set({ cnes: e.target.value.replace(/\D/g, '') })} />
            </Field>
            <Field label="Código IBGE do município" htmlFor="u-ibge" hint="6 ou 7 dígitos">
              <Input id="u-ibge" inputMode="numeric" maxLength={7} value={f.ibgeCode} onChange={(e) => set({ ibgeCode: e.target.value.replace(/\D/g, '') })} />
            </Field>
            <Field label="Telefone" htmlFor="u-phone">
              <Input id="u-phone" value={f.phone} onChange={(e) => set({ phone: e.target.value })} />
            </Field>
            <Field label="E-mail" htmlFor="u-email">
              <Input id="u-email" type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} />
            </Field>
            <Field label="Horário de funcionamento" htmlFor="u-hours">
              <Input id="u-hours" placeholder="Segunda a sexta, 7h às 17h" value={f.openingHours} onChange={(e) => set({ openingHours: e.target.value })} />
            </Field>
            <Field label="Endereço" htmlFor="u-address" className="sm:col-span-2">
              <Input id="u-address" value={f.address} onChange={(e) => set({ address: e.target.value })} />
            </Field>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
