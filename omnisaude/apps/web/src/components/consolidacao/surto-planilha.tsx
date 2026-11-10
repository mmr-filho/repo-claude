'use client';

import { CLASSIFICACAO_CASO_SURTO, CRITERIO_CASO_SURTO, localDateString, type CasoSurto, type DetalheSurto, type RespostaCasoSurto } from '@omnisaude/shared';
import { Link2, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { STATUS, type PainelVigilancia } from '@/components/vigilancia/types';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useTerritorios } from './diagrama-seletores';
import { candidatasParaPlanilha, corpoLinhaCaso, dataBr, linhaVazia, origemDoCaso, pendenciasLinhaCaso, ROTULO_SEXO, simNao, textoCriterioCaso, type FormLinhaCaso } from './surto-regras';

const normalizar = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Mostra a resposta da inclusão: o caso e os avisos (agravo diferente, rascunho, caso em outro surto, sem notificação individual). */
function avisar(toast: ReturnType<typeof useToast>, r: RespostaCasoSurto) {
  toast.success(`Caso ${r.caso.numero} incluído na planilha.`);
  for (const a of r.avisos) toast.info(a);
}

/** Inclui uma notificação individual (do agravo do surto, quando houver) na planilha. */
function IncluirNotificacao({ d, onFechar, onFeito }: { d: DetalheSurto; onFechar: () => void; onFeito: () => void }) {
  const toast = useToast();
  const painel = useApi<PainelVigilancia>(`/vigilancia/painel${d.grupo ? `?${new URLSearchParams({ grupo: d.grupo })}` : ''}`);
  const [busca, setBusca] = useState('');
  const [sel, setSel] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const candidatas = useMemo(() => {
    const lista = candidatasParaPlanilha(painel.data?.notificacoes ?? [], d.planilha).filter((n) => n.podeAbrir);
    const t = normalizar(busca.trim());
    return t ? lista.filter((n) => normalizar([n.numero, n.paciente ?? '', n.unidade ?? '', n.agravo].join(' ')).includes(t)) : lista;
  }, [painel.data, d.planilha, busca]);
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onFechar()}
      title="Incluir notificação na planilha"
      description={`Notificações individuais ${d.grupo ? `de ${d.agravo} ` : ''}ainda fora da planilha (as mais recentes, sem as descartadas). O surto não substitui a notificação individual.`}
      footer={
        <Button
          disabled={!sel}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              const r = await api.post<RespostaCasoSurto>(`/vigilancia/surtos/${d.id}/casos`, { notificationId: sel });
              avisar(toast, r);
              onFeito();
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Link2 className="h-4 w-4" /> Incluir
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Buscar" htmlFor="sp-busca">
          <Input id="sp-busca" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Número, paciente ou unidade" autoComplete="off" />
        </Field>
        {painel.error && <Alert tone="error">{painel.error}</Alert>}
        {painel.loading && !painel.data && <Spinner />}
        {painel.data && candidatas.length === 0 && <p className="text-sm text-slate-600">Nenhuma notificação para incluir.</p>}
        {candidatas.length > 0 && (
          <fieldset className="max-h-80 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
            <legend className="sr-only">Notificações</legend>
            {candidatas.slice(0, 100).map((n) => (
              <label key={n.id} className={cn('flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50', sel === n.id && 'bg-brand-50')}>
                <input type="radio" name="sp-notificacao" className="mt-1" checked={sel === n.id} onChange={() => setSel(n.id)} />
                <span className="flex-1">
                  <span className="font-medium tabular-nums">{n.numero}</span> · {n.agravo}
                  <span className="block text-xs text-slate-600">
                    {n.paciente ?? 'paciente sob sigilo'} · {n.unidade ?? '—'} · {fmtDateTime(n.criadaEm)}
                  </span>
                </span>
                <Badge tone={STATUS[n.status]?.tone ?? 'slate'}>{STATUS[n.status]?.label ?? n.status}</Badge>
              </label>
            ))}
          </fieldset>
        )}
        {candidatas.length > 100 && <p className="text-xs text-slate-500">Mostrando 100 de {candidatas.length}: refine a busca.</p>}
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}

/** A linha ainda vazia: o botão fica desabilitado, sem aviso. */
const VAZIA = 'Preencha ao menos um campo da linha.';

/** Linha manual da planilha (caso sem notificação no OmniSaúde). */
function LinhaManual({ d, onFechar, onFeito }: { d: DetalheSurto; onFechar: () => void; onFeito: () => void }) {
  const toast = useToast();
  const session = useSession();
  const hoje = localDateString(new Date(), session.me?.tenant.timeZone ?? 'America/Sao_Paulo');
  const t = useTerritorios('BAIRRO');
  const [f, setF] = useState<FormLinhaCaso>(linhaVazia());
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const pend = pendenciasLinhaCaso(f, hoje);
  const set = (patch: Partial<FormLinhaCaso>) => setF((x) => ({ ...x, ...patch }));
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onFechar()}
      title="Incluir linha na planilha"
      description="Para o caso sem notificação no OmniSaúde. Use só as iniciais do nome. Caso de agravo da lista continua precisando da notificação individual."
      footer={
        <Button
          disabled={pend.length > 0}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              const r = await api.post<RespostaCasoSurto>(`/vigilancia/surtos/${d.id}/casos`, { linha: { ...corpoLinhaCaso(f) } });
              avisar(toast, r);
              onFeito();
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Plus className="h-4 w-4" /> Incluir linha
        </Button>
      }
    >
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Iniciais" htmlFor="sl-iniciais">
          <Input id="sl-iniciais" maxLength={15} value={f.iniciais} onChange={(e) => set({ iniciais: e.target.value.toUpperCase() })} placeholder="Ex.: MAS" />
        </Field>
        <Field label="Sexo" htmlFor="sl-sexo">
          <Select id="sl-sexo" value={f.sexo} onChange={(e) => set({ sexo: e.target.value })}>
            <option value="">Não informado</option>
            {Object.entries(ROTULO_SEXO).map(([c, n]) => (
              <option key={c} value={c}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Idade" htmlFor="sl-idade" hint="Ex.: 34 anos, 5 meses, 10 dias.">
          <Input id="sl-idade" maxLength={12} value={f.idade} onChange={(e) => set({ idade: e.target.value })} />
        </Field>
        <Field label="Município de residência (IBGE)" htmlFor="sl-ibge">
          <Input id="sl-ibge" inputMode="numeric" maxLength={7} value={f.municipioResidencia} onChange={(e) => set({ municipioResidencia: e.target.value.replace(/\D/g, '') })} />
        </Field>
        {t.pode && (
          <Field label="Bairro" htmlFor="sl-bairro">
            <Select id="sl-bairro" value={f.bairroId} onChange={(e) => set({ bairroId: e.target.value })} disabled={t.carregando}>
              <option value="">Não informado</option>
              {[...t.bairros]
                .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field label="Início dos sintomas" htmlFor="sl-sintomas">
          <Input id="sl-sintomas" type="date" max={hoje} value={f.inicioSintomas} onChange={(e) => set({ inicioSintomas: e.target.value })} />
        </Field>
        <Field label="Hospitalizado" htmlFor="sl-hosp">
          <Select id="sl-hosp" value={f.hospitalizado} onChange={(e) => set({ hospitalizado: e.target.value as FormLinhaCaso['hospitalizado'] })}>
            <option value="">Ignorado</option>
            <option value="S">Sim</option>
            <option value="N">Não</option>
          </Select>
        </Field>
        <Field label="Óbito" htmlFor="sl-obito">
          <Select id="sl-obito" value={f.obito} onChange={(e) => set({ obito: e.target.value as FormLinhaCaso['obito'] })}>
            <option value="">Ignorado</option>
            <option value="S">Sim</option>
            <option value="N">Não</option>
          </Select>
        </Field>
        <Field label="Classificação final" htmlFor="sl-classi">
          <Select id="sl-classi" value={f.classificacao} onChange={(e) => set({ classificacao: e.target.value })}>
            <option value="">Não informada</option>
            {Object.entries(CLASSIFICACAO_CASO_SURTO).map(([c, n]) => (
              <option key={c} value={c}>
                {c} - {n}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Critério de confirmação" htmlFor="sl-criterio" hint="Códigos do dicionário de dados (a legenda da planilha impressa diverge).">
          <Select id="sl-criterio" value={f.criterio} onChange={(e) => set({ criterio: e.target.value })}>
            <option value="">Não informado</option>
            {Object.entries(CRITERIO_CASO_SURTO).map(([c, n]) => (
              <option key={c} value={c}>
                {c} - {n}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Diagnóstico final (CID-10)" htmlFor="sl-cid">
          <Input id="sl-cid" maxLength={6} value={f.cidFinal} onChange={(e) => set({ cidFinal: e.target.value })} />
        </Field>
        {pend.some((p) => p !== VAZIA) && (
          <Alert tone="warn" className="md:col-span-3">
            <ul className="list-inside list-disc space-y-0.5">
              {pend.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        )}
        {erro && (
          <Alert tone="error" className="md:col-span-3">
            {erro}
          </Alert>
        )}
      </div>
    </Dialog>
  );
}

/** Retira o caso da planilha (o número do caso não se reaproveita). */
function Retirar({ d, c, onFechar, onFeito }: { d: DetalheSurto; c: CasoSurto; onFechar: () => void; onFeito: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  return (
    <Dialog
      open
      size="sm"
      onOpenChange={(o) => !o && onFechar()}
      title={`Retirar o caso ${c.numero}`}
      description={`${origemDoCaso(c)}. A retirada fica na linha do tempo do surto; o número ${c.numero} não volta a ser usado.`}
      footer={
        <Button
          variant="danger"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              await api.delete(`/vigilancia/surtos/${d.id}/casos/${c.id}`);
              toast.success(`Caso ${c.numero} retirado da planilha.`);
              onFeito();
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Trash2 className="h-4 w-4" /> Retirar
        </Button>
      }
    >
      {erro ? <Alert tone="error">{erro}</Alert> : <p className="text-sm text-slate-700">Confirme para retirar o caso da planilha.</p>}
    </Dialog>
  );
}

/** Planilha de acompanhamento do surto: uma linha por caso (notificação, registro oficial ou linha manual). */
export function SurtoPlanilha({ d, onMudou }: { d: DetalheSurto; onMudou: () => void }) {
  const session = useSession();
  const editavel = d.permissoes.editar;
  const podeBuscar = session.can('vigilancia.painel');
  const [acao, setAcao] = useState<{ tipo: 'notificacao' | 'manual' } | { tipo: 'retirar'; c: CasoSurto } | null>(null);
  const feito = () => {
    setAcao(null);
    onMudou();
  };
  return (
    <Card>
      <CardHeader
        title={`Planilha de casos (${d.planilha.length} de ${d.casos} informados)`}
        description="Preenchida ao fim de cada semana epidemiológica até o encerramento. Caso de agravo da lista sem notificação individual fica marcado."
        actions={
          editavel ? (
            <>
              {podeBuscar && (
                <Button size="sm" onClick={() => setAcao({ tipo: 'notificacao' })}>
                  <Link2 className="h-4 w-4" /> Incluir notificação
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => setAcao({ tipo: 'manual' })}>
                <Plus className="h-4 w-4" /> Linha manual
              </Button>
            </>
          ) : undefined
        }
      />
      {d.planilha.length === 0 ? (
        <EmptyState title="Nenhum caso na planilha" description={editavel ? 'Inclua as notificações dos casos ou linhas manuais.' : undefined} />
      ) : (
        <Table className="text-xs">
          <THead>
            <tr>
              <TH>Nº</TH>
              <TH>Iniciais</TH>
              <TH>Sexo</TH>
              <TH>Idade</TH>
              <TH>Residência</TH>
              <TH>Início dos sintomas</TH>
              <TH>Hospitalizado</TH>
              <TH>Óbito</TH>
              <TH>Classificação</TH>
              <TH>Critério</TH>
              <TH>CID final</TH>
              <TH>Origem</TH>
              {editavel && <TH className="text-right">Retirar</TH>}
            </tr>
          </THead>
          <TBody>
            {d.planilha.map((c) => (
              <TR key={c.id}>
                <TD className="font-medium tabular-nums">{c.numero}</TD>
                <TD>{c.iniciais ?? '—'}</TD>
                <TD>{c.sexo ? (ROTULO_SEXO[c.sexo] ?? c.sexo) : '—'}</TD>
                <TD className="whitespace-nowrap">{c.idade ?? '—'}</TD>
                <TD>
                  {c.bairroNome ?? '—'}
                  {c.municipioResidencia && <span className="block text-slate-500">IBGE {c.municipioResidencia}</span>}
                </TD>
                <TD className="tabular-nums">{dataBr(c.inicioSintomas)}</TD>
                <TD>{simNao(c.hospitalizado)}</TD>
                <TD>{simNao(c.obito)}</TD>
                <TD>{c.classificacao ? `${c.classificacao} - ${CLASSIFICACAO_CASO_SURTO[c.classificacao] ?? '?'}` : '—'}</TD>
                <TD>{textoCriterioCaso(c.criterio)}</TD>
                <TD>{c.cidFinal ?? '—'}</TD>
                <TD>
                  {origemDoCaso(c)}
                  {c.semNotificacaoIndividual && (
                    <Badge tone="amber" className="mt-0.5">
                      Sem notificação individual
                    </Badge>
                  )}
                </TD>
                {editavel && (
                  <TD className="text-right">
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-red-700" aria-label={`Retirar o caso ${c.numero}`} onClick={() => setAcao({ tipo: 'retirar', c })}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TD>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {acao?.tipo === 'notificacao' && <IncluirNotificacao d={d} onFechar={() => setAcao(null)} onFeito={feito} />}
      {acao?.tipo === 'manual' && <LinhaManual d={d} onFechar={() => setAcao(null)} onFeito={feito} />}
      {acao?.tipo === 'retirar' && <Retirar d={d} c={acao.c} onFechar={() => setAcao(null)} onFeito={feito} />}
    </Card>
  );
}
