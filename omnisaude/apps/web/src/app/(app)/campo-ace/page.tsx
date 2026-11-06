'use client';

import { SITUACAO_INFO, TIPO_IMOVEL, type OperacaoAce, type SituacaoVisita } from '@omnisaude/shared';
import { ChevronDown, ChevronRight, CloudOff, Plus, RefreshCw, Wifi } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ImovelForm } from '@/components/endemias/imovel-form';
import type { ImovelCampoView, PacoteCampo } from '@/components/endemias/types';
import { VisitaVetorialForm, type ContextoVisita } from '@/components/endemias/visita-vetorial-form';
import { TerritoryMap, type PontoMapa } from '@/components/acs/territory-map';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Tabs, TabPanel } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { filaAce, historicoAce, useFilaAce, type EnviadoAce } from '@/lib/ace-store';
import { comCache } from '@/lib/acs-store';
import { BASE_PATH, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { registrarServiceWorker, useOnline } from '@/lib/offline';
import { useSession } from '@/lib/session';

type Estado = { situacao: string; em: string; naFila?: boolean } | null;

const porNumero = (a: string, b: string) => a.localeCompare(b, 'pt-BR', { numeric: true });

function SituacaoBadge({ estado }: { estado: Estado }) {
  if (!estado) return <Badge tone="slate">Sem visita</Badge>;
  const info = SITUACAO_INFO[estado.situacao as SituacaoVisita];
  if (estado.naFila) return <Badge tone="blue">{info?.label ?? estado.situacao} · na fila</Badge>;
  return <Badge tone={info?.pendencia ? 'amber' : 'green'}>{`${info?.label ?? estado.situacao} em ${fmtDate(estado.em)}`}</Badge>;
}

/**
 * App de campo do agente de combate às endemias (VIG-3a): baixa a zona, as ordens de bloqueio designadas e o estoque de
 * larvicida; registra visitas e imóveis novos sem internet (fila no aparelho) e sincroniza quando a rede volta, sem
 * duplicar. O ponto e o agravo do caso não vêm para o aparelho: a ordem mostra o quarteirão de início.
 */
export default function CampoAcePage() {
  const session = useSession();
  const toast = useToast();
  const online = useOnline();
  const userId = session.me?.user.id ?? null;
  const fila = useFilaAce(userId);
  const [pacote, setPacote] = useState<{ data: PacoteCampo; deCache: boolean; savedAt: string | null } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [tab, setTab] = useState('roteiro');
  const [busca, setBusca] = useState('');
  const [abertos, setAbertos] = useState<Set<string>>(new Set());
  const [sincronizando, setSincronizando] = useState(false);
  const [enviados, setEnviados] = useState<EnviadoAce[]>([]);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [dialogo, setDialogo] = useState<{ tipo: 'visita'; contexto: ContextoVisita } | { tipo: 'imovel'; quarteirao: { id: string; numero: string } } | null>(null);
  const chave = `ace:${session.me?.context.unitId ?? ''}:${userId ?? ''}`;

  const carregar = useCallback(async () => {
    if (!userId) return;
    setCarregando(true);
    try {
      setPacote(await comCache<PacoteCampo>(`pacote:${chave}`, '/endemias/campo/pacote'));
      setErro(null);
    } catch (e) {
      setErro(errorMessage(e));
    } finally {
      setCarregando(false);
      setEnviados(await historicoAce.listar(userId));
    }
  }, [chave, userId]);

  const sincronizar = useCallback(
    async (silencioso = false) => {
      if (!userId || sincronizando) return;
      setSincronizando(true);
      try {
        const r = await filaAce.sincronizar(userId);
        if (r.offline) {
          if (!silencioso) toast.error('Sem conexão: as visitas ficam guardadas no aparelho e vão quando a rede voltar.');
          return;
        }
        if (r.enviados || r.duplicados || r.erros) {
          if (r.erros) toast.error(`${r.enviados} registro(s) enviado(s); ${r.erros} com erro (veja a aba Fila).`);
          else if (!r.enviados) toast.success(`Os ${r.duplicados} registro(s) já estavam no servidor (a resposta anterior não chegou): nada foi duplicado.`);
          else toast.success(`${r.enviados} registro(s) enviado(s)${r.duplicados ? `, ${r.duplicados} já estavam no servidor` : ''}${r.avisos ? ` · ${r.avisos} aviso(s) para a supervisão` : ''}.`);
          await carregar();
        } else if (!silencioso) toast.success('Nada pendente: tudo já está no servidor.');
      } finally {
        setSincronizando(false);
      }
    },
    [userId, sincronizando, toast, carregar],
  );

  useEffect(() => {
    registrarServiceWorker(BASE_PATH);
  }, []);
  useEffect(() => {
    void carregar();
  }, [carregar]);
  useEffect(() => {
    if (online && fila.pendentes > 0) void sincronizar(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  const registrar = async (op: OperacaoAce, rotulo: string) => {
    if (!userId) return;
    await filaAce.adicionar(op, userId, rotulo);
    toast.success(online ? 'Registrado; enviando…' : 'Registrado no aparelho: vai quando a rede voltar.');
    if (online) await sincronizar(true);
  };

  const p = pacote?.data ?? null;
  // Imóveis novos ainda na fila entram na lista do quarteirão e já podem ser visitados.
  const imoveis = useMemo<ImovelCampoView[]>(() => {
    const novos = fila.itens
      .filter((i) => i.op.tipo === 'IMOVEL')
      .map((i) => {
        const d = (i.op as Extract<OperacaoAce, { tipo: 'IMOVEL' }>).dados;
        return {
          id: i.clientId,
          quarteiraoId: d.blockId,
          sequencia: d.sequencia ?? null,
          endereco: [d.street, d.number, d.complement].filter(Boolean).join(', ') || d.observacoes || 'Imóvel novo',
          tipo: d.propertyType,
          tipoLabel: TIPO_IMOVEL[d.propertyType] ?? 'Outros',
          lat: d.latitude ?? null,
          lng: d.longitude ?? null,
          posicaoAproximada: d.latitude == null,
          precisaoLabel: d.latitude != null ? 'GPS em campo' : 'Sem posição',
          observacao: d.observacoes ?? null,
          noCiclo: null,
          pendente: true,
        };
      });
    return [...(p?.imoveis ?? []), ...novos];
  }, [p, fila.itens]);
  /** Última visita de cada imóvel ainda na fila (sobrepõe a situação baixada). */
  const naFila = useMemo(() => {
    const m = new Map<string, { situacao: string; em: string; ordemId: string | null }>();
    for (const i of fila.itens) {
      if (i.op.tipo !== 'VISITA_VETORIAL') continue;
      const alvo = i.op.householdId ?? i.op.householdClientId;
      if (alvo) m.set(alvo, { situacao: i.op.visita.situacao, em: i.op.registradoEm, ordemId: i.op.visita.ordemId ?? null });
    }
    return m;
  }, [fila.itens]);
  const usoNaFila = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of fila.itens) if (i.op.tipo === 'VISITA_VETORIAL') for (const t of i.op.visita.tratamentos ?? []) if (t.loteId) m.set(t.loteId, (m.get(t.loteId) ?? 0) + t.quantidade);
    return m;
  }, [fila.itens]);
  const quarteiraoDe = useMemo(() => new Map((p?.quarteiroes ?? []).map((q) => [q.id, q])), [p]);
  const ordemDoQuarteirao = useMemo(() => {
    const m = new Map<string, { id: string; numero: string }>();
    for (const o of p?.ordens ?? []) for (const q of o.quarteiroes) if (!m.has(q.id)) m.set(q.id, { id: o.id, numero: o.numero });
    return m;
  }, [p]);

  const estadoNoCiclo = (i: ImovelCampoView): Estado => {
    const f = naFila.get(i.id);
    return f ? { ...f, naFila: true } : i.noCiclo;
  };
  const estadoNaOrdem = (ordem: PacoteCampo['ordens'][number], i: ImovelCampoView): Estado => {
    const f = naFila.get(i.id);
    if (f && f.ordemId === ordem.id) return { ...f, naFila: true };
    return ordem.visitados[i.id] ?? null;
  };
  const filtra = (i: ImovelCampoView) => !busca.trim() || `${i.endereco} ${i.sequencia ?? ''} ${i.tipoLabel}`.toLowerCase().includes(busca.trim().toLowerCase());
  const alternar = (k: string) => setAbertos((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k])));
  const visitar = (i: ImovelCampoView, ordem: { id: string; numero: string } | null) =>
    setDialogo({
      tipo: 'visita',
      contexto: { imovel: i, ordem: ordem ?? (i.quarteiraoId ? (ordemDoQuarteirao.get(i.quarteiraoId) ?? null) : null), quarteirao: i.quarteiraoId ? (quarteiraoDe.get(i.quarteiraoId)?.numero ?? null) : null },
    });

  const listaImoveis = (doQuarteirao: ImovelCampoView[], estado: (i: ImovelCampoView) => Estado, ordem: { id: string; numero: string } | null) => (
    <ul className="divide-y divide-slate-100">
      {doQuarteirao
        .filter(filtra)
        .sort((a, b) => porNumero(a.sequencia ?? '~', b.sequencia ?? '~') || a.endereco.localeCompare(b.endereco))
        .map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <div className="font-medium">
                {i.sequencia ? <span className="mr-2 rounded bg-slate-100 px-1.5 text-xs">{i.sequencia}</span> : null}
                {i.endereco}
              </div>
              <div className="text-xs text-slate-500">
                {i.tipoLabel}
                {i.pendente ? ' · cadastrado no aparelho, ainda não enviado' : ''}
                {i.posicaoAproximada ? ' · posição a confirmar' : ''}
                {i.observacao ? ` · ${i.observacao}` : ''}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <SituacaoBadge estado={estado(i)} />
              <Button size="sm" onClick={() => visitar(i, ordem)}>
                Visitar
              </Button>
            </div>
          </li>
        ))}
    </ul>
  );

  if (!session.can('endemias.campo')) return <Alert tone="warn">Seu papel não tem acesso ao app de campo do agente de endemias.</Alert>;

  const zonaIds = new Set((p?.zonas ?? []).flatMap((z) => z.quarteiroes));
  const blocosZona = (p?.quarteiroes ?? []).filter((q) => zonaIds.has(q.id)).sort((a, b) => porNumero(a.numero, b.numero));
  const doCiclo = imoveis.filter((i) => i.quarteiraoId && zonaIds.has(i.quarteiraoId));
  const trabalhadosCiclo = doCiclo.filter((i) => estadoNoCiclo(i)?.situacao === 'TRABALHADO').length;
  const pendentesCiclo = doCiclo.filter((i) => {
    const e = estadoNoCiclo(i);
    return e && SITUACAO_INFO[e.situacao as SituacaoVisita]?.pendencia;
  }).length;
  const pontos: PontoMapa[] = imoveis
    .filter((i) => i.lat != null && i.lng != null)
    .map((i) => {
      const e = estadoNoCiclo(i);
      return {
        id: i.id,
        latitude: i.lat!,
        longitude: i.lng!,
        titulo: `${i.sequencia ? `${i.sequencia} · ` : ''}${i.endereco}`,
        subtitulo: `${i.tipoLabel} · ${e ? (SITUACAO_INFO[e.situacao as SituacaoVisita]?.label ?? e.situacao) : 'sem visita no ciclo'}`,
        tom: !e ? 'slate' : e.naFila ? 'blue' : SITUACAO_INFO[e.situacao as SituacaoVisita]?.pendencia ? 'amber' : 'green',
      };
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Campo do agente de endemias"
        description={p ? `Ciclo ${p.ciclo.ciclo}/${p.ciclo.ano} (${fmtDate(p.ciclo.inicio)} a ${fmtDate(p.ciclo.fim)})` : 'Zona, ordens de bloqueio e larvicida para trabalhar sem internet'}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={online ? 'green' : 'amber'}>
              {online ? <Wifi className="h-3.5 w-3.5" /> : <CloudOff className="h-3.5 w-3.5" />} {online ? 'Com rede' : 'Sem rede'}
            </Badge>
            <Button variant="secondary" onClick={() => void sincronizar()} loading={sincronizando}>
              <RefreshCw className="mr-1 h-4 w-4" /> Sincronizar{fila.pendentes ? ` (${fila.pendentes})` : ''}
            </Button>
          </div>
        }
      />
      {pacote?.deCache && <Alert tone="warn">Sem conexão com o servidor: trabalhando com o pacote baixado em {fmtDateTime(pacote.savedAt)}. As visitas ficam no aparelho até a rede voltar.</Alert>}
      {fila.deOutros > 0 && <Alert tone="warn">Há {fila.deOutros} registro(s) de outro usuário neste aparelho: só são enviados quando ele entrar.</Alert>}
      {erro && !p && <Alert tone="error">{erro}</Alert>}
      {carregando && !p && <Spinner />}
      {p && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Imóveis da zona" value={doCiclo.length} />
            <Stat label="Trabalhados no ciclo" value={trabalhadosCiclo} tone="good" />
            <Stat label="Pendentes no ciclo" value={pendentesCiclo} tone={pendentesCiclo ? 'warn' : 'default'} hint="Fechados, recusados, abandonados" />
            <Stat label="Ordens de bloqueio" value={p.ordens.length} tone={p.ordens.length ? 'bad' : 'default'} />
          </div>
          <Tabs
            value={tab}
            onValueChange={setTab}
            tabs={[
              { value: 'roteiro', label: 'Roteiro da zona' },
              { value: 'bloqueios', label: `Bloqueios${p.ordens.length ? ` (${p.ordens.length})` : ''}` },
              { value: 'mapa', label: 'Mapa' },
              { value: 'fila', label: `Fila${fila.itens.length ? ` (${fila.itens.length})` : ''}` },
              { value: 'estoque', label: 'Larvicida' },
            ]}
          >
            <TabPanel value="roteiro" className="space-y-3 pt-3">
              <Input placeholder="Buscar endereço, sequência ou tipo" value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar imóvel" />
              {!blocosZona.length && <EmptyState title="Nenhum quarteirão na sua zona" description="A supervisão monta a zona em Endemias > Zonas." />}
              {blocosZona.map((q) => {
                const doBloco = imoveis.filter((i) => i.quarteiraoId === q.id);
                const feitos = doBloco.filter((i) => estadoNoCiclo(i)?.situacao === 'TRABALHADO').length;
                const k = `z:${q.id}`;
                return (
                  <Card key={q.id}>
                    <button type="button" className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left" onClick={() => alternar(k)} aria-expanded={abertos.has(k)}>
                      <span className="flex items-center gap-2 font-medium">
                        {abertos.has(k) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        Quarteirão {q.numero}
                        <span className="text-sm font-normal text-slate-500">{[q.localidade, q.bairro].filter(Boolean).join(' · ')}</span>
                        {ordemDoQuarteirao.has(q.id) && <Badge tone="red">Bloqueio {ordemDoQuarteirao.get(q.id)!.numero}</Badge>}
                      </span>
                      <span className="text-sm text-slate-600">
                        {feitos}/{doBloco.length} trabalhados
                      </span>
                    </button>
                    {abertos.has(k) && (
                      <CardBody className="pt-0">
                        {doBloco.length ? listaImoveis(doBloco, estadoNoCiclo, null) : <p className="text-sm text-slate-500">Nenhum imóvel cadastrado neste quarteirão.</p>}
                        <Button size="sm" variant="ghost" className="mt-2" onClick={() => setDialogo({ tipo: 'imovel', quarteirao: { id: q.id, numero: q.numero } })}>
                          <Plus className="mr-1 h-4 w-4" /> Imóvel novo neste quarteirão
                        </Button>
                      </CardBody>
                    )}
                  </Card>
                );
              })}
            </TabPanel>

            <TabPanel value="bloqueios" className="space-y-3 pt-3">
              {!p.ordens.length && <EmptyState title="Nenhuma ordem de bloqueio designada" description="As ordens abertas pelas notificações de dengue, chikungunya e Zika aparecem aqui." />}
              {p.ordens.map((o) => {
                const quarteiroes = [...o.quarteiroes].sort((a, b) => Number(b.ocorrencia) - Number(a.ocorrencia) || porNumero(quarteiraoDe.get(a.id)?.numero ?? '', quarteiraoDe.get(b.id)?.numero ?? ''));
                const todos = imoveis.filter((i) => i.quarteiraoId && o.quarteiroes.some((q) => q.id === i.quarteiraoId));
                const feitos = todos.filter((i) => estadoNaOrdem(o, i)?.situacao === 'TRABALHADO').length;
                return (
                  <Card key={o.id}>
                    <CardHeader
                      title={`Bloqueio ${o.numero}`}
                      description={`Aberto em ${fmtDateTime(o.abertaEm)} · raio de ${o.raioM} m · ${o.quarteiroes.length} quarteirões · ${feitos}/${todos.length} imóveis trabalhados`}
                      actions={<Badge tone={o.status === 'EM_CAMPO' ? 'green' : 'blue'}>{o.status === 'EM_CAMPO' ? 'Em campo' : 'Aberta'}</Badge>}
                    />
                    <CardBody className="space-y-2">
                      {o.conferirImovel && <Alert tone="warn">A posição de um caso é aproximada (face de quadra ou centro do quarteirão): confira o quarteirão de início com a supervisão.</Alert>}
                      <p className="text-sm text-slate-600">Comece pelo quarteirão de ocorrência e siga pelos vizinhos: inspeção, eliminação dos criadouros e, se indicado, nebulização.</p>
                      {quarteiroes.map((qq) => {
                        const q = quarteiraoDe.get(qq.id);
                        const doBloco = imoveis.filter((i) => i.quarteiraoId === qq.id);
                        const k = `o:${o.id}:${qq.id}`;
                        return (
                          <div key={qq.id} className="rounded-lg border border-slate-200">
                            <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left" onClick={() => alternar(k)} aria-expanded={abertos.has(k)}>
                              <span className="flex items-center gap-2 text-sm font-medium">
                                {abertos.has(k) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                Quarteirão {q?.numero ?? '?'}
                                {qq.ocorrencia && <Badge tone="red">início</Badge>}
                              </span>
                              <span className="text-xs text-slate-600">
                                {doBloco.filter((i) => estadoNaOrdem(o, i)?.situacao === 'TRABALHADO').length}/{doBloco.length}
                              </span>
                            </button>
                            {abertos.has(k) && (
                              <div className="px-3 pb-2">
                                {doBloco.length ? listaImoveis(doBloco, (i) => estadoNaOrdem(o, i), { id: o.id, numero: o.numero }) : <p className="text-sm text-slate-500">Nenhum imóvel cadastrado.</p>}
                                <Button size="sm" variant="ghost" className="mt-1" onClick={() => setDialogo({ tipo: 'imovel', quarteirao: { id: qq.id, numero: q?.numero ?? '?' } })}>
                                  <Plus className="mr-1 h-4 w-4" /> Imóvel novo
                                </Button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </CardBody>
                  </Card>
                );
              })}
            </TabPanel>

            <TabPanel value="mapa" className="pt-3">
              <Card>
                <CardBody className="space-y-2">
                  <p className="text-xs text-slate-500">
                    Verde: trabalhado no ciclo · amarelo: pendente · azul: na fila do aparelho · cinza: sem visita. Sem internet, o fundo do mapa não carrega, mas os pontos continuam.
                  </p>
                  <TerritoryMap pontos={pontos} selecionado={selecionado} onSelect={(id) => setSelecionado(id)} className="h-[28rem]" />
                  {selecionado &&
                    (() => {
                      const i = imoveis.find((x) => x.id === selecionado);
                      return i ? (
                        <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 p-2 text-sm">
                          <span>
                            {i.endereco} · {i.tipoLabel}
                          </span>
                          <Button size="sm" onClick={() => visitar(i, null)}>
                            Visitar
                          </Button>
                        </div>
                      ) : null;
                    })()}
                </CardBody>
              </Card>
            </TabPanel>

            <TabPanel value="fila" className="space-y-3 pt-3">
              <Card>
                <CardHeader title="No aparelho" description="Registros ainda não aceitos pelo servidor" />
                <CardBody>
                  {!fila.itens.length && <p className="text-sm text-slate-500">Nada pendente.</p>}
                  <ul className="divide-y divide-slate-100">
                    {fila.itens.map((i) => (
                      <li key={i.clientId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <div>
                          <div className="text-sm font-medium">{i.rotulo}</div>
                          <div className="text-xs text-slate-500">registrado em {fmtDateTime(i.op.registradoEm)}</div>
                          {i.erro && <div className="text-xs text-red-700">{i.erro}</div>}
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge tone={i.status === 'ERRO' ? 'red' : 'blue'}>{i.status === 'ERRO' ? 'Erro' : 'Pendente'}</Badge>
                          {i.status === 'ERRO' && (
                            <Button size="sm" variant="secondary" onClick={() => void filaAce.tentarDeNovo(i.clientId).then(() => sincronizar())}>
                              Tentar de novo
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => (confirm('Descartar este registro do aparelho? Ele não será enviado.') ? void filaAce.remover(i.clientId) : undefined)}>
                            Descartar
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Enviados" description="Aceitos pelo servidor neste aparelho (os últimos 300)" />
                <CardBody>
                  {!enviados.length && <p className="text-sm text-slate-500">Nenhum envio ainda.</p>}
                  <ul className="divide-y divide-slate-100">
                    {enviados.slice(0, 60).map((e) => (
                      <li key={e.clientId} className="py-2 text-sm">
                        <div>{e.rotulo}</div>
                        <div className="text-xs text-slate-500">enviado em {fmtDateTime(e.em)}</div>
                        {e.avisos?.map((a) => (
                          <div key={a} className="text-xs text-amber-700">
                            {a}
                          </div>
                        ))}
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            </TabPanel>

            <TabPanel value="estoque" className="pt-3">
              <Card>
                <CardHeader title="Larvicida no depósito de endemias" description={`Saldo do pacote baixado, menos o uso que ainda está na fila. A baixa oficial é feita ao sincronizar.`} />
                <CardBody>
                  {!p.estoque.length && <p className="text-sm text-slate-500">Sem larvicida com saldo no depósito da sua unidade.</p>}
                  <ul className="divide-y divide-slate-100">
                    {p.estoque.map((l) => (
                      <li key={l.loteId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <div>
                          <div className="font-medium">{l.produto}</div>
                          <div className="text-xs text-slate-500">
                            Lote {l.lote} · validade {fmtDate(l.validade)} · {l.deposito}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-medium">
                            {(Math.round((l.saldo - (usoNaFila.get(l.loteId) ?? 0)) * 1000) / 1000).toLocaleString('pt-BR')} {l.unidade}
                          </div>
                          {l.vencido && <Badge tone="red">vencido</Badge>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            </TabPanel>
          </Tabs>
        </>
      )}
      {userId && (
        <VisitaVetorialForm
          aberto={dialogo?.tipo === 'visita'}
          onClose={() => setDialogo(null)}
          contexto={dialogo?.tipo === 'visita' ? dialogo.contexto : null}
          estoque={p?.estoque ?? []}
          userId={userId}
          usoNaFila={usoNaFila}
          onSalvar={registrar}
        />
      )}
      <ImovelForm aberto={dialogo?.tipo === 'imovel'} onClose={() => setDialogo(null)} quarteirao={dialogo?.tipo === 'imovel' ? dialogo.quarteirao : null} onSalvar={registrar} />
    </div>
  );
}
