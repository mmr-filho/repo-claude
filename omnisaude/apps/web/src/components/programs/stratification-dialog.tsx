'use client';

import {
  classificarPeDiabetico,
  classificarRiscoGestacional,
  ESTRATIFICACAO_LABEL,
  GESTANTE_ALTO_RISCO,
  GESTANTE_ATENCAO,
  MCHAT_ITENS,
  PE_DIABETICO_ITENS,
  pontuarMchat,
  type TipoEstratificacao,
} from '@omnisaude/shared';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';

export interface StratificationResult {
  id: string;
  kind: TipoEstratificacao;
  result: string;
  score: number | null;
  nextDueAt: string | null;
}

export const RESULT_LABEL: Record<string, string> = {
  ALTO_RISCO: 'Alto risco',
  RISCO_HABITUAL: 'Risco habitual',
  BAIXO: 'Risco baixo',
  MEDIO: 'Risco médio',
  ALTO: 'Risco alto',
  '0': 'Grau 0',
  '1': 'Grau 1',
  '2': 'Grau 2',
  '3': 'Grau 3',
};
export const RESULT_TONE: Record<string, 'green' | 'amber' | 'red' | 'slate'> = {
  ALTO_RISCO: 'red',
  RISCO_HABITUAL: 'green',
  BAIXO: 'green',
  MEDIO: 'amber',
  ALTO: 'red',
  '0': 'green',
  '1': 'amber',
  '2': 'amber',
  '3': 'red',
};

/** Formulário dos instrumentos de estratificação (risco gestacional, pé diabético, M-CHAT-R). */
export function StratificationDialog({
  patientId,
  patientName,
  kind,
  encounterId,
  open,
  onOpenChange,
  onSaved,
}: {
  patientId: string;
  patientName?: string;
  kind: TipoEstratificacao;
  encounterId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (result: StratificationResult) => void;
}) {
  const toast = useToast();
  const [marcados, setMarcados] = useState<string[]>([]);
  const [respostas, setRespostas] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const toggle = (c: string) => setMarcados((m) => (m.includes(c) ? m.filter((x) => x !== c) : [...m, c]));

  const previa = useMemo(() => {
    if (kind === 'GESTANTE') {
      const r = classificarRiscoGestacional(marcados);
      return { rotulo: RESULT_LABEL[r.resultado] ?? r.resultado, tone: RESULT_TONE[r.resultado] ?? 'slate', orientacao: r.orientacao, pronto: true };
    }
    if (kind === 'PE_DIABETICO') {
      const r = classificarPeDiabetico(marcados);
      return { rotulo: r.descricao, tone: RESULT_TONE[String(r.grau)] ?? 'slate', orientacao: r.orientacao, pronto: true };
    }
    if (Object.keys(respostas).length < MCHAT_ITENS.length) return { rotulo: `${Object.keys(respostas).length} de ${MCHAT_ITENS.length} itens respondidos`, tone: 'slate' as const, orientacao: '', pronto: false };
    const r = pontuarMchat(respostas);
    return { rotulo: `${RESULT_LABEL[r.resultado]} (${r.pontos} pontos)`, tone: RESULT_TONE[r.resultado] ?? 'slate', orientacao: r.orientacao, pronto: true };
  }, [kind, marcados, respostas]);

  async function salvar() {
    setBusy(true);
    try {
      const saved = await api.post<StratificationResult>('/programas/estratificacoes', {
        patientId,
        kind,
        answers: kind === 'MCHAT' ? respostas : marcados,
        ...(encounterId ? { encounterId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      toast.success(`${ESTRATIFICACAO_LABEL[kind]}: ${RESULT_LABEL[saved.result] ?? saved.result}`);
      setMarcados([]);
      setRespostas({});
      setNotes('');
      onOpenChange(false);
      onSaved?.(saved);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const lista = (titulo: string, itens: { codigo: string; descricao: string }[]) => (
    <div className="mb-3">
      <p className="mb-1 text-sm font-medium text-slate-800">{titulo}</p>
      <div className="grid gap-1 sm:grid-cols-2">
        {itens.map((c) => (
          <label key={c.codigo} className="flex items-start gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-slate-50">
            <input type="checkbox" className="mt-1 h-4 w-4" checked={marcados.includes(c.codigo)} onChange={() => toggle(c.codigo)} />
            <span>{c.descricao}</span>
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${ESTRATIFICACAO_LABEL[kind]}${patientName ? ` · ${patientName}` : ''}`}
      footer={
        <Button onClick={() => void salvar()} loading={busy} disabled={!previa.pronto}>
          Registrar
        </Button>
      }
    >
      <div className="max-h-[60vh] overflow-y-auto pr-1">
        {kind === 'GESTANTE' && (
          <>
            {lista('Fatores que indicam pré-natal de alto risco', GESTANTE_ALTO_RISCO)}
            {lista('Fatores de atenção (pré-natal na equipe com acompanhamento reforçado)', GESTANTE_ATENCAO)}
          </>
        )}
        {kind === 'PE_DIABETICO' && lista('Achados da avaliação do pé', PE_DIABETICO_ITENS)}
        {kind === 'MCHAT' && (
          <div className="flex flex-col gap-2">
            {MCHAT_ITENS.map((item) => (
              <div key={item.numero} className="rounded-md border border-slate-100 p-2 text-sm">
                <p className="mb-1">
                  <b>{item.numero}.</b> {item.pergunta}
                </p>
                <div className="flex gap-4">
                  {[
                    [true, 'Sim'],
                    [false, 'Não'],
                  ].map(([v, l]) => (
                    <label key={String(v)} className="flex items-center gap-1">
                      <input type="radio" name={`mchat-${item.numero}`} checked={respostas[String(item.numero)] === v} onChange={() => setRespostas((r) => ({ ...r, [String(item.numero)]: v as boolean }))} />
                      {l as string}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <Field label="Observações" htmlFor="strat-notes" className="mt-3">
          <Input id="strat-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <p className="mt-3 text-sm">
          <Badge tone={previa.tone}>{previa.rotulo}</Badge> <span className="text-slate-600">{previa.orientacao}</span>
        </p>
      </div>
    </Dialog>
  );
}
