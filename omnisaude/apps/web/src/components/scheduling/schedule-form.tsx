'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Directory {
  units: { id: string; name: string }[];
  professionals: { id: string; name: string; roles: { unitId: string; role: string; roleLabel: string; cbo: string }[] }[];
}

const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
type Rule = { key: number; weekday: number; startTime: string; endTime: string; firstVisitQuota: string; returnQuota: string };
let seq = 1;

/** Nova agenda (gestor): profissional lotado na unidade, CBO, duração do horário e grade semanal com cotas. */
export function NewScheduleDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const session = useSession();
  const toast = useToast();
  const unitId = session.me?.context.unitId;
  const dir = useApi<Directory>(open && unitId ? `/directory?unitId=${unitId}` : null);
  const [professionalId, setProfessionalId] = useState('');
  const [name, setName] = useState('');
  const [cbo, setCbo] = useState('');
  const [slot, setSlot] = useState('20');
  const [rules, setRules] = useState<Rule[]>(() => [1, 2, 3, 4, 5].map((weekday) => ({ key: seq++, weekday, startTime: '07:00', endTime: '11:00', firstVisitQuota: '6', returnQuota: '6' })));
  const [busy, setBusy] = useState(false);

  const clinicians = (dir.data?.professionals ?? []).filter((p) => p.roles.some((r) => r.unitId === unitId && ['MEDICO', 'MULTIPROFISSIONAL', 'ENFERMAGEM', 'SERVICO_SOCIAL'].includes(r.role)));
  const setRule = (key: number, patch: Partial<Rule>) => setRules((s) => s.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function save() {
    setBusy(true);
    try {
      await api.post('/scheduling/schedules', {
        professionalId,
        name: name.trim(),
        cbo,
        slotMinutes: Number(slot),
        rules: rules.map((r) => ({ weekday: r.weekday, startTime: r.startTime, endTime: r.endTime, firstVisitQuota: Number(r.firstVisitQuota), returnQuota: Number(r.returnQuota) })),
      });
      toast.success('Agenda criada');
      onOpenChange(false);
      onCreated();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Nova agenda"
      size="lg"
      footer={
        <Button onClick={save} loading={busy} disabled={!professionalId || name.trim().length < 3 || !/^\d{6}$/.test(cbo) || rules.length === 0}>
          Criar agenda
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Profissional" htmlFor="sch-prof">
            <Select
              id="sch-prof"
              value={professionalId}
              onChange={(e) => {
                const p = clinicians.find((x) => x.id === e.target.value);
                setProfessionalId(e.target.value);
                const role = p?.roles.find((r) => r.unitId === unitId);
                if (role) setCbo(role.cbo);
                if (p && !name) setName(`${role?.roleLabel ?? 'Agenda'} - ${p.name}`);
              }}
            >
              <option value="">Selecione</option>
              {clinicians.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Nome da agenda" htmlFor="sch-name">
            <Input id="sch-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="CBO (especialidade)" htmlFor="sch-cbo">
            <Input id="sch-cbo" value={cbo} onChange={(e) => setCbo(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" />
          </Field>
          <Field label="Duração de cada horário (min)" htmlFor="sch-slot">
            <Input id="sch-slot" type="number" min={5} max={120} value={slot} onChange={(e) => setSlot(e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-slate-700">Grade semanal e cotas por turno</p>
          {rules.map((r) => (
            <div key={r.key} className="grid grid-cols-2 gap-2 sm:grid-cols-[8rem_6rem_6rem_1fr_1fr_auto] sm:items-end">
              <Select value={r.weekday} onChange={(e) => setRule(r.key, { weekday: Number(e.target.value) })} aria-label="Dia da semana">
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </Select>
              <Input type="time" value={r.startTime} onChange={(e) => setRule(r.key, { startTime: e.target.value })} aria-label="Início" />
              <Input type="time" value={r.endTime} onChange={(e) => setRule(r.key, { endTime: e.target.value })} aria-label="Fim" />
              <Input type="number" min={0} value={r.firstVisitQuota} onChange={(e) => setRule(r.key, { firstVisitQuota: e.target.value })} aria-label="Cota de primeira consulta" placeholder="1ª consulta" />
              <Input type="number" min={0} value={r.returnQuota} onChange={(e) => setRule(r.key, { returnQuota: e.target.value })} aria-label="Cota de retorno" placeholder="Retorno" />
              <Button variant="ghost" size="icon" onClick={() => setRules((s) => s.filter((x) => x.key !== r.key))} aria-label="Remover turno">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <p className="text-xs text-slate-500">Colunas: dia, início, fim, cota de primeira consulta, cota de retorno.</p>
          <Button variant="secondary" className="self-start" onClick={() => setRules((s) => [...s, { key: seq++, weekday: 1, startTime: '13:00', endTime: '17:00', firstVisitQuota: '6', returnQuota: '6' }])}>
            <Plus className="h-4 w-4" /> Turno
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Bloqueio de agenda (férias, reunião, capacitação). */
export function BlockDialog({ scheduleId, date, open, onOpenChange, onDone }: { scheduleId: string; date: string; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const toast = useToast();
  const [start, setStart] = useState(`${date}T07:00`);
  const [end, setEnd] = useState(`${date}T11:00`);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const iso = (local: string) => new Date(`${local}:00-03:00`).toISOString();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Bloquear horários"
      footer={
        <Button
          loading={busy}
          disabled={reason.trim().length < 3}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.post<{ affectedAppointments: number }>(`/scheduling/schedules/${scheduleId}/blocks`, { startsAt: iso(start), endsAt: iso(end), reason });
              toast.success(r.affectedAppointments ? `Bloqueio criado: ${r.affectedAppointments} agendamento(s) precisam ser remarcados` : 'Bloqueio criado');
              onOpenChange(false);
              onDone();
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Bloquear
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Início" htmlFor="blk-start">
          <Input id="blk-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Fim" htmlFor="blk-end">
          <Input id="blk-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label="Motivo" htmlFor="blk-reason" className="sm:col-span-2">
          <Input id="blk-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
