'use client';

import { localDateString, type DetalheSurto, type SugestaoSurtoTela } from '@omnisaude/shared';
import { BellPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { OpcaoAgravo } from './diagrama-agravos';
import { CampoUnidade, CamposAgravo, CamposLocal, CamposNotificacao, useUnidadesDoSurto } from './surto-campos';
import { corpoNovoSurto, formDaSugestao, formNovoSurto, isoParaLocal, pendenciasNovoSurto, ROTULO_VINCULO, type FormSurto } from './surto-regras';

/**
 * Notificação de surto (tipo 3 da ficha do Sinan Net, sem paciente): manual ou a partir de uma sugestão, que já traz o
 * agravo, os casos, o local inicial e o bairro. As notificações da sugestão entram na planilha de casos. Prazo imediato
 * (24 h do conhecimento) para a SMS; com ESP, também SES e MS.
 */
export function SurtoNovo({ sugestao, opcoes, onFechar, onCriado }: { sugestao: SugestaoSurtoTela | null; opcoes: OpcaoAgravo[]; onFechar: () => void; onCriado: (d: DetalheSurto) => void }) {
  const toast = useToast();
  const session = useSession();
  const tz = session.me?.tenant.timeZone ?? 'America/Sao_Paulo';
  const unidades = useUnidadesDoSurto();
  const inicio = useMemo(() => {
    const agora = new Date();
    const base = { hoje: localDateString(agora, tz), agora: isoParaLocal(agora.toISOString(), tz) };
    const unitId = session.me?.context.unitId ?? '';
    return sugestao ? formDaSugestao(sugestao, { ...base, unitIdPadrao: unitId, tz }) : formNovoSurto({ ...base, unitId });
    // O formulário nasce uma vez por abertura do diálogo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [f, setF] = useState<FormSurto>(inicio);
  const [tocado, setTocado] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const hoje = localDateString(new Date(), tz);
  const pend = pendenciasNovoSurto(f, { hoje, agoraIso: new Date().toISOString(), tz });
  const set = (patch: Partial<FormSurto>) => setF((x) => ({ ...x, ...patch }));

  async function notificar() {
    setTocado(true);
    if (pend.length) return;
    setBusy(true);
    setErro(null);
    try {
      const d = await api.post<DetalheSurto>('/vigilancia/surtos', { ...corpoNovoSurto(f, tz, sugestao) });
      toast.success(`Surto ${d.numero} notificado. Prazo da comunicação à SMS: ${fmtDateTime(d.venceEm)}.`);
      for (const a of d.avisos) toast.info(a);
      onCriado(d);
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      size="xl"
      onOpenChange={(o) => !o && onFechar()}
      title={sugestao ? 'Notificar surto a partir da sugestão' : 'Notificar surto'}
      description="Notificação de surto do Sinan Net (tipo 3): sem paciente; os casos vão para a planilha de acompanhamento. Os campos já preenchidos são só sugestão: confira antes de notificar."
      footer={
        <Button onClick={notificar} loading={busy} disabled={tocado && pend.length > 0}>
          <BellPlus className="h-4 w-4" /> Notificar surto
        </Button>
      }
    >
      <div className="space-y-5">
        {sugestao && (
          <Alert tone="info" title={sugestao.descricao}>
            {ROTULO_VINCULO[sugestao.vinculo.tipo]}: {sugestao.vinculoNome}. As {sugestao.casos.length} notificação(ões) da sugestão ({sugestao.casosDetalhe.map((c) => c.numero).join(', ')}) entram na planilha de casos.
            O último caso foi conhecido em {fmtDateTime(sugestao.ultimoConhecimento)}.
          </Alert>
        )}
        <section className="space-y-3" aria-label="Agravo">
          <p className="text-sm font-semibold text-slate-900">Agravo</p>
          <CamposAgravo prefixo="sn" f={f} set={set} opcoes={opcoes} />
        </section>
        <section className="space-y-3" aria-label="Notificação">
          <p className="text-sm font-semibold text-slate-900">Notificação</p>
          <div className="grid gap-3 md:grid-cols-3">
            <CampoUnidade id="sn-unidade" valor={f.unitId} onChange={(unitId) => set({ unitId })} unidades={unidades} />
            <Field label="Quando a vigilância soube do surto" htmlFor="sn-conhecido" hint="Início do prazo de 24 h. Fuso da instituição.">
              <Input id="sn-conhecido" type="datetime-local" max={isoParaLocal(new Date().toISOString(), tz)} value={f.conhecidoEm} onChange={(e) => set({ conhecidoEm: e.target.value })} />
            </Field>
          </div>
          <CamposNotificacao prefixo="sn" f={f} set={set} hoje={hoje} />
        </section>
        <details className="rounded-lg border border-slate-200 p-3" open={!!sugestao && sugestao.vinculo.tipo === 'BAIRRO'}>
          <summary className="cursor-pointer text-sm font-semibold text-slate-900">Local de ocorrência (opcional agora; completa-se na investigação)</summary>
          <div className="mt-3">
            <CamposLocal prefixo="sn-local" local={f.local} set={(patch) => set({ local: { ...f.local, ...patch } })} />
          </div>
        </details>
        {tocado && pend.length > 0 && (
          <Alert tone="warn" title="Falta para notificar">
            <ul className="list-inside list-disc space-y-0.5">
              {pend.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        )}
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}
