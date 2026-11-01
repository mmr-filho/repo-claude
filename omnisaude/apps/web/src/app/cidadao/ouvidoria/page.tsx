'use client';

import { ASSUNTO_MANIFESTACAO, TIPO_MANIFESTACAO } from '@omnisaude/shared';
import { MessageSquarePlus, Star } from 'lucide-react';
import { useState } from 'react';
import { citizenApi } from '@/components/citizen/api';
import { useCitizen } from '@/components/citizen/hooks';
import { CardItem, CitizenShell, Section } from '@/components/citizen/shell';
import type { Manifestacao, UnidadeRede } from '@/components/citizen/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { fmtDate } from '@/lib/format';

const TONE: Record<string, 'blue' | 'amber' | 'green' | 'slate' | 'violet' | 'red'> = { RECEBIDA: 'blue', EM_ANALISE: 'amber', PRORROGADA: 'violet', RESPONDIDA: 'green', ENCERRADA: 'slate', ARQUIVADA: 'slate' };

function Estrelas({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label="Nota">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} de 5`} onClick={() => onChange(n)} className="p-1">
          <Star className={`h-7 w-7 ${n <= value ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}`} />
        </button>
      ))}
    </div>
  );
}

export default function CitizenOmbudsmanPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useCitizen<Manifestacao[]>('/cidadao/ouvidoria');
  const unidades = useCitizen<UnidadeRede[]>('/cidadao/unidades');
  const [nova, setNova] = useState(false);
  const [form, setForm] = useState({ kind: 'RECLAMACAO', subject: 'ATENDIMENTO', unitId: '', text: '', anonymous: false });
  const [busy, setBusy] = useState(false);
  const [avaliando, setAvaliando] = useState<{ id: string; nota: number; comentario: string } | null>(null);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await citizenApi.post('/cidadao/ouvidoria', { ...form, unitId: form.unitId || null });
      toast.success('Manifestação registrada. Você recebe o protocolo e a resposta por aqui.');
      setNova(false);
      setForm({ kind: 'RECLAMACAO', subject: 'ATENDIMENTO', unitId: '', text: '', anonymous: false });
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function avaliar() {
    if (!avaliando) return;
    setBusy(true);
    try {
      await citizenApi.post(`/cidadao/ouvidoria/${avaliando.id}/avaliar`, { nota: avaliando.nota, comentario: avaliando.comentario || null });
      toast.success('Obrigado pela avaliação.');
      setAvaliando(null);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CitizenShell title="Ouvidoria">
      {error && <Alert tone="error">{error}</Alert>}
      <CardItem className="mb-4">
        <p className="text-sm text-slate-700">
          Reclamação, denúncia, sugestão, elogio ou pedido de informação sobre os serviços de saúde. A resposta chega em até 30 dias (Lei 13.460/2017), prorrogáveis uma vez com justificativa.
        </p>
        {!nova && (
          <Button className="mt-3" onClick={() => setNova(true)} id="cid-nova-manifestacao">
            <MessageSquarePlus className="h-4 w-4" /> Nova manifestação
          </Button>
        )}
        {nova && (
          <form onSubmit={enviar} className="mt-3 flex flex-col gap-3">
            <Field label="Tipo" htmlFor="ouv-tipo">
              <Select id="ouv-tipo" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {Object.entries(TIPO_MANIFESTACAO).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Assunto" htmlFor="ouv-assunto">
              <Select id="ouv-assunto" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })}>
                {Object.entries(ASSUNTO_MANIFESTACAO).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Unidade (se souber)" htmlFor="ouv-unidade">
              <Select id="ouv-unidade" value={form.unitId} onChange={(e) => setForm({ ...form, unitId: e.target.value })}>
                <option value="">Não sei / não se aplica</option>
                {unidades.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="O que aconteceu" htmlFor="ouv-texto" hint="Conte com suas palavras, com data e local se souber.">
              <Textarea id="ouv-texto" rows={4} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} required minLength={10} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={form.anonymous} onChange={(e) => setForm({ ...form, anonymous: e.target.checked })} id="ouv-anonima" />
              Não quero me identificar para a equipe (você continua acompanhando por aqui)
            </label>
            <div className="flex gap-2">
              <Button type="submit" loading={busy} id="ouv-enviar">
                Enviar
              </Button>
              <Button type="button" variant="ghost" onClick={() => setNova(false)}>
                Cancelar
              </Button>
            </div>
          </form>
        )}
      </CardItem>
      {loading && !data && <Spinner />}
      <Section title="Minhas manifestações">
        {data && data.length === 0 && <CardItem className="text-sm text-slate-500">Nenhuma manifestação registrada.</CardItem>}
        {data?.map((m) => (
          <CardItem key={m.id} className="mb-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium">
                  {m.tipoLabel} · {m.assuntoLabel}
                </p>
                <p className="text-xs text-slate-500">
                  Protocolo {m.protocolo} · {fmtDate(m.recebidaEm)}
                  {m.unidade ? ` · ${m.unidade}` : ''}
                  {m.anonima ? ' · sem identificação' : ''}
                </p>
              </div>
              <Badge tone={TONE[m.status] ?? 'slate'}>{m.statusLabel}</Badge>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{m.texto}</p>
            {!m.resposta && (
              <p className="mt-2 text-xs text-slate-500">
                Prazo de resposta: {fmtDate(m.venceEm)}
                {m.prorrogada ? ' (prorrogado com justificativa)' : ''}.
              </p>
            )}
            {m.resposta && (
              <div className="mt-2 rounded-lg bg-green-50 p-3 text-sm">
                <p className="text-xs font-semibold uppercase text-green-800">Resposta da ouvidoria{m.resposta.em ? ` · ${fmtDate(m.resposta.em)}` : ''}</p>
                <p className="mt-1 whitespace-pre-wrap text-green-900">{m.resposta.texto}</p>
              </div>
            )}
            {m.podeAvaliar && avaliando?.id !== m.id && (
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => setAvaliando({ id: m.id, nota: 0, comentario: '' })} id={`ouv-avaliar-${m.id}`}>
                <Star className="h-4 w-4" /> Avaliar a resposta
              </Button>
            )}
            {avaliando?.id === m.id && (
              <div className="mt-2 flex flex-col gap-2">
                <Estrelas value={avaliando.nota} onChange={(n) => setAvaliando({ ...avaliando, nota: n })} />
                <Textarea rows={2} placeholder="Comentário (opcional)" value={avaliando.comentario} onChange={(e) => setAvaliando({ ...avaliando, comentario: e.target.value })} />
                <div className="flex gap-2">
                  <Button size="sm" loading={busy} disabled={!avaliando.nota} onClick={avaliar} id="ouv-enviar-avaliacao">
                    Enviar avaliação
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAvaliando(null)}>
                    Agora não
                  </Button>
                </div>
              </div>
            )}
            {m.avaliacao != null && <p className="mt-2 text-xs text-slate-500">Você avaliou a resposta com nota {m.avaliacao} de 5.</p>}
          </CardItem>
        ))}
      </Section>
    </CitizenShell>
  );
}
