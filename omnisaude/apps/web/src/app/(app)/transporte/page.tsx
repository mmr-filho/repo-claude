'use client';

import { STATUS_VIAGEM, type StatusViagem } from '@omnisaude/shared';
import { Bus, Plus, RefreshCw, Wrench } from 'lucide-react';
import { useState } from 'react';
import { MotoristaDialog, PassageiroDialog, RegistrosDialog, RotaDialog, VeiculoDialog, ViagemDialog } from '@/components/transport/dialogs';
import { STATUS_PASSAGEIRO_TONE, STATUS_VIAGEM_TONE, type Motorista, type Rota, type Veiculo, type Viagem } from '@/components/transport/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtMoney, fmtTime, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

interface Roteiro {
  date: string;
  viagens: Viagem[];
  totais: { viagens: number; passageiros: number; cadeirantes: number };
  alertas: string[];
}
interface Indicadores {
  from: string;
  to: string;
  porVeiculo: { vehicleId: string; plate: string; model: string; viagens: number; km: number; passageiros: number; faltas: number; combustivel: number; manutencao: number; custoPorKm: number | null }[];
  totais: { viagens: number; km: number; passageiros: number; faltas: number; custo: number };
}

/** Transporte sanitário: roteiro do dia, viagens, frota, motoristas, rotas e indicadores. */
export default function TransportePage() {
  const session = useSession();
  const gere = session.can('transporte.gerir');
  const toast = useToast();
  const [tab, setTab] = useState('roteiro');
  const [data, setData] = useState(todayIso());
  const [de, setDe] = useState(todayIso(-7));
  const [ate, setAte] = useState(todayIso(30));
  const [statusF, setStatusF] = useState<StatusViagem | ''>('');
  const [viagemAberta, setViagemAberta] = useState<string | null>(null);
  const [novaViagem, setNovaViagem] = useState(false);
  const [passageiroEm, setPassageiroEm] = useState<string | null>(null);
  const [veiculoDlg, setVeiculoDlg] = useState<{ aberto: boolean; v: Veiculo | null }>({ aberto: false, v: null });
  const [registrosDe, setRegistrosDe] = useState<Veiculo | null>(null);
  const [motoristaDlg, setMotoristaDlg] = useState<{ aberto: boolean; m: Motorista | null }>({ aberto: false, m: null });
  const [rotaDlg, setRotaDlg] = useState<{ aberto: boolean; r: Rota | null }>({ aberto: false, r: null });
  const [concluindo, setConcluindo] = useState<{ odometerEnd: string; fuelLiters: string; fuelCost: string; notes: string } | null>(null);
  const [kmInicio, setKmInicio] = useState('');
  const [busy, setBusy] = useState(false);

  const frota = useApi<{ veiculos: Veiculo[]; alertas: string[] }>('/transporte/veiculos');
  const motoristas = useApi<Motorista[]>('/transporte/motoristas');
  const rotas = useApi<Rota[]>('/transporte/rotas');
  const roteiro = useApi<Roteiro>(`/transporte/roteiro?date=${data}`, [data]);
  const viagens = useApi<Viagem[]>(`/transporte/viagens?from=${de}&to=${ate}${statusF ? `&status=${statusF}` : ''}`, [de, ate, statusF]);
  const detalhe = useApi<Viagem>(viagemAberta ? `/transporte/viagens/${viagemAberta}` : null, [viagemAberta]);
  const ind = useApi<Indicadores>(tab === 'indicadores' ? `/transporte/indicadores?from=${todayIso(-30)}&to=${todayIso()}` : null, [tab]);

  const recarregar = () => {
    void roteiro.reload();
    void viagens.reload();
    void frota.reload();
    if (viagemAberta) void detalhe.reload();
  };

  async function acao(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      recarregar();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const v = detalhe.data;
  const veiculos = frota.data?.veiculos ?? [];

  function ViagemLinha({ x, onClick }: { x: Viagem; onClick: () => void }) {
    return (
      <TR className="cursor-pointer" onClick={onClick}>
        <TD className="whitespace-nowrap text-xs">
          {fmtDate(x.date)} {x.departureTime}
        </TD>
        <TD>
          {x.destinationCity}/{x.destinationUf}
          {x.destinationPlace && <span className="block text-xs text-slate-500">{x.destinationPlace}</span>}
          {x.route && <span className="block text-xs text-slate-500">Rota {x.route.name}</span>}
        </TD>
        <TD className="text-xs">
          {x.vehicle.plate} · {x.vehicle.model}
          <span className="block text-slate-500">{x.driver.name}</span>
        </TD>
        <TD className="text-xs">
          {x.ocupacao.usados}/{x.ocupacao.assentos}
          {x.ocupacao.cadeirantes > 0 && <span className="block text-slate-500">{x.ocupacao.cadeirantes} cadeirante(s)</span>}
        </TD>
        <TD>
          <Badge tone={STATUS_VIAGEM_TONE[x.status]}>{x.statusLabel}</Badge>
        </TD>
      </TR>
    );
  }

  const cabecalho = (
    <THead>
      <TR>
        <TH>Saída</TH>
        <TH>Destino</TH>
        <TH>Veículo / motorista</TH>
        <TH>Ocupação</TH>
        <TH>Situação</TH>
      </TR>
    </THead>
  );

  return (
    <>
      <PageHeader
        title="Transporte sanitário"
        description="Frota, motoristas, rotas, viagens com passageiros, roteiro do dia, manutenção e abastecimento."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={recarregar}>
              <RefreshCw className="h-4 w-4" /> Atualizar
            </Button>
            {gere && (
              <Button onClick={() => setNovaViagem(true)} id="viagem-nova">
                <Plus className="h-4 w-4" /> Nova viagem
              </Button>
            )}
          </div>
        }
      />
      {frota.data && frota.data.alertas.length > 0 && (
        <Alert tone="warn" className="mb-4" title="Alertas da frota">
          <ul className="list-disc pl-4">
            {frota.data.alertas.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </Alert>
      )}
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'roteiro', label: 'Roteiro do dia' },
          { value: 'viagens', label: 'Viagens' },
          { value: 'frota', label: 'Frota' },
          { value: 'motoristas', label: 'Motoristas' },
          { value: 'rotas', label: 'Rotas' },
          { value: 'indicadores', label: 'Indicadores' },
        ]}
      >
        <TabPanel value="roteiro">
          <Card>
            <CardHeader
              title="Roteiro do dia"
              description={
                roteiro.data
                  ? `${roteiro.data.totais.viagens} viagem(ns) · ${roteiro.data.totais.passageiros} passageiro(s)${roteiro.data.totais.cadeirantes ? ` · ${roteiro.data.totais.cadeirantes} cadeirante(s)` : ''}`
                  : undefined
              }
              actions={<Input type="date" value={data} onChange={(e) => setData(e.target.value)} aria-label="Data" className="w-44" />}
            />
            <CardBody className="flex flex-col gap-4">
              {roteiro.error && <Alert tone="error">{roteiro.error}</Alert>}
              {roteiro.loading && !roteiro.data && <Spinner />}
              {roteiro.data && roteiro.data.viagens.length === 0 && <EmptyState title="Nenhuma viagem neste dia" icon={<Bus className="h-8 w-8" />} />}
              {roteiro.data?.viagens.map((x) => (
                <div key={x.id} className="rounded-lg border border-slate-200">
                  <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2">
                    <b>
                      {x.departureTime} · {x.destinationCity}/{x.destinationUf}
                    </b>
                    {x.destinationPlace && <span className="text-sm text-slate-600">{x.destinationPlace}</span>}
                    <Badge tone={STATUS_VIAGEM_TONE[x.status]}>{x.statusLabel}</Badge>
                    <span className="ml-auto text-sm text-slate-600">
                      {x.vehicle.plate} · {x.vehicle.model} · {x.driver.name}
                      {x.driver.phone ? ` (${x.driver.phone})` : ''} · {x.ocupacao.usados}/{x.ocupacao.assentos}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setViagemAberta(x.id)}>
                      Abrir
                    </Button>
                  </div>
                  {x.passageiros.filter((p) => p.status !== 'CANCELADO').length === 0 ? (
                    <p className="px-4 py-3 text-sm text-slate-500">Sem passageiros.</p>
                  ) : (
                    <Table>
                      <THead>
                        <TR>
                          <TH>Passageiro</TH>
                          <TH>Embarque</TH>
                          <TH>Atendimento</TH>
                          <TH>Situação</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {x.passageiros
                          .filter((p) => p.status !== 'CANCELADO')
                          .map((p) => (
                            <TR key={p.id}>
                              <TD>
                                {p.paciente.name}
                                <span className="block text-xs text-slate-500">
                                  {p.paciente.phone ?? 'sem telefone'}
                                  {p.companionName ? ` · acomp. ${p.companionName}` : ''}
                                  {p.wheelchair ? ' · cadeirante' : ''}
                                  {p.tfdId ? ' · TFD' : ''}
                                </span>
                              </TD>
                              <TD className="text-xs">{p.pickupAddress ?? '—'}</TD>
                              <TD className="text-xs">
                                {p.appointmentAt ? fmtDateTime(p.appointmentAt) : '—'}
                                {p.appointmentPlace && <span className="block text-slate-500">{p.appointmentPlace}</span>}
                              </TD>
                              <TD>
                                <Badge tone={STATUS_PASSAGEIRO_TONE[p.status]}>{p.statusLabel}</Badge>
                              </TD>
                            </TR>
                          ))}
                      </TBody>
                    </Table>
                  )}
                </div>
              ))}
            </CardBody>
          </Card>
        </TabPanel>
        <TabPanel value="viagens">
          <Card>
            <CardHeader
              title="Viagens"
              actions={
                <div className="flex flex-wrap gap-2">
                  <Input type="date" value={de} onChange={(e) => setDe(e.target.value)} aria-label="De" className="w-40" />
                  <Input type="date" value={ate} onChange={(e) => setAte(e.target.value)} aria-label="Até" className="w-40" />
                  <Select value={statusF} onChange={(e) => setStatusF(e.target.value as StatusViagem | '')} aria-label="Situação" className="w-44">
                    <option value="">Todas</option>
                    {(Object.keys(STATUS_VIAGEM) as StatusViagem[]).map((s) => (
                      <option key={s} value={s}>
                        {STATUS_VIAGEM[s]}
                      </option>
                    ))}
                  </Select>
                </div>
              }
            />
            <CardBody className="p-0">
              {viagens.error && (
                <Alert tone="error" className="m-4">
                  {viagens.error}
                </Alert>
              )}
              {viagens.loading && !viagens.data && <Spinner />}
              {viagens.data && viagens.data.length === 0 && <EmptyState title="Nenhuma viagem no período" icon={<Bus className="h-8 w-8" />} />}
              {viagens.data && viagens.data.length > 0 && (
                <Table>
                  {cabecalho}
                  <TBody>
                    {viagens.data.map((x) => (
                      <ViagemLinha key={x.id} x={x} onClick={() => setViagemAberta(x.id)} />
                    ))}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>
        </TabPanel>
        <TabPanel value="frota">
          <Card>
            <CardHeader
              title="Frota"
              description="Veículos, odômetro, consumo médio e custos dos últimos 30 dias."
              actions={
                gere && (
                  <Button onClick={() => setVeiculoDlg({ aberto: true, v: null })} id="veiculo-novo">
                    <Plus className="h-4 w-4" /> Veículo
                  </Button>
                )
              }
            />
            <CardBody className="p-0">
              {frota.loading && !frota.data && <Spinner />}
              {frota.data && (
                <Table>
                  <THead>
                    <TR>
                      <TH>Placa</TH>
                      <TH>Modelo</TH>
                      <TH>Lugares</TH>
                      <TH>Odômetro</TH>
                      <TH>Próx. manutenção</TH>
                      <TH>Consumo</TH>
                      <TH>30 dias</TH>
                      <TH></TH>
                    </TR>
                  </THead>
                  <TBody>
                    {veiculos.map((x) => (
                      <TR key={x.id} className={x.active ? undefined : 'opacity-50'}>
                        <TD className="font-mono text-xs">{x.plate}</TD>
                        <TD>
                          {x.model}
                          <span className="block text-xs text-slate-500">
                            {x.kindLabel}
                            {x.wheelchair ? ' · acessível' : ''}
                            {x.active ? '' : ' · inativo'}
                          </span>
                        </TD>
                        <TD>{x.seats}</TD>
                        <TD>{x.odometerKm.toLocaleString('pt-BR')} km</TD>
                        <TD className="text-xs">
                          {x.nextMaintenanceKm ? `${x.nextMaintenanceKm.toLocaleString('pt-BR')} km` : ''}
                          {x.nextMaintenanceAt ? <span className="block">{fmtDate(x.nextMaintenanceAt)}</span> : null}
                          {!x.nextMaintenanceKm && !x.nextMaintenanceAt && '—'}
                        </TD>
                        <TD className="text-xs">{x.consumoMedioKmL ? `${x.consumoMedioKmL} km/l` : '—'}</TD>
                        <TD className="text-xs">
                          {x.viagensMes} viagem(ns) · {x.kmMes} km
                          <span className="block text-slate-500">{fmtMoney(x.custoMes)}</span>
                        </TD>
                        <TD className="whitespace-nowrap">
                          <Button size="sm" variant="ghost" onClick={() => setRegistrosDe(x)} aria-label={`Registros de ${x.plate}`}>
                            <Wrench className="h-4 w-4" /> Registros
                          </Button>
                          {gere && (
                            <Button size="sm" variant="ghost" onClick={() => setVeiculoDlg({ aberto: true, v: x })}>
                              Editar
                            </Button>
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>
        </TabPanel>
        <TabPanel value="motoristas">
          <Card>
            <CardHeader
              title="Motoristas"
              actions={
                gere && (
                  <Button onClick={() => setMotoristaDlg({ aberto: true, m: null })} id="motorista-novo">
                    <Plus className="h-4 w-4" /> Motorista
                  </Button>
                )
              }
            />
            <CardBody className="p-0">
              {motoristas.loading && !motoristas.data && <Spinner />}
              {motoristas.data && (
                <Table>
                  <THead>
                    <TR>
                      <TH>Nome</TH>
                      <TH>Telefone</TH>
                      <TH>CNH</TH>
                      <TH>Validade</TH>
                      <TH></TH>
                    </TR>
                  </THead>
                  <TBody>
                    {motoristas.data.map((m) => (
                      <TR key={m.id} className={m.active ? undefined : 'opacity-50'}>
                        <TD>{m.name}</TD>
                        <TD className="text-xs">{m.phone ?? '—'}</TD>
                        <TD className="text-xs">
                          {m.cnh} · cat. {m.cnhCategory}
                        </TD>
                        <TD>
                          {fmtDate(m.cnhExpiry)} {m.cnhVencida ? <Badge tone="red">vencida</Badge> : m.cnhVenceEm30 ? <Badge tone="amber">vence em breve</Badge> : null}
                        </TD>
                        <TD>
                          {gere && (
                            <Button size="sm" variant="ghost" onClick={() => setMotoristaDlg({ aberto: true, m })}>
                              Editar
                            </Button>
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>
        </TabPanel>
        <TabPanel value="rotas">
          <Card>
            <CardHeader
              title="Rotas"
              description="Viagens recorrentes; a viagem do dia é criada a partir da rota."
              actions={
                gere && (
                  <Button onClick={() => setRotaDlg({ aberto: true, r: null })} id="rota-nova">
                    <Plus className="h-4 w-4" /> Rota
                  </Button>
                )
              }
            />
            <CardBody className="p-0">
              {rotas.loading && !rotas.data && <Spinner />}
              {rotas.data && (
                <Table>
                  <THead>
                    <TR>
                      <TH>Rota</TH>
                      <TH>Destino</TH>
                      <TH>Dias</TH>
                      <TH>Horários</TH>
                      <TH>Pontos</TH>
                      <TH></TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rotas.data.map((r) => (
                      <TR key={r.id} className={r.active ? undefined : 'opacity-50'}>
                        <TD>{r.name}</TD>
                        <TD>
                          {r.destinationCity}/{r.destinationUf}
                        </TD>
                        <TD className="text-xs">{r.weekdays.map((d) => DIAS[d]).join(', ')}</TD>
                        <TD className="text-xs">
                          saída {r.departureTime}
                          {r.returnTime ? ` · retorno ${r.returnTime}` : ''}
                        </TD>
                        <TD className="text-xs">{r.stops.map((s) => `${s.nome}${s.horario ? ` ${s.horario}` : ''}`).join(' → ') || '—'}</TD>
                        <TD>
                          {gere && (
                            <Button size="sm" variant="ghost" onClick={() => setRotaDlg({ aberto: true, r })}>
                              Editar
                            </Button>
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>
        </TabPanel>
        <TabPanel value="indicadores">
          {ind.loading && !ind.data && <Spinner />}
          {ind.data && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-slate-600">
                Viagens concluídas de {fmtDate(ind.data.from)} a {fmtDate(ind.data.to)}.
              </p>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <Stat label="Viagens concluídas" value={ind.data.totais.viagens} />
                <Stat label="Passageiros transportados" value={ind.data.totais.passageiros} />
                <Stat
                  label="Faltas"
                  value={ind.data.totais.faltas}
                  tone={ind.data.totais.passageiros > 0 && ind.data.totais.faltas / (ind.data.totais.passageiros + ind.data.totais.faltas) > 0.15 ? 'warn' : 'default'}
                  hint={ind.data.totais.passageiros + ind.data.totais.faltas > 0 ? `${Math.round((100 * ind.data.totais.faltas) / (ind.data.totais.passageiros + ind.data.totais.faltas))}% dos agendados` : undefined}
                />
                <Stat label="Quilometragem" value={`${ind.data.totais.km.toLocaleString('pt-BR')} km`} />
                <Stat
                  label="Custo (combustível + manutenção)"
                  value={fmtMoney(ind.data.totais.custo)}
                  hint={ind.data.totais.passageiros > 0 ? `${fmtMoney(ind.data.totais.custo / ind.data.totais.passageiros)} por passageiro` : undefined}
                />
              </div>
              <Card>
                <CardHeader title="Por veículo" />
                <CardBody className="p-0">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Veículo</TH>
                        <TH>Viagens</TH>
                        <TH>km</TH>
                        <TH>Passageiros</TH>
                        <TH>Faltas</TH>
                        <TH>Combustível</TH>
                        <TH>Manutenção</TH>
                        <TH>Custo/km</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {ind.data.porVeiculo.map((d) => (
                        <TR key={d.vehicleId}>
                          <TD>
                            {d.plate} · {d.model}
                          </TD>
                          <TD>{d.viagens}</TD>
                          <TD>{d.km}</TD>
                          <TD>{d.passageiros}</TD>
                          <TD>{d.faltas}</TD>
                          <TD>{fmtMoney(d.combustivel)}</TD>
                          <TD>{fmtMoney(d.manutencao)}</TD>
                          <TD>{d.custoPorKm != null ? fmtMoney(d.custoPorKm) : '—'}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </CardBody>
              </Card>
            </div>
          )}
        </TabPanel>
      </Tabs>

      {viagemAberta && (
        <ViagemDetalhe
          v={v}
          erro={detalhe.error}
          gere={gere}
          podeIncluir={gere || session.can('tfd.gerir')}
          busy={busy}
          onClose={() => {
            setViagemAberta(null);
            setConcluindo(null);
          }}
          onIncluir={() => setPassageiroEm(viagemAberta)}
          onStatus={(pid, status) => acao(() => api.post(`/transporte/passageiros/${pid}/status`, { status }), 'Situação do passageiro atualizada')}
          kmInicio={kmInicio}
          setKmInicio={setKmInicio}
          onIniciar={() => acao(() => api.post(`/transporte/viagens/${viagemAberta}/iniciar`, { odometerStart: kmInicio ? Number(kmInicio) : null }), 'Viagem iniciada')}
          concluindo={concluindo}
          setConcluindo={setConcluindo}
          onConcluir={() =>
            acao(async () => {
              await api.post(`/transporte/viagens/${viagemAberta}/concluir`, {
                odometerEnd: concluindo?.odometerEnd ? Number(concluindo.odometerEnd) : null,
                fuelLiters: concluindo?.fuelLiters ? Number(concluindo.fuelLiters.replace(',', '.')) : null,
                fuelCost: concluindo?.fuelCost ? Number(concluindo.fuelCost.replace(',', '.')) : null,
                notes: concluindo?.notes || null,
              });
              setConcluindo(null);
            }, 'Viagem concluída')
          }
          onCancelar={() => acao(() => api.post(`/transporte/viagens/${viagemAberta}/cancelar`, { reason: 'Cancelada pela central' }), 'Viagem cancelada')}
        />
      )}
      <ViagemDialog
        aberto={novaViagem}
        onClose={() => setNovaViagem(false)}
        rotas={rotas.data ?? []}
        veiculos={veiculos}
        motoristas={motoristas.data ?? []}
        onSalvo={(id) => {
          recarregar();
          setViagemAberta(id);
        }}
      />
      {passageiroEm && <PassageiroDialog viagemId={passageiroEm} onClose={() => setPassageiroEm(null)} onSalvo={recarregar} />}
      <VeiculoDialog aberto={veiculoDlg.aberto} existente={veiculoDlg.v} onClose={() => setVeiculoDlg({ aberto: false, v: null })} onSalvo={() => void frota.reload()} />
      {registrosDe && <RegistrosDialog veiculo={registrosDe} podeGerir={gere} onClose={() => setRegistrosDe(null)} onChanged={() => void frota.reload()} />}
      <MotoristaDialog aberto={motoristaDlg.aberto} existente={motoristaDlg.m} onClose={() => setMotoristaDlg({ aberto: false, m: null })} onSalvo={() => void motoristas.reload()} />
      <RotaDialog aberto={rotaDlg.aberto} existente={rotaDlg.r} veiculos={veiculos} onClose={() => setRotaDlg({ aberto: false, r: null })} onSalvo={() => void rotas.reload()} />
    </>
  );
}

function ViagemDetalhe(props: {
  v: Viagem | null;
  erro: string | null;
  gere: boolean;
  podeIncluir: boolean;
  busy: boolean;
  onClose: () => void;
  onIncluir: () => void;
  onStatus: (passageiroId: string, status: string) => void;
  kmInicio: string;
  setKmInicio: (v: string) => void;
  onIniciar: () => void;
  concluindo: { odometerEnd: string; fuelLiters: string; fuelCost: string; notes: string } | null;
  setConcluindo: (v: { odometerEnd: string; fuelLiters: string; fuelCost: string; notes: string } | null) => void;
  onConcluir: () => void;
  onCancelar: () => void;
}) {
  const { v, gere } = props;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && props.onClose()}
      title={v ? `${fmtDate(v.date)} ${v.departureTime} · ${v.destinationCity}/${v.destinationUf}` : 'Viagem'}
      description={v ? `${v.vehicle.plate} · ${v.vehicle.model} · ${v.driver.name}${v.route ? ` · rota ${v.route.name}` : ''}` : undefined}
      size="xl"
    >
      {props.erro && <Alert tone="error">{props.erro}</Alert>}
      {!v && !props.erro && <Spinner />}
      {v && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_VIAGEM_TONE[v.status]}>{v.statusLabel}</Badge>
            <Badge tone={v.ocupacao.lotada ? 'red' : 'slate'}>
              {v.ocupacao.usados}/{v.ocupacao.assentos} lugares
            </Badge>
            {v.ocupacao.cadeirantes > 0 && <Badge tone="violet">{v.ocupacao.cadeirantes} cadeirante(s)</Badge>}
            {v.km != null && <Badge tone="blue">{v.km} km</Badge>}
            {v.fuelCost != null && <Badge tone="blue">combustível {fmtMoney(v.fuelCost)}</Badge>}
            {v.destinationPlace && <span className="text-sm text-slate-600">{v.destinationPlace}</span>}
            {props.podeIncluir && v.status === 'PLANEJADA' && (
              <Button size="sm" className="ml-auto" onClick={props.onIncluir} id="passageiro-incluir">
                <Plus className="h-4 w-4" /> Passageiro
              </Button>
            )}
          </div>
          {v.passageiros.length === 0 ? (
            <p className="text-sm text-slate-500">Sem passageiros.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Passageiro</TH>
                  <TH>Embarque</TH>
                  <TH>Atendimento</TH>
                  <TH>Situação</TH>
                  {gere && <TH></TH>}
                </TR>
              </THead>
              <TBody>
                {v.passageiros.map((p) => (
                  <TR key={p.id}>
                    <TD>
                      {p.paciente.name}
                      <span className="block text-xs text-slate-500">
                        {p.paciente.age} anos · {p.paciente.phone ?? 'sem telefone'}
                        {p.companionName ? ` · acomp. ${p.companionName}` : ''}
                        {p.wheelchair ? ' · cadeirante' : ''}
                        {p.tfdId ? ' · TFD' : ''}
                      </span>
                    </TD>
                    <TD className="text-xs">{p.pickupAddress ?? '—'}</TD>
                    <TD className="text-xs">
                      {p.appointmentAt ? `${fmtDate(p.appointmentAt)} ${fmtTime(p.appointmentAt)}` : '—'}
                      {p.appointmentPlace && <span className="block text-slate-500">{p.appointmentPlace}</span>}
                    </TD>
                    <TD>
                      <Badge tone={STATUS_PASSAGEIRO_TONE[p.status]}>{p.statusLabel}</Badge>
                    </TD>
                    {gere && (
                      <TD className="whitespace-nowrap">
                        {v.status !== 'CONCLUIDA' && v.status !== 'CANCELADA' && p.status === 'AGENDADO' && (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => props.onStatus(p.id, 'EMBARCOU')} disabled={props.busy}>
                              Embarcou
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => props.onStatus(p.id, 'FALTOU')} disabled={props.busy}>
                              Faltou
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => props.onStatus(p.id, 'CANCELADO')} disabled={props.busy}>
                              Cancelar
                            </Button>
                          </>
                        )}
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {v.notes && <p className="text-sm text-slate-600">{v.notes}</p>}
          {gere && v.status === 'PLANEJADA' && (
            <div className="flex flex-wrap items-end justify-end gap-2">
              <Field label="Odômetro na saída (km)" htmlFor="vg-km-inicio">
                <Input id="vg-km-inicio" inputMode="numeric" value={props.kmInicio} onChange={(e) => props.setKmInicio(e.target.value)} placeholder={String(v.odometerStart ?? '')} className="w-40" />
              </Field>
              <Button onClick={props.onIniciar} loading={props.busy} id="viagem-iniciar">
                Iniciar viagem
              </Button>
              <Button variant="ghost" onClick={props.onCancelar} disabled={props.busy}>
                Cancelar viagem
              </Button>
            </div>
          )}
          {gere && v.status === 'EM_ANDAMENTO' && (
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="mb-2 text-sm font-semibold">Encerrar viagem</p>
              <div className="grid gap-2 sm:grid-cols-4">
                <Field label="Odômetro na chegada (km)" htmlFor="vg-km-fim">
                  <Input
                    id="vg-km-fim"
                    inputMode="numeric"
                    value={props.concluindo?.odometerEnd ?? ''}
                    onChange={(e) => props.setConcluindo({ odometerEnd: e.target.value, fuelLiters: props.concluindo?.fuelLiters ?? '', fuelCost: props.concluindo?.fuelCost ?? '', notes: props.concluindo?.notes ?? '' })}
                  />
                </Field>
                <Field label="Abastecimento (litros)" htmlFor="vg-litros">
                  <Input
                    id="vg-litros"
                    inputMode="decimal"
                    value={props.concluindo?.fuelLiters ?? ''}
                    onChange={(e) =>
                      props.setConcluindo({ odometerEnd: props.concluindo?.odometerEnd ?? '', fuelLiters: e.target.value, fuelCost: props.concluindo?.fuelCost ?? '', notes: props.concluindo?.notes ?? '' })
                    }
                  />
                </Field>
                <Field label="Abastecimento (R$)" htmlFor="vg-custo">
                  <Input
                    id="vg-custo"
                    inputMode="decimal"
                    value={props.concluindo?.fuelCost ?? ''}
                    onChange={(e) =>
                      props.setConcluindo({ odometerEnd: props.concluindo?.odometerEnd ?? '', fuelLiters: props.concluindo?.fuelLiters ?? '', fuelCost: e.target.value, notes: props.concluindo?.notes ?? '' })
                    }
                  />
                </Field>
                <Field label="Observações" htmlFor="vg-notas">
                  <Input
                    id="vg-notas"
                    value={props.concluindo?.notes ?? ''}
                    onChange={(e) =>
                      props.setConcluindo({ odometerEnd: props.concluindo?.odometerEnd ?? '', fuelLiters: props.concluindo?.fuelLiters ?? '', fuelCost: props.concluindo?.fuelCost ?? '', notes: e.target.value })
                    }
                  />
                </Field>
              </div>
              <div className="mt-2 flex justify-end">
                <Button variant="success" onClick={props.onConcluir} loading={props.busy} id="viagem-concluir">
                  Concluir viagem
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
