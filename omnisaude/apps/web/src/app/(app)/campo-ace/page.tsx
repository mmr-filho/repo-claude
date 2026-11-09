'use client';

import { SITUACAO_INFO, type OperacaoAce, type SituacaoVisita } from '@omnisaude/shared';
import { ChevronDown, ChevronRight, CloudOff, Plus, RefreshCw, Wifi } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  acoesDoItem,
  aplicarAceitosNoPacote,
  dependentesDoImovel,
  imoveisDaFila,
  ordemDoContexto,
  ordemMaisRecente,
  ordensDoQuarteirao,
  usoDaFila,
  visitasNaFila,
  type FalhaSync,
  type OrdemDoContexto,
} from '@/lib/ace-campo';
import { filaAce, historicoAce, pacoteAce, useFilaAce, type ContextoAce, type EnviadoAce, type ItemFilaAce, type PacoteGuardado, type ResumoSyncAce } from '@/lib/ace-store';
import { errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { estaOnline, useOnline } from '@/lib/offline';
import { useSession } from '@/lib/session';

type Estado = { situacao: string; em: string; naFila?: boolean } | null;
type Dialogo = { tipo: 'visita'; contexto: ContextoVisita; corrigir?: ItemFilaAce } | { tipo: 'imovel'; quarteirao: { id: string; numero: string }; corrigir?: ItemFilaAce };

/**
 * Download automático do pacote (ao abrir a tela e depois de um envio) só quando o guardado tem mais que isto: o pacote
 * é a zona inteira, e baixá-lo a cada visita gasta dados móveis. "Sincronizar" baixa sempre.
 */
const INTERVALO_PACOTE_MS = 30 * 60_000;

const porNumero = (a: string, b: string) => a.localeCompare(b, 'pt-BR', { numeric: true });

const restantes = (n: number) => (n ? `: ${n} registro(s) continuam no aparelho` : '');
const MENSAGEM_FALHA: Record<FalhaSync, (n: number, mensagem: string | null) => string> = {
  rede: (n) => (n ? `Sem conexão com o servidor: ${n} registro(s) continuam no aparelho e vão quando a rede voltar.` : 'Sem conexão com o servidor.'),
  servidor: (n) => `Servidor indisponível${restantes(n)}. Tente de novo em alguns minutos.`,
  sessao: (n) => `Sessão encerrada: entre de novo para enviar${n ? ` os ${n} registro(s) do aparelho` : ''}.`,
  limite: (n) => `Muitas tentativas seguidas${restantes(n)}. Tente de novo em alguns minutos.`,
  permissao: (n, m) => `${m ?? 'Sem permissão para enviar o trabalho de campo nesta lotação'}${restantes(n)}.`,
  aparelho: (_n, m) => m ?? 'Não foi possível ler a fila do aparelho: feche as outras abas do OmniSaúde e tente de novo.',
};

function SituacaoBadge({ estado }: { estado: Estado }) {
  if (!estado) return <Badge tone="slate">Sem visita</Badge>;
  const info = SITUACAO_INFO[estado.situacao as SituacaoVisita];
  if (estado.naFila) return <Badge tone="blue">{info?.label ?? estado.situacao} · na fila</Badge>;
  return <Badge tone={info?.pendencia ? 'amber' : 'green'}>{`${info?.label ?? estado.situacao} em ${fmtDate(estado.em)}`}</Badge>;
}

/**
 * App de campo do agente de combate às endemias (VIG-3a): baixa a zona, as ordens de bloqueio designadas e o estoque de
 * larvicida; registra visitas e imóveis novos sem internet (fila no aparelho) e sincroniza quando a rede volta, sem
 * duplicar. O que o servidor aceita é aplicado no pacote do aparelho, que só é baixado de novo depois de um envio que
 * foi até o fim. O ponto e o agravo do caso não vêm para o aparelho: a ordem mostra o quarteirão de início.
 */
export default function CampoAcePage() {
  const session = useSession();
  const toast = useToast();
  const online = useOnline();
  const podeCampo = session.can('endemias.campo');
  const userId = session.me?.user.id ?? null;
  const unitId = session.me?.context.unitId ?? null;
  const ctx = useMemo<ContextoAce | null>(() => (userId && podeCampo ? { userId, unitId } : null), [userId, unitId, podeCampo]);
  const fila = useFilaAce(userId, unitId);
  const [pacote, setPacote] = useState<PacoteGuardado | null>(null);
  const [falhaPacote, setFalhaPacote] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [tab, setTab] = useState('roteiro');
  const [busca, setBusca] = useState('');
  const [abertos, setAbertos] = useState<Set<string>>(new Set());
  const [sincronizando, setSincronizando] = useState(false);
  const [enviados, setEnviados] = useState<EnviadoAce[]>([]);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [dialogo, setDialogo] = useState<Dialogo | null>(null);
  /** Muda a cada troca de usuário ou de lotação: resposta do contexto anterior é descartada. */
  const geracao = useRef(0);
  const emAndamento = useRef(0);
  /** Pacote da tela, para saber a idade dele dentro das funções assíncronas. */
  const pacoteAtual = useRef<PacoteGuardado | null>(null);
  useEffect(() => {
    pacoteAtual.current = pacote;
  }, [pacote]);
  /** Registros deste usuário feitos em outra lotação (não vão com a sessão ativa). */
  const deOutraLotacao = useRef(0);
  useEffect(() => {
    deOutraLotacao.current = fila.deOutraLotacao.length;
  }, [fila.deOutraLotacao.length]);

  /** Baixa o pacote; na falha mantém o que a tela tem (nunca volta a uma cópia mais velha) e devolve a mensagem. */
  const baixarPacote = useCallback(async (c: ContextoAce, g: number): Promise<string | null> => {
    try {
      const novo = await pacoteAce.baixar(c);
      if (g === geracao.current) {
        pacoteAtual.current = novo;
        setPacote(novo);
        setFalhaPacote(null);
      }
      return null;
    } catch (e) {
      const msg = errorMessage(e);
      if (g === geracao.current) setFalhaPacote(msg);
      return msg;
    }
  }, []);

  const avisarResumo = useCallback(
    (r: ResumoSyncAce, silencioso: boolean) => {
      const aceitos = r.enviados + r.duplicados;
      if (r.falha && (!silencioso || r.falha !== 'rede')) toast.error(MENSAGEM_FALHA[r.falha](r.restantes, r.mensagem));
      if (r.erros) toast.error(`${aceitos} registro(s) enviado(s); ${r.erros} com erro (veja a aba Fila).`);
      else if (r.adiados) toast.info(`${aceitos} registro(s) enviado(s); ${r.adiados} ficaram para o próximo envio (falha passageira no servidor).`);
      else if (aceitos && !r.enviados) toast.success(`Os ${r.duplicados} registro(s) já estavam no servidor (a resposta anterior não chegou): nada foi duplicado.`);
      else if (aceitos)
        toast.success(`${r.enviados} registro(s) enviado(s)${r.duplicados ? `, ${r.duplicados} já estavam no servidor` : ''}${r.avisos ? ` · ${r.avisos} aviso(s) para a supervisão (veja Enviados)` : ''}.`);
    },
    [toast],
  );

  /**
   * Envia a fila desta lotação e aplica na tela o que foi aceito. O pacote só é baixado se o envio foi até o fim (senão o
   * efeito de uma operação gravada sem resposta seria contado duas vezes): `sempre` (botão) ou `se-velho` (automático).
   */
  const sincronizar = useCallback(
    async (opcoes: { silencioso?: boolean; baixar?: 'sempre' | 'se-velho' } = {}): Promise<{ resumo: ResumoSyncAce; erroPacote: string | null } | null> => {
      if (!ctx) return null;
      const g = geracao.current;
      emAndamento.current += 1;
      setSincronizando(true);
      try {
        const r = await filaAce.sincronizar(ctx);
        if (g !== geracao.current) return null;
        if (r.aceitos.length) {
          setPacote((p) => (p ? { ...p, data: aplicarAceitosNoPacote(p.data, r.aceitos) } : p));
          const historico = await historicoAce.listar(ctx.userId).catch(() => null);
          if (historico && g === geracao.current) setEnviados(historico);
        }
        avisarResumo(r, !!opcoes.silencioso);
        if (r.falha) return { resumo: r, erroPacote: null };
        const guardado = pacoteAtual.current;
        const velho = !guardado || Date.now() - Date.parse(guardado.savedAt) > INTERVALO_PACOTE_MS;
        let erroPacote: string | null = null;
        if (opcoes.baixar === 'sempre' || (opcoes.baixar === 'se-velho' && velho)) erroPacote = await baixarPacote(ctx, g);
        if (!opcoes.silencioso && r.pendentes === 0 && g === geracao.current) {
          const nada = deOutraLotacao.current ? `Nada pendente nesta lotação (${deOutraLotacao.current} registro(s) de outra lotação esperam a troca de lotação)` : 'Nada pendente: tudo já está no servidor';
          if (opcoes.baixar !== 'sempre') toast.success(`${nada}.`);
          else if (erroPacote) toast.error(`${nada}, mas o pacote não foi atualizado: ${erroPacote}`);
          else toast.success(`${nada}; pacote atualizado.`);
        } else if (!opcoes.silencioso && erroPacote) toast.error(`O pacote não foi atualizado: ${erroPacote}`);
        return { resumo: r, erroPacote };
      } finally {
        emAndamento.current -= 1;
        setSincronizando(emAndamento.current > 0);
      }
    },
    [ctx, avisarResumo, baixarPacote, toast],
  );

  // Ao abrir (ou trocar de lotação): o pacote guardado na hora; com rede, primeiro a fila (o pacote baixado depois já vem
  // com ela) e o pacote novo se o guardado estiver velho.
  useEffect(() => {
    if (!ctx) return;
    const g = ++geracao.current;
    pacoteAtual.current = null;
    setPacote(null);
    setFalhaPacote(null);
    setCarregando(true);
    setEnviados([]);
    void (async () => {
      const guardado = await pacoteAce.guardado(ctx).catch(() => null);
      if (g !== geracao.current) return;
      if (guardado) {
        pacoteAtual.current = pacoteAtual.current ?? guardado;
        setPacote((p) => p ?? guardado);
      }
      const historico = await historicoAce.listar(ctx.userId).catch(() => []);
      if (g !== geracao.current) return;
      setEnviados(historico);
      let motivo: string | null = null;
      if (estaOnline()) {
        const r = await sincronizar({ silencioso: true, baixar: guardado ? 'se-velho' : 'sempre' });
        if (r?.resumo.falha) motivo = MENSAGEM_FALHA[r.resumo.falha](r.resumo.restantes, r.resumo.mensagem);
        else motivo = r?.erroPacote ?? null;
      } else motivo = 'Sem conexão';
      if (g !== geracao.current) return;
      setCarregando(false);
      if (!pacoteAtual.current)
        setFalhaPacote(motivo === 'Sem conexão' ? 'Sem conexão e sem pacote guardado neste aparelho: abra o app com internet para baixar a zona.' : (motivo ?? 'Não foi possível baixar o pacote.'));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  // A rede voltou: envia o que ficou no aparelho.
  const estavaOnline = useRef(online);
  useEffect(() => {
    const voltou = online && !estavaOnline.current;
    estavaOnline.current = online;
    if (voltou && fila.pendentes > 0) void sincronizar({ silencioso: true, baixar: 'se-velho' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  /** Guarda no aparelho (a falha sobe para o formulário, que fica aberto) e envia em segundo plano. */
  const registrar = async (op: OperacaoAce, rotulo: string, extras?: { ultimoTubito?: number | null }) => {
    if (!ctx) throw new Error('Sessão sem usuário: entre de novo');
    await filaAce.adicionar(op, ctx, rotulo, extras);
    const comRede = estaOnline();
    toast.success(comRede ? 'Registrado; enviando…' : 'Registrado no aparelho: vai quando a rede voltar.');
    if (comRede) void sincronizar({ silencioso: true, baixar: 'se-velho' });
  };
  /** Regrava o registro com erro, com o mesmo clientId, como pendente. */
  const regravar = (item: ItemFilaAce) => async (op: OperacaoAce, rotulo: string, extras?: { ultimoTubito?: number | null }) => {
    await filaAce.corrigir(item.clientId, op, rotulo, extras);
    const comRede = estaOnline();
    toast.success(comRede ? 'Corrigido; enviando…' : 'Corrigido no aparelho: vai quando a rede voltar.');
    if (comRede) void sincronizar({ silencioso: true });
  };

  const p = pacote?.data ?? null;
  const itensDaLotacao = fila.daLotacao;
  // Imóveis novos ainda na fila entram na lista do quarteirão e já podem ser visitados (o com a versão anterior gravada
  // no servidor, não: o pacote já tem o imóvel).
  const imoveis = useMemo<ImovelCampoView[]>(() => [...(p?.imoveis ?? []), ...imoveisDaFila(itensDaLotacao)], [p, itensDaLotacao]);
  /** Última visita de cada imóvel ainda na fila (sobrepõe a situação baixada). */
  const naFila = useMemo(() => visitasNaFila(itensDaLotacao), [itensDaLotacao]);
  const usoNaFila = useMemo(() => usoDaFila(itensDaLotacao), [itensDaLotacao]);
  const quarteiraoDe = useMemo(() => new Map((p?.quarteiroes ?? []).map((q) => [q.id, q])), [p]);
  /** Ordem do quarteirão no roteiro: a mais recente que o contém (a mesma que a visita aberta pelo roteiro leva). */
  const ordemDoQuarteirao = useMemo(() => {
    const m = new Map<string, OrdemDoContexto>();
    for (const o of p?.ordens ?? [])
      for (const q of o.quarteiroes)
        if (!m.has(q.id)) {
          const r = ordemMaisRecente(p!.ordens, q.id);
          if (r) m.set(q.id, r);
        }
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
  /**
   * Abre a visita pela lista da ordem (`ordemId`) ou pelo roteiro e pelo mapa (a ordem do quarteirão), com a abertura e as
   * ordens do quarteirão (a visita de dia anterior ao da abertura vai para a já aberta no dia dela).
   */
  const visitar = (i: ImovelCampoView, ordemId: string | null) =>
    setDialogo({
      tipo: 'visita',
      contexto: {
        imovel: i,
        ordem: ordemDoContexto(p?.ordens, i.quarteiraoId, ordemId),
        ordensDoQuarteirao: ordensDoQuarteirao(p?.ordens, i.quarteiraoId),
        quarteirao: i.quarteiraoId ? (quarteiraoDe.get(i.quarteiraoId)?.numero ?? null) : null,
      },
    });
  const nomeDaUnidade = (id: string | null | undefined) => session.me?.assignments.find((a) => a.unitId === id)?.unitName ?? 'outra unidade';

  /** Reabre o formulário com os dados do registro recusado. */
  const corrigir = (item: ItemFilaAce) => {
    const op = item.op;
    if (op.tipo === 'IMOVEL') {
      setDialogo({ tipo: 'imovel', quarteirao: { id: op.dados.blockId, numero: quarteiraoDe.get(op.dados.blockId)?.numero ?? '?' }, corrigir: item });
      return;
    }
    const alvo = op.householdId ?? op.householdClientId ?? '';
    const imovel: ImovelCampoView = imoveis.find((x) => x.id === alvo) ?? {
      id: alvo,
      quarteiraoId: null,
      sequencia: null,
      endereco: item.rotulo,
      tipo: '01',
      tipoLabel: 'Imóvel',
      lat: null,
      lng: null,
      posicaoAproximada: false,
      precisaoLabel: 'Sem posição',
      observacao: null,
      noCiclo: null,
      pendente: !op.householdId,
    };
    // A visita gravada sem a ordem (pela data ou pela atividade) abre com a do quarteirão: corrigida, volta para ela.
    setDialogo({
      tipo: 'visita',
      contexto: {
        imovel,
        ordem: ordemDoContexto(p?.ordens, imovel.quarteiraoId, op.visita.ordemId),
        ordensDoQuarteirao: ordensDoQuarteirao(p?.ordens, imovel.quarteiraoId),
        quarteirao: imovel.quarteiraoId ? (quarteiraoDe.get(imovel.quarteiraoId)?.numero ?? null) : null,
      },
      corrigir: item,
    });
  };

  /**
   * Descarta o registro; o imóvel novo leva junto as visitas registradas nele (sem ele, elas não têm como ser enviadas),
   * menos o com a versão anterior gravada: o servidor já tem o imóvel, e as visitas vão.
   */
  const descartar = (item: ItemFilaAce) => {
    const visitas = item.op.tipo === 'IMOVEL' ? dependentesDoImovel(fila.itens, item) : [];
    const pergunta = visitas.length
      ? `Descartar este imóvel novo e as ${visitas.length} visita(s) registradas nele? Sem o imóvel, as visitas não têm como ser enviadas. Nada disso será enviado.`
      : 'Descartar este registro do aparelho? Ele não será enviado.';
    if (!confirm(pergunta)) return;
    filaAce.remover([item.clientId, ...visitas.map((v) => v.clientId)]).catch((e) => toast.error(errorMessage(e)));
  };

  const listaImoveis = (doQuarteirao: ImovelCampoView[], estado: (i: ImovelCampoView) => Estado, ordemId: string | null) => (
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
              {i.erroNaFila && <div className="text-xs text-red-700">Recusado no envio: {i.erroNaFila} (corrija na aba Fila)</div>}
            </div>
            <div className="flex items-center gap-2">
              <SituacaoBadge estado={estado(i)} />
              <Button size="sm" onClick={() => visitar(i, ordemId)}>
                Visitar
              </Button>
            </div>
          </li>
        ))}
    </ul>
  );

  if (!podeCampo) return <Alert tone="warn">Seu papel não tem acesso ao app de campo do agente de endemias.</Alert>;

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
  const outrasUnidades = [...new Set(fila.deOutraLotacao.map((i) => nomeDaUnidade(i.unitId)))].join(', ');
  const semSaldo = (p?.produtos ?? []).filter((x) => !p?.estoque.some((l) => l.produtoId === x.id));
  const corrigindo = dialogo?.corrigir;

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
            <Button variant="secondary" onClick={() => void sincronizar({ baixar: 'sempre' })} loading={sincronizando}>
              <RefreshCw className="mr-1 h-4 w-4" /> Sincronizar{fila.pendentes ? ` (${fila.pendentes})` : ''}
            </Button>
          </div>
        }
      />
      {fila.erroAparelho && <Alert tone="error">Não foi possível ler a fila do aparelho: feche as outras abas do OmniSaúde e recarregue a página.</Alert>}
      {pacote && (!online || falhaPacote) && (
        <Alert tone="warn">
          {!online ? 'Sem rede' : `Pacote não atualizado (${falhaPacote})`}: trabalhando com o pacote baixado em {fmtDateTime(pacote.savedAt)}, com o que já foi enviado.
          {fila.pendentes ? ` ${fila.pendentes} registro(s) ficam no aparelho até a rede voltar.` : ''}
        </Alert>
      )}
      {fila.deOutraLotacao.length > 0 && (
        <Alert tone="warn">
          Há {fila.deOutraLotacao.length} registro(s) feitos em outra lotação ({outrasUnidades}): só são enviados com essa lotação ativa. Troque de lotação no menu para enviá-los.
        </Alert>
      )}
      {fila.deOutros > 0 && <Alert tone="warn">Há {fila.deOutros} registro(s) de outro usuário neste aparelho: só são enviados quando ele entrar.</Alert>}
      {falhaPacote && !p && !carregando && <Alert tone="error">{falhaPacote}</Alert>}
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
                                {doBloco.length ? listaImoveis(doBloco, (i) => estadoNaOrdem(o, i), o.id) : <p className="text-sm text-slate-500">Nenhum imóvel cadastrado.</p>}
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
                    {fila.itens.map((i) => {
                      const outraLotacao = !fila.daLotacao.includes(i);
                      // O registro com a versão anterior gravada no servidor só sai pelo descarte.
                      const acoes = acoesDoItem(i, !outraLotacao);
                      return (
                        <li key={i.clientId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                          <div>
                            <div className="text-sm font-medium">{i.rotulo}</div>
                            <div className="text-xs text-slate-500">registrado em {fmtDateTime(i.op.registradoEm)}</div>
                            {outraLotacao && <div className="text-xs text-amber-700">Registrado em {nomeDaUnidade(i.unitId)}: troque para essa lotação no menu para enviar.</div>}
                            {i.erro && <div className="text-xs text-red-700">{i.erro}</div>}
                            {i.status === 'PENDENTE' && i.adiado && <div className="text-xs text-amber-700">Última tentativa: {i.adiado}</div>}
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge tone={outraLotacao ? 'amber' : i.status === 'ERRO' ? 'red' : 'blue'}>{outraLotacao ? 'Outra lotação' : i.status === 'ERRO' ? 'Erro' : 'Pendente'}</Badge>
                            {acoes.includes('corrigir') && (
                              <Button size="sm" onClick={() => corrigir(i)}>
                                Corrigir
                              </Button>
                            )}
                            {acoes.includes('tentarDeNovo') && (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() =>
                                  void filaAce
                                    .tentarDeNovo(i.clientId)
                                    .then(() => sincronizar())
                                    .catch((e) => toast.error(errorMessage(e)))
                                }
                              >
                                Tentar de novo
                              </Button>
                            )}
                            {acoes.includes('descartar') && (
                              <Button size="sm" variant="ghost" onClick={() => descartar(i)}>
                                Descartar
                              </Button>
                            )}
                          </div>
                        </li>
                      );
                    })}
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
                        {e.avisos?.map((a, k) => (
                          <div key={k} className="text-xs text-amber-700">
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
                <CardHeader title="Larvicida no depósito de endemias" description="Saldo do pacote baixado, menos o que já foi enviado e o uso que ainda está na fila. A baixa oficial é feita ao sincronizar." />
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
                  {semSaldo.length > 0 && (
                    <p className="mt-2 text-xs text-slate-500">Sem saldo no pacote: {semSaldo.map((x) => x.descricao).join(', ')}. Dá para registrar o uso digitando o lote; a baixa fica pendente para a supervisão.</p>
                  )}
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
          produtos={p?.produtos}
          estoque={p?.estoque ?? []}
          userId={userId}
          usoNaFila={usoNaFila}
          inicial={dialogo?.tipo === 'visita' && corrigindo?.op.tipo === 'VISITA_VETORIAL' ? corrigindo.op : null}
          onSalvar={corrigindo ? regravar(corrigindo) : registrar}
        />
      )}
      <ImovelForm
        aberto={dialogo?.tipo === 'imovel'}
        onClose={() => setDialogo(null)}
        quarteirao={dialogo?.tipo === 'imovel' ? dialogo.quarteirao : null}
        quarteiroes={p?.quarteiroes}
        inicial={dialogo?.tipo === 'imovel' && corrigindo?.op.tipo === 'IMOVEL' ? corrigindo.op : null}
        onSalvar={corrigindo ? regravar(corrigindo) : registrar}
      />
    </div>
  );
}
