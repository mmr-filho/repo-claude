'use client';

import { DIAS_SEMANA, TIPO_REGISTRO_VEICULO, TIPO_VEICULO, UFS, type TipoRegistroVeiculo, type TipoVeiculo } from '@omnisaude/shared';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PatientSearch } from '@/components/patients/patient-search';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime, fmtMoney, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import type { PatientSummary } from '@/lib/types';
import type { Motorista, Rota, Veiculo } from './types';

function Rodape({ onClose, onSave, busy, id }: { onClose: () => void; onSave: () => void; busy: boolean; id?: string }) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={onClose} disabled={busy}>
        Cancelar
      </Button>
      <Button onClick={onSave} loading={busy} id={id}>
        Salvar
      </Button>
    </div>
  );
}

export function VeiculoDialog({ aberto, onClose, existente, onSalvo }: { aberto: boolean; onClose: () => void; existente: Veiculo | null; onSalvo: () => void }) {
  const [f, setF] = useState({ plate: '', model: '', kind: 'VAN' as TipoVeiculo, seats: '', wheelchair: false, odometerKm: '0', nextMaintenanceKm: '', nextMaintenanceAt: '', notes: '', active: true });
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!aberto) return;
    setErro(null);
    setF(
      existente
        ? {
            plate: existente.plate,
            model: existente.model,
            kind: existente.kind,
            seats: String(existente.seats),
            wheelchair: existente.wheelchair,
            odometerKm: String(existente.odometerKm),
            nextMaintenanceKm: existente.nextMaintenanceKm?.toString() ?? '',
            nextMaintenanceAt: existente.nextMaintenanceAt ?? '',
            notes: existente.notes ?? '',
            active: existente.active,
          }
        : { plate: '', model: '', kind: 'VAN', seats: '', wheelchair: false, odometerKm: '0', nextMaintenanceKm: '', nextMaintenanceAt: '', notes: '', active: true },
    );
  }, [aberto, existente]);
  async function salvar() {
    setErro(null);
    setBusy(true);
    try {
      const body = {
        plate: f.plate,
        model: f.model,
        kind: f.kind,
        seats: f.seats ? Number(f.seats) : null,
        wheelchair: f.wheelchair,
        odometerKm: Number(f.odometerKm) || 0,
        nextMaintenanceKm: f.nextMaintenanceKm ? Number(f.nextMaintenanceKm) : null,
        nextMaintenanceAt: f.nextMaintenanceAt || null,
        notes: f.notes || null,
        active: f.active,
      };
      if (existente) await api.patch(`/transporte/veiculos/${existente.id}`, body);
      else await api.post('/transporte/veiculos', body);
      onSalvo();
      onClose();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={aberto}
      onOpenChange={(o) => !o && onClose()}
      title={existente ? `Veículo ${existente.plate}` : 'Novo veículo'}
      size="lg"
      footer={<Rodape onClose={onClose} onSave={salvar} busy={busy} id="veiculo-salvar" />}
    >
      <div className="flex flex-col gap-3">
        {erro && <Alert tone="error">{erro}</Alert>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Placa" htmlFor="v-placa">
            <Input id="v-placa" value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Modelo" htmlFor="v-modelo" className="sm:col-span-2">
            <Input id="v-modelo" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} />
          </Field>
          <Field label="Tipo" htmlFor="v-tipo">
            <Select id="v-tipo" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as TipoVeiculo })}>
              {(Object.keys(TIPO_VEICULO) as TipoVeiculo[]).map((k) => (
                <option key={k} value={k}>
                  {TIPO_VEICULO[k].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Lugares" htmlFor="v-lugares" hint={`Padrão do tipo: ${TIPO_VEICULO[f.kind].assentos}`}>
            <Input id="v-lugares" inputMode="numeric" value={f.seats} onChange={(e) => setF({ ...f, seats: e.target.value })} />
          </Field>
          <Field label="Odômetro (km)" htmlFor="v-km">
            <Input id="v-km" inputMode="numeric" value={f.odometerKm} onChange={(e) => setF({ ...f, odometerKm: e.target.value })} />
          </Field>
          <Field label="Próxima manutenção (km)" htmlFor="v-manut-km">
            <Input id="v-manut-km" inputMode="numeric" value={f.nextMaintenanceKm} onChange={(e) => setF({ ...f, nextMaintenanceKm: e.target.value })} />
          </Field>
          <Field label="Próxima manutenção (data)" htmlFor="v-manut-data">
            <Input id="v-manut-data" type="date" value={f.nextMaintenanceAt} onChange={(e) => setF({ ...f, nextMaintenanceAt: e.target.value })} />
          </Field>
          <div className="flex flex-col justify-end gap-1 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={f.wheelchair} onChange={(e) => setF({ ...f, wheelchair: e.target.checked })} /> Transporta cadeirante
            </label>
            {existente && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Ativo
              </label>
            )}
          </div>
        </div>
        <Field label="Observações" htmlFor="v-obs">
          <Textarea id="v-obs" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

export function RegistrosDialog({ veiculo, podeGerir, onClose, onChanged }: { veiculo: Veiculo; podeGerir: boolean; onClose: () => void; onChanged: () => void }) {
  const lista = useApi<{ id: string; kind: TipoRegistroVeiculo; at: string; odometerKm: number; cost: number; liters: number | null; description: string; usuario: string | null }[]>(
    `/transporte/veiculos/${veiculo.id}/registros`,
  );
  const [f, setF] = useState({ kind: 'ABASTECIMENTO' as TipoRegistroVeiculo, odometerKm: String(veiculo.odometerKm), cost: '', liters: '', description: '', nextMaintenanceKm: '' });
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function salvar() {
    setErro(null);
    setBusy(true);
    try {
      await api.post(`/transporte/veiculos/${veiculo.id}/registros`, {
        kind: f.kind,
        odometerKm: Number(f.odometerKm),
        cost: Number(f.cost.replace(',', '.')) || 0,
        liters: f.liters ? Number(f.liters.replace(',', '.')) : null,
        description: f.description,
        nextMaintenanceKm: f.kind === 'MANUTENCAO' && f.nextMaintenanceKm ? Number(f.nextMaintenanceKm) : undefined,
      });
      setF({ ...f, cost: '', liters: '', description: '' });
      await lista.reload();
      onChanged();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Manutenção e abastecimento · ${veiculo.plate}`}
      description={`${veiculo.model} · ${veiculo.odometerKm} km${veiculo.consumoMedioKmL ? ` · ${veiculo.consumoMedioKmL} km/l` : ''}`}
      size="lg"
    >
      <div className="flex flex-col gap-3">
        {erro && <Alert tone="error">{erro}</Alert>}
        {podeGerir && (
          <div className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-6">
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as TipoRegistroVeiculo })} aria-label="Tipo" id="reg-tipo">
              {(Object.keys(TIPO_REGISTRO_VEICULO) as TipoRegistroVeiculo[]).map((k) => (
                <option key={k} value={k}>
                  {TIPO_REGISTRO_VEICULO[k]}
                </option>
              ))}
            </Select>
            <Input inputMode="numeric" value={f.odometerKm} onChange={(e) => setF({ ...f, odometerKm: e.target.value })} aria-label="Odômetro" placeholder="km" id="reg-km" />
            <Input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} aria-label="Custo" placeholder="R$" id="reg-custo" />
            <Input inputMode="decimal" value={f.liters} onChange={(e) => setF({ ...f, liters: e.target.value })} aria-label="Litros" placeholder="litros" disabled={f.kind !== 'ABASTECIMENTO'} id="reg-litros" />
            {f.kind === 'MANUTENCAO' ? (
              <Input inputMode="numeric" value={f.nextMaintenanceKm} onChange={(e) => setF({ ...f, nextMaintenanceKm: e.target.value })} aria-label="Próxima manutenção (km)" placeholder="próx. km" />
            ) : (
              <span />
            )}
            <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} aria-label="Descrição" placeholder="descrição" className="sm:col-span-5" id="reg-desc" />
            <Button onClick={salvar} loading={busy} id="reg-salvar">
              <Plus className="h-4 w-4" /> Registrar
            </Button>
          </div>
        )}
        {lista.data && (
          <Table>
            <THead>
              <TR>
                <TH>Quando</TH>
                <TH>Tipo</TH>
                <TH>Odômetro</TH>
                <TH>Custo</TH>
                <TH>Litros</TH>
                <TH>Descrição</TH>
              </TR>
            </THead>
            <TBody>
              {lista.data.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap text-xs">{fmtDateTime(r.at)}</TD>
                  <TD>{TIPO_REGISTRO_VEICULO[r.kind]}</TD>
                  <TD>{r.odometerKm} km</TD>
                  <TD>{fmtMoney(r.cost)}</TD>
                  <TD>{r.liters ?? '—'}</TD>
                  <TD className="text-xs">
                    {r.description}
                    <span className="block text-slate-500">{r.usuario}</span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </Dialog>
  );
}

export function MotoristaDialog({ aberto, onClose, existente, onSalvo }: { aberto: boolean; onClose: () => void; existente: Motorista | null; onSalvo: () => void }) {
  const [f, setF] = useState({ name: '', cpf: '', phone: '', cnh: '', cnhCategory: 'D', cnhExpiry: '', active: true });
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!aberto) return;
    setErro(null);
    setF(
      existente
        ? { name: existente.name, cpf: existente.cpf ?? '', phone: existente.phone ?? '', cnh: existente.cnh, cnhCategory: existente.cnhCategory.trim(), cnhExpiry: existente.cnhExpiry, active: existente.active }
        : { name: '', cpf: '', phone: '', cnh: '', cnhCategory: 'D', cnhExpiry: '', active: true },
    );
  }, [aberto, existente]);
  async function salvar() {
    setErro(null);
    setBusy(true);
    try {
      const body = { name: f.name, cpf: f.cpf || null, phone: f.phone || null, cnh: f.cnh, cnhCategory: f.cnhCategory, cnhExpiry: f.cnhExpiry, active: f.active };
      if (existente) await api.patch(`/transporte/motoristas/${existente.id}`, body);
      else await api.post('/transporte/motoristas', body);
      onSalvo();
      onClose();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && onClose()} title={existente ? 'Motorista' : 'Novo motorista'} size="md" footer={<Rodape onClose={onClose} onSave={salvar} busy={busy} id="motorista-salvar" />}>
      <div className="flex flex-col gap-3">
        {erro && <Alert tone="error">{erro}</Alert>}
        <Field label="Nome" htmlFor="m-nome">
          <Input id="m-nome" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="CPF" htmlFor="m-cpf">
            <Input id="m-cpf" value={f.cpf} onChange={(e) => setF({ ...f, cpf: e.target.value })} />
          </Field>
          <Field label="Telefone" htmlFor="m-tel">
            <Input id="m-tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </Field>
          <Field label="CNH" htmlFor="m-cnh">
            <Input id="m-cnh" value={f.cnh} onChange={(e) => setF({ ...f, cnh: e.target.value })} />
          </Field>
          <Field label="Categoria" htmlFor="m-cat">
            <Select id="m-cat" value={f.cnhCategory} onChange={(e) => setF({ ...f, cnhCategory: e.target.value })}>
              {['B', 'C', 'D', 'E'].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Validade da CNH" htmlFor="m-val">
            <Input id="m-val" type="date" value={f.cnhExpiry} onChange={(e) => setF({ ...f, cnhExpiry: e.target.value })} />
          </Field>
          {existente && (
            <label className="flex items-center gap-2 self-end text-sm">
              <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Ativo
            </label>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export function RotaDialog({ aberto, onClose, existente, veiculos, onSalvo }: { aberto: boolean; onClose: () => void; existente: Rota | null; veiculos: Veiculo[]; onSalvo: () => void }) {
  const [f, setF] = useState({
    name: '',
    destinationCity: '',
    destinationUf: 'TO',
    departureTime: '05:00',
    returnTime: '',
    vehicleId: '',
    weekdays: [1, 3, 5] as number[],
    stops: [{ nome: '', endereco: '', horario: '' }],
    active: true,
  });
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!aberto) return;
    setErro(null);
    setF(
      existente
        ? {
            name: existente.name,
            destinationCity: existente.destinationCity,
            destinationUf: existente.destinationUf,
            departureTime: existente.departureTime,
            returnTime: existente.returnTime ?? '',
            vehicleId: existente.vehicleId ?? '',
            weekdays: existente.weekdays,
            stops: existente.stops.length ? existente.stops.map((s) => ({ nome: s.nome, endereco: s.endereco ?? '', horario: s.horario ?? '' })) : [{ nome: '', endereco: '', horario: '' }],
            active: existente.active,
          }
        : { name: '', destinationCity: '', destinationUf: 'TO', departureTime: '05:00', returnTime: '', vehicleId: '', weekdays: [1, 3, 5], stops: [{ nome: '', endereco: '', horario: '' }], active: true },
    );
  }, [aberto, existente]);
  async function salvar() {
    setErro(null);
    setBusy(true);
    try {
      const body = {
        name: f.name,
        destinationCity: f.destinationCity,
        destinationUf: f.destinationUf,
        departureTime: f.departureTime,
        returnTime: f.returnTime || null,
        vehicleId: f.vehicleId || null,
        weekdays: f.weekdays,
        stops: f.stops.filter((s) => s.nome.trim()).map((s) => ({ nome: s.nome, endereco: s.endereco || null, horario: s.horario || null })),
        active: f.active,
      };
      if (existente) await api.patch(`/transporte/rotas/${existente.id}`, body);
      else await api.post('/transporte/rotas', body);
      onSalvo();
      onClose();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={aberto}
      onOpenChange={(o) => !o && onClose()}
      title={existente ? 'Rota' : 'Nova rota'}
      description="Viagem recorrente com dias da semana, horário e pontos de embarque"
      size="lg"
      footer={<Rodape onClose={onClose} onSave={salvar} busy={busy} id="rota-salvar" />}
    >
      <div className="flex flex-col gap-3">
        {erro && <Alert tone="error">{erro}</Alert>}
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Nome" htmlFor="r-nome" className="sm:col-span-2">
            <Input id="r-nome" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Destino" htmlFor="r-cidade">
            <Input id="r-cidade" value={f.destinationCity} onChange={(e) => setF({ ...f, destinationCity: e.target.value })} />
          </Field>
          <Field label="UF" htmlFor="r-uf">
            <Select id="r-uf" value={f.destinationUf} onChange={(e) => setF({ ...f, destinationUf: e.target.value })}>
              {UFS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Saída" htmlFor="r-saida">
            <Input id="r-saida" type="time" value={f.departureTime} onChange={(e) => setF({ ...f, departureTime: e.target.value })} />
          </Field>
          <Field label="Retorno" htmlFor="r-retorno">
            <Input id="r-retorno" type="time" value={f.returnTime} onChange={(e) => setF({ ...f, returnTime: e.target.value })} />
          </Field>
          <Field label="Veículo padrão" htmlFor="r-veiculo" className="sm:col-span-2">
            <Select id="r-veiculo" value={f.vehicleId} onChange={(e) => setF({ ...f, vehicleId: e.target.value })}>
              <option value="">Definir na viagem</option>
              {veiculos.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.plate} · {v.model}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          {DIAS_SEMANA.map((d, i) => (
            <label key={d} className="flex items-center gap-1">
              <input type="checkbox" checked={f.weekdays.includes(i)} onChange={(e) => setF({ ...f, weekdays: e.target.checked ? [...f.weekdays, i] : f.weekdays.filter((x) => x !== i) })} /> {d}
            </label>
          ))}
          {existente && (
            <label className="ml-auto flex items-center gap-2">
              <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Ativa
            </label>
          )}
        </div>
        <div>
          <p className="mb-1 text-sm font-medium">Pontos de embarque</p>
          {f.stops.map((s, i) => (
            <div key={i} className="mb-1 grid gap-2 sm:grid-cols-[1fr_2fr_6rem_auto]">
              <Input value={s.nome} onChange={(e) => setF({ ...f, stops: f.stops.map((x, j) => (j === i ? { ...x, nome: e.target.value } : x)) })} placeholder="Ponto" aria-label="Ponto" />
              <Input value={s.endereco} onChange={(e) => setF({ ...f, stops: f.stops.map((x, j) => (j === i ? { ...x, endereco: e.target.value } : x)) })} placeholder="Endereço" aria-label="Endereço" />
              <Input type="time" value={s.horario} onChange={(e) => setF({ ...f, stops: f.stops.map((x, j) => (j === i ? { ...x, horario: e.target.value } : x)) })} aria-label="Horário" />
              <Button size="sm" variant="ghost" onClick={() => setF({ ...f, stops: f.stops.filter((_, j) => j !== i) })} aria-label="Remover ponto">
                ×
              </Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setF({ ...f, stops: [...f.stops, { nome: '', endereco: '', horario: '' }] })}>
            <Plus className="h-4 w-4" /> Ponto
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function ViagemDialog({
  aberto,
  onClose,
  rotas,
  veiculos,
  motoristas,
  onSalvo,
}: {
  aberto: boolean;
  onClose: () => void;
  rotas: Rota[];
  veiculos: Veiculo[];
  motoristas: Motorista[];
  onSalvo: (id: string) => void;
}) {
  const [f, setF] = useState({ routeId: '', vehicleId: '', driverId: '', date: todayIso(1), departureTime: '', destinationCity: '', destinationUf: 'TO', destinationPlace: '', notes: '' });
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (aberto) {
      setErro(null);
      setF({ routeId: '', vehicleId: '', driverId: '', date: todayIso(1), departureTime: '', destinationCity: '', destinationUf: 'TO', destinationPlace: '', notes: '' });
    }
  }, [aberto]);
  function escolherRota(id: string) {
    const r = rotas.find((x) => x.id === id);
    setF((x) => ({ ...x, routeId: id, ...(r ? { vehicleId: r.vehicleId ?? x.vehicleId, departureTime: r.departureTime, destinationCity: r.destinationCity, destinationUf: r.destinationUf } : {}) }));
  }
  async function salvar() {
    setErro(null);
    setBusy(true);
    try {
      const v = await api.post<{ id: string }>('/transporte/viagens', {
        routeId: f.routeId || null,
        vehicleId: f.vehicleId || null,
        driverId: f.driverId,
        date: f.date,
        departureTime: f.departureTime || null,
        destinationCity: f.destinationCity || null,
        destinationUf: f.destinationUf || null,
        destinationPlace: f.destinationPlace || null,
        notes: f.notes || null,
      });
      onSalvo(v.id);
      onClose();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={aberto}
      onOpenChange={(o) => !o && onClose()}
      title="Nova viagem"
      description="A partir de uma rota ou avulsa"
      size="lg"
      footer={<Rodape onClose={onClose} onSave={salvar} busy={busy} id="viagem-salvar" />}
    >
      <div className="flex flex-col gap-3">
        {erro && <Alert tone="error">{erro}</Alert>}
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Rota" htmlFor="vg-rota" className="sm:col-span-2">
            <Select id="vg-rota" value={f.routeId} onChange={(e) => escolherRota(e.target.value)}>
              <option value="">Viagem avulsa</option>
              {rotas
                .filter((r) => r.active)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Data" htmlFor="vg-data">
            <Input id="vg-data" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label="Saída" htmlFor="vg-saida">
            <Input id="vg-saida" type="time" value={f.departureTime} onChange={(e) => setF({ ...f, departureTime: e.target.value })} />
          </Field>
          <Field label="Veículo" htmlFor="vg-veiculo" className="sm:col-span-2">
            <Select id="vg-veiculo" value={f.vehicleId} onChange={(e) => setF({ ...f, vehicleId: e.target.value })}>
              <option value="">Escolha…</option>
              {veiculos
                .filter((v) => v.active)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.plate} · {v.model} · {v.seats} lugares
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Motorista" htmlFor="vg-motorista" className="sm:col-span-2">
            <Select id="vg-motorista" value={f.driverId} onChange={(e) => setF({ ...f, driverId: e.target.value })}>
              <option value="">Escolha…</option>
              {motoristas
                .filter((m) => m.active)
                .map((m) => (
                  <option key={m.id} value={m.id} disabled={m.cnhVencida}>
                    {m.name}
                    {m.cnhVencida ? ' (CNH vencida)' : ''}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Destino" htmlFor="vg-cidade" className="sm:col-span-2">
            <Input id="vg-cidade" value={f.destinationCity} onChange={(e) => setF({ ...f, destinationCity: e.target.value })} />
          </Field>
          <Field label="UF" htmlFor="vg-uf">
            <Select id="vg-uf" value={f.destinationUf} onChange={(e) => setF({ ...f, destinationUf: e.target.value })}>
              {UFS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Local (hospital, clínica)" htmlFor="vg-local">
            <Input id="vg-local" value={f.destinationPlace} onChange={(e) => setF({ ...f, destinationPlace: e.target.value })} />
          </Field>
        </div>
        <Field label="Observações" htmlFor="vg-obs">
          <Textarea id="vg-obs" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

export function PassageiroDialog({ viagemId, onClose, onSalvo }: { viagemId: string; onClose: () => void; onSalvo: () => void }) {
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [f, setF] = useState({ companionName: '', pickupAddress: '', appointmentAt: '', appointmentPlace: '', wheelchair: false, notes: '' });
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function salvar() {
    if (!patient) return setErro('Escolha a pessoa');
    setErro(null);
    setBusy(true);
    try {
      await api.post(`/transporte/viagens/${viagemId}/passageiros`, {
        patientId: patient.id,
        companionName: f.companionName || null,
        pickupAddress: f.pickupAddress || null,
        appointmentAt: f.appointmentAt ? new Date(f.appointmentAt).toISOString() : null,
        appointmentPlace: f.appointmentPlace || null,
        wheelchair: f.wheelchair,
        notes: f.notes || null,
      });
      onSalvo();
      onClose();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Incluir passageiro" size="lg" footer={<Rodape onClose={onClose} onSave={salvar} busy={busy} id="passageiro-salvar" />}>
      <div className="flex flex-col gap-3">
        {erro && <Alert tone="error">{erro}</Alert>}
        {patient ? (
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <span>
              <b>{patient.name}</b> · {patient.age} anos
            </span>
            <Button size="sm" variant="ghost" onClick={() => setPatient(null)}>
              Trocar
            </Button>
          </div>
        ) : (
          <PatientSearch onSelect={setPatient} placeholder="Nome, CPF ou CNS" autoFocus />
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Acompanhante (ocupa lugar)" htmlFor="pa-acomp">
            <Input id="pa-acomp" value={f.companionName} onChange={(e) => setF({ ...f, companionName: e.target.value })} />
          </Field>
          <Field label="Endereço de embarque" htmlFor="pa-end" hint="Padrão: endereço do cadastro">
            <Input id="pa-end" value={f.pickupAddress} onChange={(e) => setF({ ...f, pickupAddress: e.target.value })} />
          </Field>
          <Field label="Atendimento no destino (data e hora)" htmlFor="pa-quando">
            <Input id="pa-quando" type="datetime-local" value={f.appointmentAt} onChange={(e) => setF({ ...f, appointmentAt: e.target.value })} />
          </Field>
          <Field label="Local do atendimento" htmlFor="pa-local">
            <Input id="pa-local" value={f.appointmentPlace} onChange={(e) => setF({ ...f, appointmentPlace: e.target.value })} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.wheelchair} onChange={(e) => setF({ ...f, wheelchair: e.target.checked })} /> Cadeirante
        </label>
        <Field label="Observações" htmlFor="pa-obs">
          <Textarea id="pa-obs" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}
