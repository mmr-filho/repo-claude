'use client';

import { ALERTA_PENDENCIA, META_PENDENCIA, type ProgressoBloqueio } from '@omnisaude/shared';
import { useMemo, useState } from 'react';
import { MapaTerritorio } from '@/components/territorio/mapa-territorio';
import type { CamadasMapa } from '@/components/territorio/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { GRUPO_LABEL, TOM_STATUS, type AgenteEndemias, type OrdemDetalhe, type OrdemResumo } from './types';

const pct = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('pt-BR')}%`);

export function BarraProgresso({ p }: { p: ProgressoBloqueio }) {
  if (!p.imoveis) return <span className="text-xs text-slate-500">sem imóveis cadastrados</span>;
  const w = (n: number) => `${(n / p.imoveis) * 100}%`;
  return (
    <div className="min-w-[8rem]">
      <div className="flex h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden>
        <div className="bg-emerald-500" style={{ width: w(p.trabalhados) }} />
        <div className="bg-amber-400" style={{ width: w(p.pendentes) }} />
      </div>
      <div className="mt-0.5 text-xs text-slate-600">
        {p.trabalhados}/{p.imoveis} trabalhados · {p.pendentes} pendente(s)
      </div>
    </div>
  );
}

/** Ordens de bloqueio de transmissão: lista e acompanhamento (a vigilância e a gestão só leem). */
export function AbaOrdens({ podeGerir, podeCancelar, ordemInicial }: { podeGerir: boolean; podeCancelar: boolean; ordemInicial?: string | null }) {
  const [situacao, setSituacao] = useState<'ATIVAS' | 'ENCERRADAS' | 'TODAS'>('ATIVAS');
  const lista = useApi<OrdemResumo[]>(`/endemias/bloqueios?situacao=${situacao}`, [situacao]);
  const [aberta, setAberta] = useState<string | null>(ordemInicial ?? null);
  useRealtime('endemias:ordem', () => void lista.reload());

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader
          title="Ordens de bloqueio de transmissão"
          description="Abertas pelas notificações de dengue, chikungunya e Zika: casos a até duas vezes o raio e 7 dias entram na mesma ordem."
          actions={
            <Select aria-label="Situação" value={situacao} onChange={(e) => setSituacao(e.target.value as typeof situacao)}>
              <option value="ATIVAS">Ativas</option>
              <option value="ENCERRADAS">Concluídas e canceladas</option>
              <option value="TODAS">Todas</option>
            </Select>
          }
        />
        <CardBody className="p-0">
          {lista.loading && !lista.data && <Spinner className="p-4" />}
          {lista.error && <Alert tone="error">{lista.error}</Alert>}
          {lista.data && !lista.data.length && <EmptyState title="Nenhuma ordem nesta situação" />}
          {!!lista.data?.length && (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <tr>
                    <TH>Ordem</TH>
                    <TH>Situação</TH>
                    <TH>Aberta em</TH>
                    <TH>Casos</TH>
                    <TH>Quarteirões</TH>
                    <TH>Trabalho de campo</TH>
                    <TH>Pendência</TH>
                    <TH>Agentes</TH>
                  </tr>
                </THead>
                <TBody>
                  {lista.data.map((o) => (
                    <TR key={o.id} className="cursor-pointer" onClick={() => setAberta(o.id)}>
                      <TD className="font-medium">
                        <button type="button" className="text-brand-700 hover:underline" onClick={() => setAberta(o.id)}>
                          {o.numero}
                        </button>
                      </TD>
                      <TD>
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={TOM_STATUS[o.status]}>{o.statusLabel}</Badge>
                          {o.atrasada && <Badge tone="red">sem início</Badge>}
                          {o.conferirImovel && <Badge tone="amber">conferir imóvel</Badge>}
                        </div>
                      </TD>
                      <TD>{fmtDateTime(o.abertaEm)}</TD>
                      <TD>
                        {o.casos}
                        {o.casosDescartados ? <span className="text-xs text-slate-500"> (+{o.casosDescartados} descartado)</span> : null}
                        <div className="text-xs text-slate-500">{o.grupos.map((g) => GRUPO_LABEL[g] ?? g).join(', ')}</div>
                      </TD>
                      <TD>{o.quarteiroes}</TD>
                      <TD>
                        <BarraProgresso p={o.progresso} />
                      </TD>
                      <TD>
                        <span
                          className={
                            o.progresso.pendencia !== null && o.progresso.pendencia > ALERTA_PENDENCIA
                              ? 'font-medium text-red-700'
                              : o.progresso.pendencia !== null && o.progresso.pendencia >= META_PENDENCIA
                                ? 'text-amber-700'
                                : ''
                          }
                        >
                          {pct(o.progresso.pendencia)}
                        </span>
                      </TD>
                      <TD className="text-sm">{o.agentes.map((a) => a.nome).join(', ') || <span className="text-amber-700">ninguém designado</span>}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>
      {aberta && <OrdemDialog id={aberta} onClose={() => setAberta(null)} onMudou={() => void lista.reload()} podeGerir={podeGerir} podeCancelar={podeCancelar} />}
    </div>
  );
}

function OrdemDialog({ id, onClose, onMudou, podeGerir, podeCancelar }: { id: string; onClose: () => void; onMudou: () => void; podeGerir: boolean; podeCancelar: boolean }) {
  const toast = useToast();
  const d = useApi<OrdemDetalhe>(`/endemias/bloqueios/${id}`, [id]);
  const agentes = useApi<AgenteEndemias[]>(podeGerir ? '/endemias/agentes' : null);
  const [acao, setAcao] = useState<'concluir' | 'reabrir' | 'cancelar' | 'designar' | null>(null);
  const [texto, setTexto] = useState('');
  const [escolhidos, setEscolhidos] = useState<string[]>([]);
  const [enviando, setEnviando] = useState(false);
  useRealtime<{ id: string }>('endemias:ordem', (p) => (p.id === id ? void d.reload() : undefined));
  const o = d.data;

  const camadas = useMemo<CamadasMapa | null>(
    () =>
      o
        ? {
            localidades: [],
            bairros: [],
            quarteiroes: o.quarteiroes
              .filter((q) => q.geometria && q.centro)
              .map((q) => ({
                id: q.id,
                localityId: '',
                neighborhoodId: null,
                number: q.numero,
                geometry: q.geometria as CamadasMapa['quarteiroes'][number]['geometry'],
                centerLat: q.centro!.lat,
                centerLng: q.centro!.lng,
                areaM2: 0,
                imoveis: q.progresso.imoveis,
              })),
            imoveis: [],
            limitado: false,
          }
        : null,
    [o],
  );

  const enviar = async () => {
    if (!o || !acao) return;
    setEnviando(true);
    try {
      if (acao === 'designar') await api.post(`/endemias/bloqueios/${id}/agentes`, { agentes: escolhidos });
      else if (acao === 'concluir') await api.post(`/endemias/bloqueios/${id}/concluir`, { nota: texto.trim() || null });
      else await api.post(`/endemias/bloqueios/${id}/${acao}`, { motivo: texto.trim() });
      toast.success(acao === 'designar' ? 'Agentes designados' : acao === 'concluir' ? 'Ordem concluída' : acao === 'reabrir' ? 'Ordem reaberta' : 'Ordem cancelada');
      setAcao(null);
      setTexto('');
      await d.reload();
      onMudou();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setEnviando(false);
    }
  };

  const recalcular = async () => {
    try {
      await api.post(`/endemias/bloqueios/${id}/recalcular`, {});
      toast.success('Quarteirões recalculados');
      await d.reload();
      onMudou();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const ativa = o && ['AGUARDANDO_LOCALIZACAO', 'ABERTA', 'EM_CAMPO'].includes(o.status);
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title={o ? `Ordem de bloqueio ${o.numero}` : 'Ordem de bloqueio'}
      description={o ? `${o.statusLabel} · raio de ${o.raioM} m · aberta em ${fmtDateTime(o.abertaEm)}` : undefined}
      size="xl"
    >
      {d.loading && !o && <Spinner />}
      {d.error && <Alert tone="error">{d.error}</Alert>}
      {o && (
        <div className="space-y-4">
          {o.status === 'AGUARDANDO_LOCALIZACAO' && (
            <Alert tone="warn" title="Aguardando a localização da residência">
              A vigilância marca o imóvel do caso no mapa (Território, ou o GPS do ACS); a ordem recebe os quarteirões em até 5 minutos.
            </Alert>
          )}
          {o.conferirImovel && <Alert tone="warn">A posição de um caso é aproximada (face de quadra ou centro do quarteirão): confira o imóvel antes de fechar a lista de quarteirões.</Alert>}
          {o.atrasada && <Alert tone="error">Aberta há mais tempo que o prazo local sem trabalho de campo: o bloqueio deve começar o mais rápido possível.</Alert>}
          {ativa && o.casos.ativos === 0 && <Alert tone="warn">Todos os casos desta ordem foram descartados depois do início do trabalho de campo: conclua ou cancele.</Alert>}
          {o.status === 'ABERTA' && !o.quarteiroes.length && <Alert tone="warn">Nenhum quarteirão no raio: a malha do território não cobre a residência. Importe ou desenhe os quarteirões e recalcule.</Alert>}
          {o.unificadaEm && <Alert tone="info">Unificada a outra ordem: o caso foi localizado perto dela.</Alert>}
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <div className="text-xs text-slate-500">Casos ligados</div>
              <div className="text-lg font-semibold">{o.casos.ativos}</div>
              <div className="text-xs text-slate-500">
                {o.grupos.map((g) => GRUPO_LABEL[g] ?? g).join(', ')}
                {o.casos.semPosicao ? ` · ${o.casos.semPosicao} sem posição` : ''}
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <div className="text-xs text-slate-500">Período dos casos</div>
              <div className="font-medium">{o.casos.primeiraData ? `${fmtDate(o.casos.primeiraData)} a ${fmtDate(o.casos.ultimaData)}` : '—'}</div>
              <div className="text-xs text-slate-500">início dos sintomas ou data de conhecimento</div>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <div className="text-xs text-slate-500">Cobertura</div>
              <div className="text-lg font-semibold">{pct(o.progresso.cobertura)}</div>
              <BarraProgresso p={o.progresso} />
            </div>
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <div className="text-xs text-slate-500">Pendência</div>
              <div className={`text-lg font-semibold ${o.progresso.pendencia !== null && o.progresso.pendencia > ALERTA_PENDENCIA ? 'text-red-700' : ''}`}>{pct(o.progresso.pendencia)}</div>
              <div className="text-xs text-slate-500">meta do PNCD: abaixo de {META_PENDENCIA}%</div>
            </div>
          </div>
          {camadas && camadas.quarteiroes.length > 0 && (
            // Sem centro inicial: o mapa se ajusta aos quarteirões da ordem.
            <MapaTerritorio camadas={camadas} destaque={o.quarteiroes.filter((q) => q.ocorrencia).map((q) => q.id)} className="h-72" />
          )}
          <p className="text-xs text-slate-500">Em vermelho, o quarteirão de ocorrência. O endereço e o nome do caso ficam na notificação (sigilo, Lei 6.259/1975, art. 10).</p>
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <tr>
                  <TH>Quarteirão</TH>
                  <TH>Localidade · bairro</TH>
                  <TH>Distância</TH>
                  <TH>Imóveis</TH>
                  <TH>Progresso</TH>
                  <TH>Cobertura</TH>
                </tr>
              </THead>
              <TBody>
                {o.quarteiroes.map((q) => (
                  <TR key={q.id}>
                    <TD className="font-medium">
                      {q.numero} {q.ocorrencia && <Badge tone="red">início</Badge>}
                    </TD>
                    <TD>{[q.localidade, q.bairro].filter(Boolean).join(' · ') || '—'}</TD>
                    <TD>{Math.round(q.distanciaM)} m</TD>
                    <TD>{q.progresso.imoveis}</TD>
                    <TD>
                      <BarraProgresso p={q.progresso} />
                    </TD>
                    <TD>{pct(q.progresso.cobertura)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-slate-500">Agentes:</span>
            {o.agentes.length ? o.agentes.map((a) => <Badge key={a.id}>{a.nome}</Badge>) : <span className="text-amber-700">ninguém designado</span>}
          </div>
          {o.status === 'CONCLUIDA' && (
            <Alert tone="success">
              Concluída em {fmtDateTime(o.concluidaEm)} por {o.concluidaPor ?? '—'}
              {o.conclusao ? `: ${o.conclusao}` : ''}
            </Alert>
          )}
          {o.status === 'CANCELADA' && (
            <Alert tone="info">
              Cancelada em {fmtDateTime(o.canceladaEm)}
              {o.canceladaPor ? ` por ${o.canceladaPor}` : ''}: {o.motivoCancelamento}
            </Alert>
          )}
          {!!o.casos.descartados.length && <p className="text-xs text-slate-500">Casos que saíram da ordem: {o.casos.descartados.map((c) => `${c.motivo ?? '—'} (${fmtDate(c.em)})`).join('; ')}</p>}
          {podeGerir && (
            <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
              {ativa && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEscolhidos(o.agentes.map((a) => a.id));
                    setAcao('designar');
                  }}
                >
                  Designar agentes
                </Button>
              )}
              {(o.status === 'ABERTA' || o.status === 'EM_CAMPO') && <Button onClick={() => setAcao('concluir')}>Concluir</Button>}
              {o.status === 'CONCLUIDA' && (
                <Button variant="secondary" onClick={() => setAcao('reabrir')}>
                  Reabrir
                </Button>
              )}
              {ativa && (
                <Button variant="ghost" onClick={recalcular}>
                  Recalcular quarteirões
                </Button>
              )}
              {ativa && podeCancelar && (
                <Button variant="danger" onClick={() => setAcao('cancelar')}>
                  Cancelar ordem
                </Button>
              )}
            </div>
          )}
          {acao && (
            <div className="space-y-2 rounded-lg border border-slate-200 p-3">
              {acao === 'designar' ? (
                <fieldset className="space-y-1">
                  <legend className="text-sm font-medium">Agentes que executam a ordem</legend>
                  {agentes.data?.map((a) => (
                    <label key={a.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={escolhidos.includes(a.id)} onChange={(e) => setEscolhidos(e.target.checked ? [...escolhidos, a.id] : escolhidos.filter((x) => x !== a.id))} />
                      {a.nome} <span className="text-xs text-slate-500">{a.unidades.join(', ')}</span>
                    </label>
                  ))}
                </fieldset>
              ) : (
                <Field label={acao === 'concluir' ? 'Justificativa (obrigatória se ficou imóvel sem visita ou pendente)' : acao === 'reabrir' ? 'Motivo da reabertura' : 'Motivo do cancelamento'} htmlFor="ordem-texto">
                  <Textarea id="ordem-texto" rows={2} value={texto} onChange={(e) => setTexto(e.target.value)} />
                </Field>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setAcao(null)}>
                  Voltar
                </Button>
                <Button variant={acao === 'cancelar' ? 'danger' : 'primary'} onClick={enviar} loading={enviando}>
                  Confirmar
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
