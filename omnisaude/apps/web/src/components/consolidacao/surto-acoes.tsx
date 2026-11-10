'use client';

import { DELIMITACAO_SURTO, localDateString, type DetalheSurto } from '@omnisaude/shared';
import { Ban, CheckCheck, Hash, Megaphone } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  corpoComunicacao,
  corpoEncerramento,
  ESFERAS_SURTO,
  faltaNoMotivo,
  isoParaLocal,
  MINIMO_MOTIVO,
  numeroSinanValido,
  pendenciasComunicacao,
  pendenciasEncerramento,
  ROTULO_CANAL_COMUNICACAO,
  type FormComunicacao,
  type FormEncerramento,
} from './surto-regras';

interface PropsAcao {
  d: DetalheSurto;
  onFechar: () => void;
  onFeito: (novo: DetalheSurto) => void;
}

function useFuso() {
  const session = useSession();
  return session.me?.tenant.timeZone ?? 'America/Sao_Paulo';
}

function Pendencias({ itens }: { itens: string[] }) {
  if (!itens.length) return null;
  return (
    <Alert tone="warn">
      <ul className="list-inside list-disc space-y-0.5">
        {itens.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </Alert>
  );
}

/** Encerramento: delimitação espacial (DELIMITA, 1 a 11), data e notas; exige a investigação gravada. */
export function EncerrarSurto({ d, onFechar, onFeito }: PropsAcao) {
  const toast = useToast();
  const tz = useFuso();
  const hoje = localDateString(new Date(), tz);
  const [f, setF] = useState<FormEncerramento>({ delimitacao: d.localInicial, texto: d.localInicial === '11' ? (d.localInicialTexto ?? '') : '', data: hoje, notas: '' });
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const pend = pendenciasEncerramento(d, f, hoje);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onFechar()}
      title={`Encerrar o surto ${d.numero}`}
      description="Delimitação espacial do surto e data do encerramento (igual ou depois da notificação). Depois de encerrado, a ficha fica só para leitura."
      footer={
        <Button
          variant="success"
          disabled={pend.length > 0}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              const novo = await api.post<DetalheSurto>(`/vigilancia/surtos/${d.id}/encerrar`, { ...corpoEncerramento(f) });
              toast.success(`Surto ${novo.numero} encerrado.`);
              onFeito(novo);
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <CheckCheck className="h-4 w-4" /> Encerrar
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Delimitação do surto" htmlFor="se-delimitacao">
          <Select id="se-delimitacao" value={f.delimitacao} onChange={(e) => setF({ ...f, delimitacao: e.target.value })}>
            <option value="">Escolha</option>
            {Object.entries(DELIMITACAO_SURTO).map(([c, n]) => (
              <option key={c} value={c}>
                {c} - {n}
              </option>
            ))}
          </Select>
        </Field>
        {f.delimitacao === '11' && (
          <Field label="Qual delimitação (outros)" htmlFor="se-texto">
            <Input id="se-texto" maxLength={200} value={f.texto} onChange={(e) => setF({ ...f, texto: e.target.value })} />
          </Field>
        )}
        <Field label="Data do encerramento" htmlFor="se-data">
          <Input id="se-data" type="date" min={d.notificadoEm} max={hoje} value={f.data} onChange={(e) => setF({ ...f, data: e.target.value })} />
        </Field>
        <Field label="Notas do encerramento (opcional)" htmlFor="se-notas" hint="Medidas adotadas, conclusão da investigação.">
          <Textarea id="se-notas" rows={3} maxLength={4000} value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} />
        </Field>
        <Pendencias itens={pend} />
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}

/** Descarte (só a vigilância municipal): motivo com pelo menos 10 caracteres. */
export function DescartarSurto({ d, onFechar, onFeito }: PropsAcao) {
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const falta = faltaNoMotivo(motivo);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onFechar()}
      title={`Descartar o surto ${d.numero}`}
      description="Para a suspeita de surto que não se confirmou. Os prazos deixam de contar e o motivo fica registrado."
      footer={
        <Button
          variant="danger"
          disabled={falta > 0}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              const novo = await api.post<DetalheSurto>(`/vigilancia/surtos/${d.id}/descartar`, { motivo: motivo.trim() });
              toast.success(`Surto ${novo.numero} descartado.`);
              onFeito(novo);
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Ban className="h-4 w-4" /> Descartar
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Motivo" htmlFor="sd-motivo" hint={falta ? `Pelo menos ${MINIMO_MOTIVO} caracteres (faltam ${falta}).` : undefined}>
          <Textarea id="sd-motivo" rows={3} maxLength={1000} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </Field>
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}

/** Número da notificação de surto no Sinan Net (NU_NOTIFIC, 1 a 7 dígitos), informado por quem digita. */
export function NumeroSinanSurto({ d, onFechar, onFeito }: PropsAcao) {
  const toast = useToast();
  const [numero, setNumero] = useState(d.numeroOficial ?? '');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const valido = numeroSinanValido(numero) && numero.trim() !== (d.numeroOficial ?? '');
  return (
    <Dialog
      open
      size="sm"
      onOpenChange={(o) => !o && onFechar()}
      title="Número do Sinan"
      description="Depois de digitar a notificação de surto no Sinan Net, informe o número que ele gerou."
      footer={
        <Button
          disabled={!valido}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              const novo = await api.post<DetalheSurto>(`/vigilancia/surtos/${d.id}/numero-oficial`, { numero: numero.trim() });
              toast.success(`Número do Sinan ${numero.trim()} gravado.`);
              onFeito(novo);
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Hash className="h-4 w-4" /> Gravar
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="NU_NOTIFIC" htmlFor="sn-numero" error={numero.trim() && !numeroSinanValido(numero) ? 'De 1 a 7 dígitos.' : null}>
          <Input id="sn-numero" inputMode="numeric" maxLength={7} value={numero} onChange={(e) => setNumero(e.target.value.replace(/\D/g, ''))} />
        </Field>
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}

/**
 * Comunicação do surto a uma esfera (vira evento da linha do tempo e cumpre o prazo). O núcleo comunica à SMS; à SES
 * e ao MS, a vigilância municipal (`municipal`).
 */
export function ComunicarSurto({ d, municipal, onFechar, onFeito }: PropsAcao & { municipal: boolean }) {
  const toast = useToast();
  const tz = useFuso();
  const alvos = municipal ? ESFERAS_SURTO : (['SMS'] as const);
  const pendente = d.prazos.find((p) => p.situacao !== 'CUMPRIDO' && (alvos as readonly string[]).includes(p.esfera))?.esfera;
  const [f, setF] = useState<FormComunicacao>({ alvo: pendente ?? 'SMS', canal: 'TELEFONE', contraparte: '', protocolo: '', nota: '', em: isoParaLocal(new Date().toISOString(), tz) });
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const pend = pendenciasComunicacao(f, { tz, agoraIso: new Date().toISOString(), conhecidoEm: d.conhecidoEm });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onFechar()}
      title={`Registrar comunicação do surto ${d.numero}`}
      description="A comunicação imediata (24 h do conhecimento) é pelo meio mais rápido: telefone, e-mail ou formulário. Registre com quem falou e o protocolo, se houver."
      footer={
        <Button
          disabled={pend.length > 0}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              const novo = await api.post<DetalheSurto>(`/vigilancia/surtos/${d.id}/comunicacoes`, { ...corpoComunicacao(f, tz) });
              toast.success(`Comunicação à ${f.alvo} registrada.`);
              onFeito(novo);
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Megaphone className="h-4 w-4" /> Registrar
        </Button>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Para quem" htmlFor="sc-alvo" hint={municipal ? undefined : 'O repasse à SES e ao MS é da vigilância municipal.'}>
          <Select id="sc-alvo" value={f.alvo} onChange={(e) => setF({ ...f, alvo: e.target.value as FormComunicacao['alvo'] })}>
            {alvos.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Meio" htmlFor="sc-canal">
          <Select id="sc-canal" value={f.canal} onChange={(e) => setF({ ...f, canal: e.target.value as FormComunicacao['canal'] })}>
            {Object.entries(ROTULO_CANAL_COMUNICACAO).map(([c, n]) => (
              <option key={c} value={c}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Com quem falou" htmlFor="sc-contraparte">
          <Input id="sc-contraparte" maxLength={120} value={f.contraparte} onChange={(e) => setF({ ...f, contraparte: e.target.value })} placeholder="Nome ou setor (ex.: plantão CIEVS)" />
        </Field>
        <Field label="Quando" htmlFor="sc-em" hint="Fuso da instituição.">
          <Input id="sc-em" type="datetime-local" max={isoParaLocal(new Date().toISOString(), tz)} value={f.em} onChange={(e) => setF({ ...f, em: e.target.value })} />
        </Field>
        <Field label="Protocolo (opcional)" htmlFor="sc-protocolo">
          <Input id="sc-protocolo" maxLength={60} value={f.protocolo} onChange={(e) => setF({ ...f, protocolo: e.target.value })} />
        </Field>
        <Field label="Nota (opcional)" htmlFor="sc-nota">
          <Input id="sc-nota" maxLength={1000} value={f.nota} onChange={(e) => setF({ ...f, nota: e.target.value })} />
        </Field>
        <div className="md:col-span-2">
          <Pendencias itens={pend.filter((p) => !p.startsWith('Informe com quem') || f.contraparte.length > 0)} />
        </div>
        {erro && (
          <Alert tone="error" className="md:col-span-2">
            {erro}
          </Alert>
        )}
      </div>
    </Dialog>
  );
}
