'use client';

import { CalendarPlus, ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PatientSearch } from '@/components/patients/patient-search';
import { AppointmentsList, type Appointment } from '@/components/scheduling/appointments-list';
import { BlockDialog, NewScheduleDialog } from '@/components/scheduling/schedule-form';
import { SlotPicker, type Slot } from '@/components/scheduling/slot-picker';
import { Waitlist } from '@/components/scheduling/waitlist';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, errorMessage } from '@/lib/api';
import { fmtDate, fmtTime, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';
import type { PatientSummary } from '@/lib/types';

interface Schedule {
  id: string;
  name: string;
  cbo: string;
  slotMinutes: number;
  professionalId: string;
  rules: { weekday: number; startTime: string; endTime: string; firstVisitQuota: number; returnQuota: number }[];
}

function shift(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function AgendaPage() {
  const session = useSession();
  const toast = useToast();
  const schedules = useApi<Schedule[]>('/scheduling/schedules');
  const [scheduleId, setScheduleId] = useState('');
  const [date, setDate] = useState(todayIso());
  const [tab, setTab] = useState('dia');
  const [refresh, setRefresh] = useState(0);
  const [booking, setBooking] = useState<Slot | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [kind, setKind] = useState<'PRIMEIRA_CONSULTA' | 'RETORNO'>('RETORNO');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [from, setFrom] = useState(todayIso(-30));
  const [to, setTo] = useState(todayIso(1));
  const appts = useApi<Appointment[]>(scheduleId ? `/scheduling/appointments?date=${date}&scheduleId=${scheduleId}` : null, [refresh]);
  const absent = useApi<{ scheduleId: string; schedule: string; total: number; noShow: number; attended: number; noShowRate: number }[]>(tab === 'faltas' ? `/scheduling/absenteeism?from=${from}&to=${to}` : null);

  useEffect(() => {
    if (!scheduleId && schedules.data?.[0]) setScheduleId(schedules.data[0].id);
  }, [schedules.data, scheduleId]);
  useRealtime('agenda.vaga_liberada', () => setRefresh((r) => r + 1));

  const schedule = schedules.data?.find((s) => s.id === scheduleId);
  const bump = () => {
    setRefresh((r) => r + 1);
    void appts.reload();
  };

  async function book() {
    if (!booking || !patient) return;
    setBusy(true);
    try {
      await api.post('/scheduling/appointments', { scheduleId, patientId: patient.id, startsAt: booking.startsAt, kind, ...(notes.trim() ? { notes: notes.trim() } : {}) });
      toast.success(`${patient.name} agendado(a) para ${fmtDate(booking.startsAt)} às ${fmtTime(booking.startsAt)}`);
      setBooking(null);
      setPatient(null);
      setNotes('');
      bump();
    } catch (err) {
      toast.error(err instanceof ApiError && err.code === 'COTA_ESGOTADA' ? `${err.message}. Inclua na lista de espera.` : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Agenda"
        description={session.me?.context.unitName}
        actions={
          session.can('agenda.gerir') && (
            <>
              <Button variant="secondary" onClick={() => setNewOpen(true)}>
                <CalendarPlus className="h-4 w-4" /> Nova agenda
              </Button>
              {scheduleId && (
                <Button variant="secondary" onClick={() => setBlockOpen(true)}>
                  <Lock className="h-4 w-4" /> Bloquear horários
                </Button>
              )}
            </>
          )
        }
      />
      {schedules.error && <Alert tone="error">{schedules.error}</Alert>}
      {schedules.loading && !schedules.data ? (
        <Spinner />
      ) : !schedules.data?.length ? (
        <EmptyState title="Nenhuma agenda nesta unidade" description={session.can('agenda.gerir') ? 'Crie uma agenda em “Nova agenda”.' : 'Peça à gestão para configurar as agendas.'} />
      ) : (
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: 'dia', label: 'Horários do dia' },
            { value: 'espera', label: 'Lista de espera' },
            { value: 'faltas', label: 'Absenteísmo' },
          ]}
        >
          <TabPanel value="dia" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Agenda" htmlFor="ag-schedule" className="min-w-64 flex-1">
                <Select id="ag-schedule" value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}>
                  {schedules.data.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · CBO {s.cbo}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end gap-1">
                <Button variant="secondary" size="icon" onClick={() => setDate((d) => shift(d, -1))} aria-label="Dia anterior">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Field label="Data" htmlFor="ag-date">
                  <Input id="ag-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
                <Button variant="secondary" size="icon" onClick={() => setDate((d) => shift(d, 1))} aria-label="Próximo dia">
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button variant="ghost" onClick={() => setDate(todayIso())}>
                  Hoje
                </Button>
              </div>
            </div>
            {schedule && (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <Card>
                  <CardHeader title={`Horários · ${fmtDate(date)}`} description={`${schedule.slotMinutes} min por horário. Toque num horário livre para marcar.`} />
                  <CardBody>
                    <SlotPicker scheduleId={schedule.id} date={date} refreshKey={refresh} onPick={session.can('agenda.marcar') ? setBooking : undefined} />
                  </CardBody>
                </Card>
                <Card>
                  <CardHeader title="Agendados" />
                  <CardBody>{appts.loading && !appts.data ? <Spinner /> : <AppointmentsList items={appts.data ?? []} onChanged={bump} />}</CardBody>
                </Card>
              </div>
            )}
          </TabPanel>
          <TabPanel value="espera">
            <Card>
              <CardBody>
                <Waitlist defaultCbo={schedule?.cbo} />
              </CardBody>
            </Card>
          </TabPanel>
          <TabPanel value="faltas">
            <Card>
              <CardBody className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-3">
                  <Field label="De" htmlFor="ab-from">
                    <Input id="ab-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                  </Field>
                  <Field label="Até" htmlFor="ab-to">
                    <Input id="ab-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                  </Field>
                </div>
                {absent.loading && !absent.data ? (
                  <Spinner />
                ) : !absent.data?.length ? (
                  <EmptyState title="Sem agendamentos no período" />
                ) : (
                  <Table>
                    <THead>
                      <tr>
                        <TH>Agenda</TH>
                        <TH>Agendados</TH>
                        <TH>Compareceram</TH>
                        <TH>Faltas</TH>
                        <TH>Taxa de falta</TH>
                      </tr>
                    </THead>
                    <TBody>
                      {absent.data.map((r) => (
                        <TR key={r.scheduleId}>
                          <TD>{r.schedule}</TD>
                          <TD>{r.total}</TD>
                          <TD>{r.attended}</TD>
                          <TD>{r.noShow}</TD>
                          <TD>
                            <Badge tone={r.noShowRate >= 20 ? 'red' : r.noShowRate >= 10 ? 'amber' : 'green'}>{r.noShowRate.toLocaleString('pt-BR')}%</Badge>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </CardBody>
            </Card>
          </TabPanel>
        </Tabs>
      )}
      <Dialog
        open={!!booking}
        onOpenChange={(o) => !o && setBooking(null)}
        title={booking ? `Marcar ${fmtDate(booking.startsAt)} às ${fmtTime(booking.startsAt)}` : 'Marcar'}
        description={schedule?.name}
        footer={
          <Button onClick={book} loading={busy} disabled={!patient}>
            Confirmar marcação
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label={patient ? `Paciente: ${patient.name}` : 'Paciente'}>
            <PatientSearch onSelect={setPatient} autoFocus />
          </Field>
          <Field label="Tipo" htmlFor="bk-kind">
            <Select id="bk-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="PRIMEIRA_CONSULTA">Primeira consulta</option>
              <option value="RETORNO">Retorno</option>
            </Select>
          </Field>
          <Field label="Observações" htmlFor="bk-notes">
            <Input id="bk-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <p className="text-xs text-slate-500">Pacientes que aceitam WhatsApp recebem a confirmação 48h antes (nunca entre 22h e 6h).</p>
        </div>
      </Dialog>
      <NewScheduleDialog open={newOpen} onOpenChange={setNewOpen} onCreated={() => void schedules.reload()} />
      {scheduleId && <BlockDialog scheduleId={scheduleId} date={date} open={blockOpen} onOpenChange={setBlockOpen} onDone={bump} />}
    </>
  );
}
