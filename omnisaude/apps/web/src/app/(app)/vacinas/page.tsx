'use client';

import { componentesDaVacina, GRUPO_LABEL, SITUACAO_VACINAL_LABEL, type SituacaoDose, type SituacaoVacinal } from '@omnisaude/shared';
import { Download, RefreshCw, Syringe, UserRoundSearch } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { PatientSearch } from '@/components/patients/patient-search';
import { SignWithCertificate } from '@/components/signatures/sign-button';
import { useSignedDocuments } from '@/components/signatures/use-signatures';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, saveBlob } from '@/lib/api';
import { fmtDate, fmtDateTime, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { PatientSummary } from '@/lib/types';

interface Dose {
  id: string;
  vaccineCode: string;
  vaccineName: string;
  dose: string;
  lot: string;
  manufacturer: string;
  expiry: string | null;
  route: string;
  site: string | null;
  strategy: string | null;
  transcription: boolean;
  appliedAt: string;
  nextDueAt: string | null;
  unit: string | null;
  professional: string | null;
  rnds: { status: string; error?: string | null };
}
interface Cartao {
  patient: { id: string; name: string; birthDate: string; age: number; sex: string; cns: string | null; cpf: string | null; gestante: boolean };
  doses: Dose[];
  aprazamento: SituacaoDose[];
  proximas: SituacaoDose[];
  atrasadas: number;
}
interface LoteEstoque {
  locationId: string;
  locationName: string;
  locationKind: string;
  lotId: string;
  lotNumber: string;
  expiry: string;
  vencido: boolean;
  manufacturer: string | null;
  productDescription: string;
  vaccineCode: string;
  vaccineName: string;
  quantity: number;
}
interface Calendario {
  regras: {
    componente: string;
    rotulo: string;
    dose: number;
    doseCodigo: string;
    grupo: keyof typeof GRUPO_LABEL;
    estrategia: string;
    meses: number;
    idadeMaxMeses?: number;
    intervaloMinDias?: number;
    periodicidadeMeses?: number;
    semanaGestacao?: number;
  }[];
  imunobiologicos: { code: string; name: string }[];
  doses: Record<string, string>;
  estrategias: Record<string, string>;
  vias: Record<string, string>;
  locais: Record<string, string>;
  fabricantes: Record<string, string>;
}
interface Escopo {
  unidadeAtual: string;
  unidades: { id: string; name: string }[];
  equipes: { id: string; name: string; unitName: string }[];
}
interface Faltosos {
  escopo: string;
  total: number;
  faltosos: number;
  pessoas: { patientId: string; nome: string; idade: number; sexo: string; atrasadas: SituacaoDose[] }[];
}
interface Aprazamentos {
  escopo: string;
  from: string;
  to: string;
  total: number;
  doses: { patientId: string; nome: string; idade: number; dose: SituacaoDose }[];
}

const SITUACAO_TONE: Record<SituacaoVacinal, 'green' | 'amber' | 'red'> = { APLICADA: 'green', APRAZADA: 'amber', ATRASADA: 'red' };
const RNDS_LABEL: Record<string, string> = { PENDENTE: 'RNDS: na fila', ENVIADO: 'RNDS: enviada', ERRO: 'RNDS: erro', DESCARTADO: 'RNDS: descartada', NAO_SE_APLICA: 'transcrição', DESLIGADA: 'RNDS desligada' };
const RNDS_TONE: Record<string, 'slate' | 'blue' | 'green' | 'amber' | 'red'> = { PENDENTE: 'blue', ENVIADO: 'green', ERRO: 'red', DESCARTADO: 'red', NAO_SE_APLICA: 'slate', DESLIGADA: 'slate' };
const mesesLabel = (m: number) => (m === 0 ? 'ao nascer' : m < 24 ? `${m} meses` : `${Math.floor(m / 12)} anos`);
const agora = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

export default function VacinasPage() {
  const session = useSession();
  const toast = useToast();
  const [tab, setTab] = useState('sala');
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [escopo, setEscopo] = useState<{ unitId?: string; teamId?: string }>({});
  const [periodo, setPeriodo] = useState({ from: todayIso(), to: todayIso(30) });
  const cartao = useApi<Cartao>(patient ? `/vacinas/cartao?patientId=${patient.id}` : null, [patient?.id]);
  const estoque = useApi<LoteEstoque[]>('/vacinas/estoque');
  const calendario = useApi<Calendario>('/vacinas/calendario');
  const escopos = useApi<Escopo>('/programas/equipes');
  const query = new URLSearchParams({ ...(escopo.unitId ? { unitId: escopo.unitId } : {}), ...(escopo.teamId ? { teamId: escopo.teamId } : {}) });
  const faltosos = useApi<Faltosos>(tab === 'faltosos' ? `/vacinas/faltosos?${query}` : null, [tab, escopo]);
  const aprazamentos = useApi<Aprazamentos>(tab === 'aprazamentos' ? `/vacinas/aprazamentos?${query}&from=${periodo.from}&to=${periodo.to}` : null, [tab, escopo, periodo]);
  const assinados = useSignedDocuments('VaccinationCertificate', patient ? [patient.id] : []);
  const podeAplicar = session.can('vacinas.aplicar');

  const [form, setForm] = useState({
    modo: 'estoque' as 'estoque' | 'transcricao',
    lotId: '',
    vaccineCode: '',
    lotNumber: '',
    manufacturer: '',
    expiry: '',
    doseCode: '1',
    strategyCode: '1',
    routeCode: '14',
    siteCode: '',
    appliedAt: agora(),
    nextDueAt: '',
  });
  const [busy, setBusy] = useState(false);
  const lotes = (estoque.data ?? []).filter((l) => l.quantity > 0 && !l.vencido);
  const vaccineCode = form.modo === 'estoque' ? (lotes.find((l) => l.lotId === form.lotId)?.vaccineCode ?? '') : form.vaccineCode;
  const vaccineName = form.modo === 'estoque' ? (lotes.find((l) => l.lotId === form.lotId)?.vaccineName ?? '') : (calendario.data?.imunobiologicos.find((i) => i.code === form.vaccineCode)?.name ?? '');
  const sugestao = useMemo(() => {
    if (!cartao.data || !vaccineCode) return null;
    const comps = componentesDaVacina(vaccineCode, vaccineName);
    return cartao.data.proximas.find((p) => comps.includes(p.componente)) ?? null;
  }, [cartao.data, vaccineCode, vaccineName]);
  useEffect(() => {
    if (!vaccineCode) return;
    const oral = vaccineCode === '45' || vaccineCode === '65' || vaccineCode === '28';
    setForm((f) => ({
      ...f,
      doseCode: sugestao?.doseCodigo ?? f.doseCode,
      strategyCode: sugestao?.estrategia === 'CAMPANHA' ? '5' : '1',
      routeCode: oral ? '0' : '14',
      siteCode: oral ? '1' : (cartao.data?.patient.age ?? 10) < 2 ? '6' : '2',
    }));
  }, [vaccineCode, sugestao, cartao.data?.patient.age]);

  async function aplicar() {
    if (!patient) return;
    setBusy(true);
    try {
      const body = {
        patientId: patient.id,
        vaccineCode,
        doseCode: form.doseCode,
        strategyCode: form.strategyCode,
        routeCode: form.routeCode,
        ...(form.siteCode ? { siteCode: form.siteCode } : {}),
        appliedAt: new Date(form.appliedAt).toISOString(),
        ...(form.nextDueAt ? { nextDueAt: form.nextDueAt } : {}),
        ...(form.modo === 'estoque'
          ? { lotId: form.lotId }
          : {
              transcription: true,
              lotNumber: form.lotNumber,
              ...(form.manufacturer ? { manufacturer: form.manufacturer } : {}),
              ...(form.expiry ? { expiry: form.expiry } : {}),
              strategyCode: form.strategyCode === '1' ? '8' : form.strategyCode,
            }),
      };
      await api.post('/vacinas/aplicar', body);
      toast.success(`${vaccineName}: dose registrada`);
      setForm((f) => ({ ...f, lotId: '', vaccineCode: '', lotNumber: '', nextDueAt: '', appliedAt: agora() }));
      await Promise.all([cartao.reload(), estoque.reload()]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function certificado() {
    if (!patient) return;
    try {
      const { blob, fileName } = await api.download(`/vacinas/certificado?patientId=${patient.id}`);
      saveBlob(blob, fileName ?? 'certificado-vacinacao.pdf');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const escopoSelect = (
    <Field label="Escopo" htmlFor="vac-escopo">
      <Select
        id="vac-escopo"
        value={escopo.teamId ? `team:${escopo.teamId}` : escopo.unitId ? `unit:${escopo.unitId}` : ''}
        onChange={(e) => {
          const [tipo, id] = e.target.value.split(':');
          setEscopo(tipo === 'team' ? { teamId: id } : tipo === 'unit' ? { unitId: id } : {});
        }}
        className="w-80"
      >
        <option value="">Unidade atual</option>
        {(escopos.data?.unidades ?? []).map((u) => (
          <option key={u.id} value={`unit:${u.id}`}>
            Unidade · {u.name}
          </option>
        ))}
        {(escopos.data?.equipes ?? []).map((t) => (
          <option key={t.id} value={`team:${t.id}`}>
            Equipe · {t.name} ({t.unitName})
          </option>
        ))}
      </Select>
    </Field>
  );
  const doseBadge = (s: SituacaoDose) => (
    <Badge key={`${s.componente}-${s.dose}-${s.grupo}`} tone={SITUACAO_TONE[s.situacao]} className="mr-1 mb-1" title={`${GRUPO_LABEL[s.grupo]} · ${s.estrategia === 'CAMPANHA' ? 'campanha' : 'rotina'}`}>
      {s.rotulo}
      {s.prevista ? ` · ${fmtDate(s.prevista)}` : ''}
    </Badge>
  );

  return (
    <div>
      <PageHeader
        title="Vacinas"
        description="Sala de vacina com cartão e aprazamento pelo Calendário Nacional, aplicação com baixa do lote no estoque, envio à RNDS, certificado de vacinação, agenda de aprazamentos e faltosos."
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              void cartao.reload();
              void estoque.reload();
            }}
          >
            <RefreshCw className="h-4 w-4" /> Atualizar
          </Button>
        }
      />
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'sala', label: 'Sala de vacina' },
          { value: 'aprazamentos', label: 'Aprazamentos' },
          { value: 'faltosos', label: 'Faltosos' },
          { value: 'estoque', label: 'Estoque por lote' },
          { value: 'calendario', label: 'Calendário' },
        ]}
      >
        <TabPanel value="sala">
          {!patient ? (
            <Card>
              <CardHeader title="Cidadão" description="Busque pelo nome, CPF ou CNS para abrir o cartão de vacinação." />
              <CardBody>
                <PatientSearch onSelect={setPatient} autoFocus placeholder="Nome, CPF ou CNS" />
              </CardBody>
            </Card>
          ) : (
            <>
              <Card className="mb-4">
                <CardHeader
                  title={cartao.data?.patient.name ?? patient.name}
                  description={
                    cartao.data
                      ? `${fmtDate(cartao.data.patient.birthDate)} · ${cartao.data.patient.age} anos · ${cartao.data.patient.sex === 'F' ? 'feminino' : 'masculino'}${cartao.data.patient.gestante ? ' · gestante' : ''}${cartao.data.patient.cns ? ` · CNS ${cartao.data.patient.cns}` : ''}`
                      : undefined
                  }
                  actions={
                    <div className="flex flex-wrap gap-2">
                      <Button variant="ghost" onClick={() => setPatient(null)}>
                        <UserRoundSearch className="h-4 w-4" /> Trocar
                      </Button>
                      <Button variant="secondary" onClick={() => void certificado()}>
                        <Download className="h-4 w-4" /> Certificado (PDF)
                      </Button>
                      <SignWithCertificate entityType="VaccinationCertificate" entityId={patient.id} doc={assinados.byEntity.get(patient.id)} canSign={podeAplicar} onSigned={() => void assinados.reload()} />
                    </div>
                  }
                />
                {cartao.data && (
                  <div className="grid grid-cols-2 gap-3 px-4 pb-4 md:grid-cols-4">
                    <Stat label="Doses registradas" value={cartao.data.doses.length} />
                    <Stat label="Atrasadas" value={cartao.data.atrasadas} tone={cartao.data.atrasadas ? 'bad' : 'good'} />
                    <Stat label="Aprazadas" value={cartao.data.proximas.filter((p) => p.situacao === 'APRAZADA').length} />
                    <Stat label="Próxima" value={cartao.data.proximas[0] ? fmtDate(cartao.data.proximas[0].prevista ?? '') : '—'} hint={cartao.data.proximas[0]?.rotulo} />
                  </div>
                )}
              </Card>
              {cartao.error && <Alert tone="error">{String(cartao.error)}</Alert>}
              {cartao.loading && !cartao.data ? (
                <Spinner />
              ) : cartao.data ? (
                <div className="grid gap-4 lg:grid-cols-2">
                  {podeAplicar && (
                    <Card>
                      <CardHeader title="Aplicar dose" description="A dose sai do lote escolhido no estoque da sala; a transcrição registra a caderneta sem mexer no estoque." />
                      <CardBody className="grid gap-3 sm:grid-cols-2">
                        <Field label="Origem" htmlFor="vac-modo" className="sm:col-span-2">
                          <Select id="vac-modo" value={form.modo} onChange={(e) => setForm((f) => ({ ...f, modo: e.target.value as 'estoque' | 'transcricao', lotId: '', vaccineCode: '' }))}>
                            <option value="estoque">Aplicada agora, do estoque da sala</option>
                            <option value="transcricao">Transcrição da caderneta (aplicada em outro serviço)</option>
                          </Select>
                        </Field>
                        {form.modo === 'estoque' ? (
                          <Field label="Imunobiológico e lote" htmlFor="vac-lote" className="sm:col-span-2">
                            <Select id="vac-lote" value={form.lotId} onChange={(e) => setForm((f) => ({ ...f, lotId: e.target.value }))}>
                              <option value="">Escolha o lote</option>
                              {lotes.map((l) => (
                                <option key={l.lotId} value={l.lotId}>
                                  {l.vaccineName} · lote {l.lotNumber} · validade {fmtDate(l.expiry)} · {l.quantity} doses · {l.locationName}
                                </option>
                              ))}
                            </Select>
                          </Field>
                        ) : (
                          <>
                            <Field label="Imunobiológico" htmlFor="vac-imuno" className="sm:col-span-2">
                              <Select id="vac-imuno" value={form.vaccineCode} onChange={(e) => setForm((f) => ({ ...f, vaccineCode: e.target.value }))}>
                                <option value="">Escolha</option>
                                {(calendario.data?.imunobiologicos ?? []).map((i) => (
                                  <option key={i.code} value={i.code}>
                                    {i.name}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            <Field label="Lote (caderneta)" htmlFor="vac-lotenum">
                              <Input id="vac-lotenum" value={form.lotNumber} onChange={(e) => setForm((f) => ({ ...f, lotNumber: e.target.value }))} />
                            </Field>
                            <Field label="Fabricante" htmlFor="vac-fab">
                              <Input id="vac-fab" value={form.manufacturer} onChange={(e) => setForm((f) => ({ ...f, manufacturer: e.target.value }))} />
                            </Field>
                          </>
                        )}
                        <Field label="Dose" htmlFor="vac-dose" hint={sugestao ? `Sugerida pelo calendário: ${sugestao.rotulo}` : undefined}>
                          <Select id="vac-dose" value={form.doseCode} onChange={(e) => setForm((f) => ({ ...f, doseCode: e.target.value }))}>
                            {Object.entries(calendario.data?.doses ?? {})
                              .filter(([c]) => Number(c) <= 10)
                              .map(([c, l]) => (
                                <option key={c} value={c}>
                                  {l}
                                </option>
                              ))}
                          </Select>
                        </Field>
                        <Field label="Estratégia" htmlFor="vac-estr">
                          <Select id="vac-estr" value={form.strategyCode} onChange={(e) => setForm((f) => ({ ...f, strategyCode: e.target.value }))}>
                            {Object.entries(calendario.data?.estrategias ?? {}).map(([c, l]) => (
                              <option key={c} value={c}>
                                {l}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Via" htmlFor="vac-via">
                          <Select id="vac-via" value={form.routeCode} onChange={(e) => setForm((f) => ({ ...f, routeCode: e.target.value }))}>
                            {Object.entries(calendario.data?.vias ?? {})
                              .filter(([c]) => ['0', '13', '14', '17', '23', '27'].includes(c))
                              .map(([c, l]) => (
                                <option key={c} value={c}>
                                  {l}
                                </option>
                              ))}
                          </Select>
                        </Field>
                        <Field label="Local de aplicação" htmlFor="vac-local">
                          <Select id="vac-local" value={form.siteCode} onChange={(e) => setForm((f) => ({ ...f, siteCode: e.target.value }))}>
                            <option value="">—</option>
                            {Object.entries(calendario.data?.locais ?? {}).map(([c, l]) => (
                              <option key={c} value={c}>
                                {l}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Data e hora" htmlFor="vac-data">
                          <Input id="vac-data" type="datetime-local" value={form.appliedAt} max={agora()} onChange={(e) => setForm((f) => ({ ...f, appliedAt: e.target.value }))} />
                        </Field>
                        <Field label="Aprazamento (próxima dose)" htmlFor="vac-apr">
                          <Input id="vac-apr" type="date" value={form.nextDueAt} min={todayIso()} onChange={(e) => setForm((f) => ({ ...f, nextDueAt: e.target.value }))} />
                        </Field>
                        <div className="sm:col-span-2">
                          <Button onClick={() => void aplicar()} loading={busy} disabled={!vaccineCode || (form.modo === 'transcricao' && !form.lotNumber.trim())}>
                            <Syringe className="h-4 w-4" /> Registrar dose
                          </Button>
                        </div>
                      </CardBody>
                    </Card>
                  )}
                  <Card>
                    <CardHeader title="Aprazamento pelo calendário" description="Próxima dose pendente de cada vacina; depois, o que já foi aplicado." />
                    <CardBody className="text-sm">
                      {cartao.data.proximas.length === 0 ? <Badge tone="green">Calendário em dia</Badge> : cartao.data.proximas.map(doseBadge)}
                      <p className="mt-3 text-xs text-slate-500">Aplicadas: {cartao.data.aprazamento.filter((s) => s.situacao === 'APLICADA').length} doses do calendário.</p>
                      <div className="mt-1">{cartao.data.aprazamento.filter((s) => s.situacao === 'APLICADA').map(doseBadge)}</div>
                    </CardBody>
                  </Card>
                  <Card className="lg:col-span-2">
                    <CardHeader title="Doses registradas" />
                    {cartao.data.doses.length === 0 ? (
                      <EmptyState icon={<Syringe className="h-8 w-8" />} title="Nenhuma dose registrada" />
                    ) : (
                      <Table>
                        <THead>
                          <TR>
                            <TH>Data</TH>
                            <TH>Vacina</TH>
                            <TH>Dose</TH>
                            <TH>Lote</TH>
                            <TH>Via / local</TH>
                            <TH>Onde</TH>
                            <TH>Situação</TH>
                          </TR>
                        </THead>
                        <TBody>
                          {cartao.data.doses.map((d) => (
                            <TR key={d.id}>
                              <TD className="whitespace-nowrap text-sm">{fmtDateTime(d.appliedAt)}</TD>
                              <TD className="text-sm">
                                {d.vaccineName}
                                {d.strategy && <span className="block text-xs text-slate-500">{d.strategy}</span>}
                              </TD>
                              <TD className="text-sm">
                                {d.dose}
                                {d.nextDueAt && <span className="block text-xs text-slate-500">próxima: {fmtDate(d.nextDueAt)}</span>}
                              </TD>
                              <TD className="text-xs">
                                {d.lot} · {d.manufacturer}
                                {d.expiry && <span className="block text-slate-500">validade {fmtDate(d.expiry)}</span>}
                              </TD>
                              <TD className="text-xs">
                                {d.route}
                                {d.site ? ` · ${d.site}` : ''}
                              </TD>
                              <TD className="text-xs">
                                {d.transcription ? 'Caderneta (outro serviço)' : d.unit}
                                {d.professional && <span className="block text-slate-500">{d.professional}</span>}
                              </TD>
                              <TD>
                                <Badge tone={RNDS_TONE[d.rnds.status] ?? 'slate'} title={d.rnds.error ?? undefined}>
                                  {RNDS_LABEL[d.rnds.status] ?? d.rnds.status}
                                </Badge>
                              </TD>
                            </TR>
                          ))}
                        </TBody>
                      </Table>
                    )}
                  </Card>
                </div>
              ) : null}
            </>
          )}
        </TabPanel>
        <TabPanel value="aprazamentos">
          <Card className="mb-4">
            <CardBody className="flex flex-wrap items-end gap-3">
              {escopoSelect}
              <Field label="De" htmlFor="apr-de">
                <Input id="apr-de" type="date" value={periodo.from} onChange={(e) => setPeriodo((p) => ({ ...p, from: e.target.value }))} />
              </Field>
              <Field label="Até" htmlFor="apr-ate">
                <Input id="apr-ate" type="date" value={periodo.to} onChange={(e) => setPeriodo((p) => ({ ...p, to: e.target.value }))} />
              </Field>
            </CardBody>
          </Card>
          {aprazamentos.loading && !aprazamentos.data ? (
            <Spinner />
          ) : aprazamentos.data ? (
            <Card>
              <CardHeader title="Doses aprazadas" description={`${aprazamentos.data.escopo} · ${fmtDate(aprazamentos.data.from)} a ${fmtDate(aprazamentos.data.to)} · ${aprazamentos.data.total} dose(s)`} />
              {aprazamentos.data.doses.length === 0 ? (
                <EmptyState title="Nenhuma dose aprazada no período" />
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Prevista</TH>
                      <TH>Pessoa</TH>
                      <TH>Dose</TH>
                      <TH>Situação</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {aprazamentos.data.doses.map((r, i) => (
                      <TR key={`${r.patientId}-${i}`}>
                        <TD className="whitespace-nowrap">{fmtDate(r.dose.prevista ?? '')}</TD>
                        <TD>
                          <a className="font-medium text-brand-700 underline" href={`/paciente?id=${r.patientId}`}>
                            {r.nome}
                          </a>
                          <span className="block text-xs text-slate-500">{r.idade} anos</span>
                        </TD>
                        <TD className="text-sm">{r.dose.rotulo}</TD>
                        <TD>
                          <Badge tone={SITUACAO_TONE[r.dose.situacao]}>{SITUACAO_VACINAL_LABEL[r.dose.situacao]}</Badge>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>
          ) : null}
        </TabPanel>
        <TabPanel value="faltosos">
          <Card className="mb-4">
            <CardBody className="flex flex-wrap items-end gap-3">{escopoSelect}</CardBody>
          </Card>
          {faltosos.loading && !faltosos.data ? (
            <Spinner />
          ) : faltosos.data ? (
            <Card>
              <CardHeader
                title="Faltosos da vacinação"
                description={`${faltosos.data.escopo} · ${faltosos.data.faltosos} de ${faltosos.data.total} pessoas vinculadas com dose atrasada. O acesso à lista fica na auditoria.`}
              />
              {faltosos.data.pessoas.length === 0 ? (
                <EmptyState title="Ninguém com dose atrasada" />
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Pessoa</TH>
                      <TH>Doses atrasadas</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {faltosos.data.pessoas.map((p) => (
                      <TR key={p.patientId}>
                        <TD>
                          <a className="font-medium text-brand-700 underline" href={`/paciente?id=${p.patientId}`}>
                            {p.nome}
                          </a>
                          <span className="block text-xs text-slate-500">
                            {p.idade} anos · {p.sexo === 'F' ? 'feminino' : 'masculino'}
                          </span>
                        </TD>
                        <TD className="text-xs">{p.atrasadas.map(doseBadge)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>
          ) : null}
        </TabPanel>
        <TabPanel value="estoque">
          <Card>
            <CardHeader title="Imunobiológicos em estoque" description="Lotes dos locais de estoque da unidade (a sala de vacina primeiro). Entradas pela nota fiscal ou transferência da farmácia." />
            {estoque.data?.length ? (
              <Table>
                <THead>
                  <TR>
                    <TH>Vacina</TH>
                    <TH>Lote</TH>
                    <TH>Validade</TH>
                    <TH>Fabricante</TH>
                    <TH>Local</TH>
                    <TH>Saldo</TH>
                  </TR>
                </THead>
                <TBody>
                  {estoque.data.map((l) => (
                    <TR key={`${l.locationId}-${l.lotId}`}>
                      <TD className="text-sm">{l.vaccineName}</TD>
                      <TD className="font-mono text-xs">{l.lotNumber}</TD>
                      <TD className="text-sm">
                        {fmtDate(l.expiry)} {l.vencido && <Badge tone="red">vencido</Badge>}
                      </TD>
                      <TD className="text-xs">{l.manufacturer ?? '—'}</TD>
                      <TD className="text-xs">{l.locationName}</TD>
                      <TD>{l.quantity}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <EmptyState title="Sem vacinas em estoque nesta unidade" description="Cadastre o produto com o código do imunobiológico e dê entrada no lote." />
            )}
          </Card>
        </TabPanel>
        <TabPanel value="calendario">
          <Card>
            <CardHeader title="Calendário Nacional de Vacinação" description="Regras usadas no aprazamento, por grupo. Idades em meses contados do nascimento; intervalos mínimos desde a dose anterior." />
            {calendario.data ? (
              <Table>
                <THead>
                  <TR>
                    <TH>Grupo</TH>
                    <TH>Vacina e dose</TH>
                    <TH>Idade</TH>
                    <TH>Regra</TH>
                    <TH>Estratégia</TH>
                  </TR>
                </THead>
                <TBody>
                  {calendario.data.regras.map((r, i) => (
                    <TR key={i}>
                      <TD className="text-sm">{GRUPO_LABEL[r.grupo]}</TD>
                      <TD className="text-sm">{r.rotulo}</TD>
                      <TD className="text-sm">
                        {r.semanaGestacao !== undefined ? `a partir de ${r.semanaGestacao} semanas de gestação` : `${mesesLabel(r.meses)}${r.idadeMaxMeses ? ` até ${mesesLabel(r.idadeMaxMeses + 1)}` : ''}`}
                      </TD>
                      <TD className="text-xs text-slate-600">
                        {[r.intervaloMinDias ? `intervalo mínimo de ${r.intervaloMinDias} dias` : null, r.periodicidadeMeses ? `a cada ${r.periodicidadeMeses} meses` : null, `código de dose ${r.doseCodigo}`]
                          .filter(Boolean)
                          .join(' · ')}
                      </TD>
                      <TD className="text-xs">{r.estrategia === 'CAMPANHA' ? 'Campanha' : 'Rotina'}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <Spinner />
            )}
          </Card>
        </TabPanel>
      </Tabs>
    </div>
  );
}
