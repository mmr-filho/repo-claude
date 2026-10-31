'use client';

import { DESFECHO_VISITA, MOTIVOS_VISITA, TIPO_GLICEMIA, TIPO_IMOVEL, turnoDaHora, type OperacaoCampo, type VisitaCampo } from '@omnisaude/shared';
import { LocateFixed } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { obterPosicao, uuid } from '@/lib/offline';

export interface PessoaVisitavel {
  /** Id no servidor ou, para quem ainda não foi sincronizado, o clientId. */
  id: string;
  pendente: boolean;
  nome: string;
  idade: number | null;
}

export interface DomicilioVisitavel {
  id: string;
  pendente: boolean;
  rotulo: string;
  microArea: string | null;
  propertyType: string | null;
  latitude: number | null;
  longitude: number | null;
}

const agoraLocal = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/** Registro de uma visita domiciliar (ou ao imóvel) na porta da casa; vai para a fila e é sincronizada quando houver rede. */
export function VisitForm({
  aberto,
  onClose,
  domicilio,
  pessoas,
  pessoaInicial,
  onSalvar,
}: {
  aberto: boolean;
  onClose: () => void;
  domicilio: DomicilioVisitavel | null;
  pessoas: PessoaVisitavel[];
  pessoaInicial?: string | null;
  onSalvar: (op: OperacaoCampo, rotulo: string) => Promise<void>;
}) {
  const [pessoaId, setPessoaId] = useState<string>(pessoaInicial ?? '');
  const [desfecho, setDesfecho] = useState<'1' | '2' | '3'>('1');
  const [motivos, setMotivos] = useState<string[]>(['29']);
  const [compartilhada, setCompartilhada] = useState(false);
  const [foraDaArea, setForaDaArea] = useState(false);
  const [tipoImovel, setTipoImovel] = useState(domicilio?.propertyType ?? '01');
  const [quando, setQuando] = useState(agoraLocal());
  const [med, setMed] = useState({ pesoKg: '', alturaCm: '', sistolica: '', diastolica: '', temperatura: '', glicemia: '', tipoGlicemia: '4' });
  const [posicao, setPosicao] = useState<{ latitude: number; longitude: number; precisao: number | null } | null>(null);
  const [obs, setObs] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [localizando, setLocalizando] = useState(false);

  useEffect(() => {
    if (aberto) {
      setPessoaId(pessoaInicial ?? '');
      setDesfecho('1');
      setMotivos(['29']);
      setCompartilhada(false);
      setForaDaArea(false);
      setTipoImovel(domicilio?.propertyType ?? '01');
      setQuando(agoraLocal());
      setMed({ pesoKg: '', alturaCm: '', sistolica: '', diastolica: '', temperatura: '', glicemia: '', tipoGlicemia: '4' });
      setPosicao(null);
      setObs('');
      setErro(null);
    }
  }, [aberto, pessoaInicial, domicilio?.propertyType]);

  const toggle = (codigo: string) => setMotivos((m) => (m.includes(codigo) ? m.filter((x) => x !== codigo) : [...m, codigo]));
  const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')));

  async function localizar() {
    setLocalizando(true);
    try {
      setPosicao(await obterPosicao());
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setLocalizando(false);
    }
  }

  async function salvar() {
    setErro(null);
    if (!motivos.length) return setErro('Marque ao menos um motivo da visita');
    if (!pessoaId && tipoImovel === '01' && desfecho === '1') return setErro('Visita realizada a um domicílio precisa informar a pessoa visitada');
    const registradoEm = new Date(quando);
    if (Number.isNaN(registradoEm.getTime())) return setErro('Informe a data e a hora da visita');
    if (registradoEm.getTime() > Date.now() + 60_000) return setErro('A visita não pode estar no futuro');
    const pessoa = pessoas.find((p) => p.id === pessoaId) ?? null;
    const visita: VisitaCampo = {
      motivos,
      desfecho,
      turno: turnoDaHora(registradoEm.getHours()),
      compartilhada,
      foraDaArea,
      tipoImovel,
      microArea: foraDaArea ? null : (domicilio?.microArea ?? null),
      pesoKg: num(med.pesoKg),
      alturaCm: num(med.alturaCm),
      sistolica: num(med.sistolica),
      diastolica: num(med.diastolica),
      temperatura: num(med.temperatura),
      glicemia: num(med.glicemia),
      tipoGlicemia: num(med.glicemia) !== null ? med.tipoGlicemia : null,
      latitude: posicao?.latitude ?? null,
      longitude: posicao?.longitude ?? null,
      observacoes: obs.trim() || null,
    };
    const op: OperacaoCampo = {
      tipo: 'VISITA',
      clientId: uuid(),
      registradoEm: registradoEm.toISOString(),
      ...(domicilio ? (domicilio.pendente ? { householdClientId: domicilio.id } : { householdId: domicilio.id }) : {}),
      ...(pessoa ? (pessoa.pendente ? { patientClientId: pessoa.id } : { patientId: pessoa.id }) : {}),
      visita,
    };
    setBusy(true);
    try {
      await onSalvar(op, `Visita · ${pessoa?.nome ?? domicilio?.rotulo ?? 'imóvel'} · ${DESFECHO_VISITA[desfecho]}`);
      onClose();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={aberto}
      onOpenChange={(o) => !o && onClose()}
      title="Registrar visita"
      description={domicilio ? domicilio.rotulo : 'Visita fora do território cadastrado'}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={salvar} loading={busy} id="visita-salvar">
            Salvar visita
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {erro && <Alert tone="error">{erro}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Pessoa visitada" htmlFor="visita-pessoa">
            <Select id="visita-pessoa" value={pessoaId} onChange={(e) => setPessoaId(e.target.value)}>
              <option value="">Visita ao imóvel (sem pessoa)</option>
              {pessoas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nome}
                  {p.idade !== null ? ` · ${p.idade} anos` : ''}
                  {p.pendente ? ' · aguardando envio' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Data e hora" htmlFor="visita-quando">
            <Input id="visita-quando" type="datetime-local" value={quando} onChange={(e) => setQuando(e.target.value)} />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Desfecho</legend>
          <div className="flex flex-wrap gap-2">
            {(['1', '2', '3'] as const).map((d) => (
              <label key={d} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm ${desfecho === d ? 'border-brand-500 bg-brand-50 font-medium' : 'border-slate-200'}`}>
                <input type="radio" name="desfecho" value={d} checked={desfecho === d} onChange={() => setDesfecho(d)} />
                {DESFECHO_VISITA[d]}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Motivos da visita</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {MOTIVOS_VISITA.map((g) => (
              <div key={g.titulo} className="rounded-lg border border-slate-200 p-2">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{g.titulo}</p>
                <div className="flex flex-col">
                  {g.motivos.map((m) => (
                    <label key={m.codigo} className="flex min-h-9 items-center gap-2 text-sm">
                      <input type="checkbox" checked={motivos.includes(m.codigo)} onChange={() => toggle(m.codigo)} />
                      {m.descricao}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Tipo de imóvel" htmlFor="visita-imovel">
            <Select id="visita-imovel" value={tipoImovel} onChange={(e) => setTipoImovel(e.target.value)}>
              {Object.entries(TIPO_IMOVEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex min-h-11 items-center gap-2 text-sm sm:mt-6">
            <input type="checkbox" checked={compartilhada} onChange={(e) => setCompartilhada(e.target.checked)} />
            Visita compartilhada com outro profissional
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm sm:mt-6">
            <input type="checkbox" checked={foraDaArea} onChange={(e) => setForaDaArea(e.target.checked)} />
            Fora da minha área
          </label>
        </div>
        <details className="rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-medium">Medições (opcional)</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Peso (kg)" htmlFor="visita-peso">
              <Input id="visita-peso" inputMode="decimal" value={med.pesoKg} onChange={(e) => setMed({ ...med, pesoKg: e.target.value })} />
            </Field>
            <Field label="Altura (cm)" htmlFor="visita-altura">
              <Input id="visita-altura" inputMode="numeric" value={med.alturaCm} onChange={(e) => setMed({ ...med, alturaCm: e.target.value })} />
            </Field>
            <Field label="Temperatura (°C)" htmlFor="visita-temp">
              <Input id="visita-temp" inputMode="decimal" value={med.temperatura} onChange={(e) => setMed({ ...med, temperatura: e.target.value })} />
            </Field>
            <Field label="PA sistólica" htmlFor="visita-pas">
              <Input id="visita-pas" inputMode="numeric" value={med.sistolica} onChange={(e) => setMed({ ...med, sistolica: e.target.value })} />
            </Field>
            <Field label="PA diastólica" htmlFor="visita-pad">
              <Input id="visita-pad" inputMode="numeric" value={med.diastolica} onChange={(e) => setMed({ ...med, diastolica: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Glicemia" htmlFor="visita-gli">
                <Input id="visita-gli" inputMode="numeric" value={med.glicemia} onChange={(e) => setMed({ ...med, glicemia: e.target.value })} />
              </Field>
              <Field label="Tipo" htmlFor="visita-gli-tipo">
                <Select id="visita-gli-tipo" value={med.tipoGlicemia} onChange={(e) => setMed({ ...med, tipoGlicemia: e.target.value })}>
                  {Object.entries(TIPO_GLICEMIA).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={localizar} loading={localizando} type="button">
            <LocateFixed className="mr-1 h-4 w-4" /> Marcar minha posição
          </Button>
          <span className="text-sm text-slate-600">
            {posicao
              ? `${posicao.latitude}, ${posicao.longitude}${posicao.precisao ? ` (±${posicao.precisao} m)` : ''}`
              : domicilio?.latitude
                ? 'Domicílio já tem posição no mapa'
                : 'Sem posição: o domicílio entra no mapa quando marcada'}
          </span>
        </div>
        <Field label="Observações" htmlFor="visita-obs">
          <Textarea id="visita-obs" rows={2} value={obs} onChange={(e) => setObs(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
