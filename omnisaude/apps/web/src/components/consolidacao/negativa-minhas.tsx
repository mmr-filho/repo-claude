'use client';

import { ROTULO_SITUACAO_UNIDADE_SEMANA, ROTULO_STATUS_ATESTO, ROTULO_TIPO_RESPONSAVEL, type AtestoNegativa, type RespostaMinhasNegativas, type SemanaParaAtestar, type UnidadeRef } from '@omnisaude/shared';
import { CheckCircle2, Download, Info } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, Stat } from '@/components/ui/card';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, saveBlob } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { dataBr, resumoMinhas, rotuloSemana, textoCancelamento, TOM_SITUACAO, TOM_STATUS_ATESTO } from './negativa-regras';

/** Baixa o espelho em PDF do atesto. */
function BotaoPdf({ atesto, rotulo = 'PDF' }: { atesto: Pick<AtestoNegativa, 'id' | 'cnes' | 'semana'>; rotulo?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const { blob, fileName } = await api.download(`/vigilancia/negativas/${atesto.id}/espelho.pdf`);
          saveBlob(blob, fileName ?? `negativa-${atesto.cnes}-${atesto.semana}.pdf`);
        } catch (err) {
          toast.error(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Download className="h-4 w-4" /> {rotulo}
    </Button>
  );
}

/** Uma semana fechada da unidade: situação, prazo, atesto e, quando pode, o texto e o botão de atestar. */
function SemanaDaUnidade({ unidade, s, onAtestado }: { unidade: UnidadeRef; s: SemanaParaAtestar; onAtestado: () => void }) {
  const toast = useToast();
  const [confirmo, setConfirmo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const id = `neg-${unidade.id}-${s.semana}`;
  return (
    <li className="space-y-2 px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-slate-900">
            SE {rotuloSemana(s.semana)}{' '}
            <span className="font-normal text-slate-600">
              ({dataBr(s.inicio)} a {dataBr(s.fim)})
            </span>
          </p>
          <p className="text-xs text-slate-600">
            {s.atesto
              ? `Atestada em ${fmtDateTime(s.atesto.atestadoEm)} por ${s.atesto.atestadoPor}${s.atesto.atrasado ? ', fora do prazo' : ', no prazo'}${s.atesto.emNome ? ' (registrada pela vigilância)' : ''}.`
              : s.prazoPassou
                ? `Prazo vencido em ${fmtDateTime(s.prazo)}${s.podeAtestar ? ': o atesto ainda é aceito e fica marcado como fora do prazo.' : '.'}`
                : `Prazo: ${fmtDateTime(s.prazo)}.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={TOM_SITUACAO[s.situacao]}>{ROTULO_SITUACAO_UNIDADE_SEMANA[s.situacao]}</Badge>
          {s.atesto && <Badge tone={TOM_STATUS_ATESTO[s.atesto.status]}>{ROTULO_STATUS_ATESTO[s.atesto.status]}</Badge>}
          {s.atesto && <BotaoPdf atesto={s.atesto} />}
        </div>
      </div>
      {s.atesto && textoCancelamento(s.atesto) && <p className="text-xs text-amber-800">{textoCancelamento(s.atesto)}</p>}
      {!s.podeAtestar && s.motivo && !s.atesto && <p className="text-xs text-slate-600">{s.motivo}</p>}
      {s.podeAtestar && (
        <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Texto do atesto</p>
          <p className="text-sm leading-relaxed text-slate-800" id={`${id}-texto`}>
            {s.texto}
          </p>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-0.5" checked={confirmo} onChange={(e) => setConfirmo(e.target.checked)} aria-describedby={`${id}-texto`} />
            Li a declaração e confirmo que não houve caso na semana.
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!confirmo}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setErro(null);
                try {
                  const a = await api.post<AtestoNegativa>('/vigilancia/negativas', { unitId: unidade.id, semana: s.semana });
                  toast.success(`Negativa da SE ${rotuloSemana(s.semana)} atestada${a.atrasado ? ' (fora do prazo)' : ''}.`);
                  setConfirmo(false);
                  onAtestado();
                } catch (err) {
                  setErro(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <CheckCircle2 className="h-4 w-4" /> Atestar
            </Button>
            {s.prazoPassou && <span className="text-xs text-amber-800">Fora do prazo: o atesto fica marcado como atrasado.</span>}
          </div>
          {erro && <Alert tone="error">{erro}</Alert>}
        </div>
      )}
    </li>
  );
}

/**
 * Tela do responsável pela notificação negativa: as unidades em que é titular ou substituto, as semanas fechadas a
 * atestar com o texto do atesto à vista, o histórico e o espelho em PDF. Permissão `notificacao.negativa`; a API exige
 * a designação ativa (e a lotação ativa na unidade).
 */
export function NegativaMinhas() {
  const r = useApi<RespostaMinhasNegativas>('/vigilancia/negativas/minhas');
  const resumo = r.data ? resumoMinhas(r.data) : null;
  return (
    <div className="space-y-4">
      <Alert tone="info">
        <span className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            A notificação negativa é a comunicação semanal do responsável pela unidade à vigilância de que não houve caso de doença, agravo ou evento da Lista Nacional na semana (PRC GM/MS nº 4/2017, Anexo V, art. 2º,
            IX). Semana com notificação já conta como positiva e não se atesta.
          </span>
        </span>
      </Alert>
      {r.error && <Alert tone="error">{r.error}</Alert>}
      {r.loading && !r.data && <Spinner />}
      {r.data && resumo && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Unidades sob sua responsabilidade" value={resumo.unidades} />
            <Stat label="Semanas a atestar" value={resumo.aAtestar} tone={resumo.aAtestar ? 'warn' : 'good'} />
            <Stat label="Com o prazo vencido" value={resumo.vencidas} tone={resumo.vencidas ? 'bad' : 'good'} />
          </div>
          {r.data.unidades.length === 0 ? (
            <Card>
              <EmptyState
                title="Você não é responsável por nenhuma unidade"
                description="A vigilância epidemiológica municipal designa o titular e os substitutos da notificação negativa de cada unidade notificante, entre os profissionais lotados nela."
              />
            </Card>
          ) : (
            r.data.unidades.map((u) => (
              <Card key={u.unidade.id}>
                <CardHeader title={u.unidade.nome} description={`CNES ${u.unidade.cnes}`} actions={<Badge tone={u.tipo === 'TITULAR' ? 'blue' : 'slate'}>{ROTULO_TIPO_RESPONSAVEL[u.tipo]}</Badge>} />
                <ul className="divide-y divide-slate-100">
                  {u.semanas.map((s) => (
                    <SemanaDaUnidade key={s.semana} unidade={u.unidade} s={s} onAtestado={() => void r.reload()} />
                  ))}
                </ul>
              </Card>
            ))
          )}
          <Card>
            <CardHeader title="Histórico de atestos" description="Os atestos das suas unidades e os que você fez (até 100, do mais recente para o mais antigo)." />
            {r.data.historico.length === 0 ? (
              <CardBody className="pt-3 text-sm text-slate-600">Nenhum atesto ainda.</CardBody>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Semana</TH>
                    <TH>Unidade</TH>
                    <TH>Situação</TH>
                    <TH>Atestado</TH>
                    <TH>Observação</TH>
                    <TH className="text-right">Espelho</TH>
                  </tr>
                </THead>
                <TBody>
                  {r.data.historico.map((a) => (
                    <TR key={a.id}>
                      <TD className="whitespace-nowrap tabular-nums">SE {rotuloSemana(a.semana)}</TD>
                      <TD>
                        {a.unidade}
                        <span className="block text-xs text-slate-500">CNES {a.cnes}</span>
                      </TD>
                      <TD>
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={TOM_STATUS_ATESTO[a.status]}>{ROTULO_STATUS_ATESTO[a.status]}</Badge>
                          {a.atrasado && <Badge tone="amber">Fora do prazo</Badge>}
                          {a.emNome && <Badge tone="violet">Pela vigilância</Badge>}
                        </div>
                      </TD>
                      <TD className="text-sm">
                        {fmtDateTime(a.atestadoEm)}
                        <span className="block text-xs text-slate-500">
                          {a.atestadoPor}
                          {a.funcao ? `, ${a.funcao}` : ''}
                        </span>
                      </TD>
                      <TD className="text-xs text-slate-600">{textoCancelamento(a) ?? (a.registroOficialId ? 'Negativa digitada no Sinan.' : '—')}</TD>
                      <TD className="text-right">
                        <BotaoPdf atesto={a} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
