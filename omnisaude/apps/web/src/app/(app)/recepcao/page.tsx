'use client';

import { ExternalLink, IdCard, LogIn, MonitorPlay, Printer, Ticket as TicketIcon, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PrintPortal, printSoon } from '@/components/patients/print-portal';
import { PatientSearch } from '@/components/patients/patient-search';
import type { Wristband } from '@/components/patients/types';
import { WristbandLabel } from '@/components/patients/wristband';
import { NewPatientForm } from '@/components/reception/patient-form';
import { TicketsPanel, type Ticket } from '@/components/reception/tickets-panel';
import { AppointmentsList, type Appointment } from '@/components/scheduling/appointments-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, PageHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, errorMessage } from '@/lib/api';
import { fmtDate, formatCns, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { PatientSummary } from '@/lib/types';

export default function ReceptionPage() {
  const session = useSession();
  const toast = useToast();
  const [tab, setTab] = useState('atendimento');
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [kind, setKind] = useState<'URGENCIA' | 'AMBULATORIAL' | 'ODONTOLOGICO'>(session.me?.context.unitType === 'UPA' ? 'URGENCIA' : 'AMBULATORIAL');
  const [checking, setChecking] = useState(false);
  const [checkInMsg, setCheckInMsg] = useState<string | null>(null);
  const [band, setBand] = useState<Wristband | null>(null);
  const [panelUrl, setPanelUrl] = useState<string | null>(null);
  const today = useApi<Appointment[]>(session.can('agenda.ler') ? `/scheduling/appointments?date=${todayIso()}` : null);

  async function checkIn() {
    if (!patient) return;
    setChecking(true);
    setCheckInMsg(null);
    try {
      await api.post('/reception/check-in', { patientId: patient.id, kind, ...(ticket ? { ticketId: ticket.id } : {}) });
      toast.success(`${patient.name} acolhido(a)${kind === 'URGENCIA' ? ': aguardando classificação de risco' : ''}.`);
      setTicket(null);
      setPatient(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ATENDIMENTO_ABERTO') setCheckInMsg('Este paciente já tem um atendimento aberto nesta unidade.');
      else toast.error(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  async function printBand(p: PatientSummary) {
    try {
      setBand(await api.get<Wristband>(`/patients/${p.id}/wristband`));
      printSoon();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function openPanel() {
    try {
      const r = await api.post<{ token: string }>('/reception/panel-token');
      setPanelUrl(`${window.location.origin}/painel?token=${encodeURIComponent(r.token)}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader
        title="Recepção e acolhimento"
        description={session.me?.context.unitName}
        actions={
          session.can('fila.chamar') && (
            <Button variant="secondary" onClick={openPanel}>
              <MonitorPlay className="h-4 w-4" /> Painel da TV
            </Button>
          )
        }
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <Tabs
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: 'atendimento', label: 'Acolhimento' },
            { value: 'cadastro', label: 'Novo cadastro' },
            { value: 'agenda', label: `Agendados hoje${today.data ? ` (${today.data.length})` : ''}` },
          ]}
        >
          <TabPanel value="atendimento" className="flex flex-col gap-4">
            <Card>
              <CardHeader title="Paciente" description="Busque pelo nome (sem acento), CPF ou CNS. Não encontrou? Use “Novo cadastro”." />
              <CardBody className="flex flex-col gap-4">
                <PatientSearch onSelect={setPatient} autoFocus />
                {patient && (
                  <div className="flex flex-col gap-4 rounded-lg border border-slate-200 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-lg font-semibold">{patient.name}</p>
                        <p className="text-sm text-slate-600">
                          {fmtDate(patient.birthDate)} · {patient.age} anos · {patient.sex === 'F' ? 'Feminino' : 'Masculino'}
                          {patient.cns ? ` · CNS ${formatCns(patient.cns)}` : ' · sem CNS'}
                        </p>
                        {patient.motherName && <p className="text-sm text-slate-500">Mãe: {patient.motherName}</p>}
                      </div>
                      <Button variant="ghost" size="icon" onClick={() => setPatient(null)} aria-label="Limpar seleção">
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                      <Field label="Tipo de atendimento" htmlFor="kind">
                        <Select id="kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                          <option value="URGENCIA">Demanda espontânea / urgência (classificação de risco)</option>
                          <option value="AMBULATORIAL">Ambulatorial</option>
                          <option value="ODONTOLOGICO">Odontológico</option>
                        </Select>
                      </Field>
                      <div className="text-sm">
                        <p className="font-medium text-slate-700">Senha</p>
                        {ticket ? (
                          <p className="mt-2 flex items-center gap-2">
                            <TicketIcon className="h-4 w-4" /> <b>{ticket.code}</b>
                            <button className="text-xs text-brand-700 underline" onClick={() => setTicket(null)}>
                              remover
                            </button>
                          </p>
                        ) : (
                          <p className="mt-2 text-slate-500">Selecione “Acolher” numa senha (opcional)</p>
                        )}
                      </div>
                      <Button size="lg" onClick={checkIn} loading={checking}>
                        <LogIn className="h-4 w-4" /> Acolher paciente
                      </Button>
                    </div>
                    {checkInMsg && <Alert tone="warn">{checkInMsg}</Alert>}
                    <div className="flex flex-wrap gap-2">
                      {session.can('pulseira.emitir') && (
                        <Button variant="secondary" onClick={() => printBand(patient)}>
                          <Printer className="h-4 w-4" /> Imprimir pulseira
                        </Button>
                      )}
                      {session.can('prontuario.ler') && (
                        <Link href={`/paciente?id=${patient.id}`}>
                          <Button variant="ghost">
                            <IdCard className="h-4 w-4" /> Cadastro completo
                          </Button>
                        </Link>
                      )}
                    </div>
                  </div>
                )}
              </CardBody>
            </Card>
          </TabPanel>
          <TabPanel value="cadastro">
            {session.can('paciente.cadastrar') ? (
              <NewPatientForm
                onCreated={(p) => {
                  setPatient(p);
                  setTab('atendimento');
                }}
              />
            ) : (
              <Alert tone="info">Seu papel não cadastra pacientes.</Alert>
            )}
          </TabPanel>
          <TabPanel value="agenda">
            <Card>
              <CardHeader title="Consultas agendadas para hoje" description="Confirme presença, registre a chegada (abre o atendimento) ou a falta." />
              <CardBody>{today.loading && !today.data ? <Spinner /> : <AppointmentsList items={today.data ?? []} onChanged={() => void today.reload()} />}</CardBody>
            </Card>
          </TabPanel>
        </Tabs>
        {session.can('fila.chamar') && (
          <TicketsPanel
            selectedId={ticket?.id}
            onSelect={(t) => {
              setTicket(t);
              setTab('atendimento');
            }}
          />
        )}
      </div>
      {band && (
        <PrintPortal>
          <WristbandLabel data={band} />
        </PrintPortal>
      )}
      <Dialog open={!!panelUrl} onOpenChange={(o) => !o && setPanelUrl(null)} title="Painel de chamada (TV)" description="Abra este endereço na TV da sala de espera. O acesso vale por 30 dias e só mostra as chamadas desta unidade.">
        {panelUrl && (
          <div className="flex flex-col gap-3">
            <Input readOnly value={panelUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Endereço do painel" />
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard?.writeText(panelUrl);
                  toast.success('Endereço copiado');
                }}
              >
                Copiar
              </Button>
              <a href={panelUrl} target="_blank" rel="noreferrer">
                <Button>
                  <ExternalLink className="h-4 w-4" /> Abrir painel
                </Button>
              </a>
            </div>
            <Badge tone="amber">Na TV, clique uma vez na tela para liberar o som das chamadas.</Badge>
          </div>
        )}
      </Dialog>
    </>
  );
}
