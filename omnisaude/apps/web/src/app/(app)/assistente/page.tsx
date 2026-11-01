'use client';

import { Bot, MessageSquareWarning, Send, Sparkles, UserRound, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { AssistantPainel, Conversa, ConversaResumo } from '@/components/assistant/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';

const STATUS: Record<ConversaResumo['status'], { label: string; tone: 'blue' | 'amber' | 'slate' }> = {
  ABERTA: { label: 'Com o assistente', tone: 'blue' },
  AGUARDANDO_ATENDENTE: { label: 'Aguardando atendente', tone: 'amber' },
  ENCERRADA: { label: 'Encerrada', tone: 'slate' },
};
const MOTIVO: Record<string, string> = { PEDIDO_DO_CIDADAO: 'pediu uma pessoa', EMERGENCIA: 'triagem apontou emergência', MODELO_SUGERIU: 'o assistente pediu ajuda' };
const TRIAGEM: Record<string, { label: string; tone: 'red' | 'amber' | 'blue' | 'green' }> = {
  EMERGENCIA: { label: 'Emergência', tone: 'red' },
  URGENCIA: { label: 'Urgência', tone: 'amber' },
  POUCO_URGENTE: { label: 'Pouco urgente', tone: 'blue' },
  NAO_URGENTE: { label: 'Não urgente', tone: 'green' },
};

export default function AssistantPage() {
  const session = useSession();
  const toast = useToast();
  const [status, setStatus] = useState<string>('');
  const [busca, setBusca] = useState('');
  const [selecionada, setSelecionada] = useState<string | null>(null);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const painel = useApi<AssistantPainel>('/assistente/painel');
  const lista = useApi<ConversaResumo[]>(`/assistente/conversas?${new URLSearchParams({ ...(status ? { status } : {}), ...(busca ? { busca } : {}) })}`, [status, busca]);
  const conversa = useApi<Conversa>(selecionada ? `/assistente/conversas/${selecionada}` : null, [selecionada]);
  const fim = useRef<HTMLDivElement>(null);
  useRealtime('assistente.conversa', () => {
    void lista.reload();
    void painel.reload();
    if (selecionada) void conversa.reload();
  });
  useRealtime('assistente.atendente', () => void lista.reload());
  useEffect(() => {
    fim.current?.scrollIntoView({ block: 'end' });
  }, [conversa.data?.mensagens.length]);

  async function responder() {
    if (!selecionada || !texto.trim()) return;
    setEnviando(true);
    try {
      await api.post(`/assistente/conversas/${selecionada}/responder`, { texto: texto.trim() });
      setTexto('');
      toast.success('Resposta enviada pelo WhatsApp.');
      await Promise.all([conversa.reload(), lista.reload()]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setEnviando(false);
    }
  }

  async function encerrar() {
    if (!selecionada) return;
    try {
      await api.post(`/assistente/conversas/${selecionada}/encerrar`, {});
      toast.success('Conversa encerrada.');
      await Promise.all([conversa.reload(), lista.reload()]);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const p = painel.data;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Assistente do WhatsApp" description="Conversas do cidadão com o assistente virtual: pedidos de atendente, triagens e o que foi marcado por conversa." />
      {p && !p.assistente.ativo && (
        <Alert tone="warn" title="Assistente desativado">
          Ative o WhatsApp e o assistente nas configurações da instituição (plataforma) para responder mensagens recebidas.
        </Alert>
      )}
      {p && (
        <div className="grid gap-3 md:grid-cols-5">
          <Stat label="Conversas (7 dias)" value={p.conversas7d} hint={`${p.mensagensRecebidas7d} mensagens recebidas`} />
          <Stat label="Aguardando atendente" value={p.aguardandoAtendente} tone={p.aguardandoAtendente ? 'warn' : 'good'} />
          <Stat label="Consultas marcadas por conversa (30 d)" value={p.agendamentos30d} tone="good" />
          <Stat
            label="Triagens com emergência (30 d)"
            value={p.triagens30d.EMERGENCIA ?? 0}
            tone={p.triagens30d.EMERGENCIA ? 'bad' : 'default'}
            hint={`${Object.values(p.triagens30d).reduce((a, b) => a + b, 0)} triagens no período`}
          />
          <Stat label={p.assistente.nome} value={p.assistente.comIa ? 'Com IA' : 'Por regras'} hint={p.assistente.comIa ? 'modelo de linguagem ativo' : 'menu e palavras-chave; IA desativada ou sem chave'} />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardHeader
            title="Conversas"
            actions={
              <div className="flex gap-2">
                <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Situação da conversa">
                  <option value="">Todas</option>
                  <option value="AGUARDANDO_ATENDENTE">Aguardando atendente</option>
                  <option value="ABERTA">Com o assistente</option>
                  <option value="ENCERRADA">Encerradas</option>
                </Select>
                <Input placeholder="Nome ou telefone" value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar conversa" className="w-40" />
              </div>
            }
          />
          <CardBody className="p-0">
            {lista.loading && !lista.data && <Spinner />}
            {lista.error && <Alert tone="error">{lista.error}</Alert>}
            {lista.data && lista.data.length === 0 && <EmptyState title="Nenhuma conversa" description="As mensagens recebidas no número do WhatsApp da instituição aparecem aqui." icon={<Bot className="h-8 w-8" />} />}
            <ul className="divide-y divide-slate-100">
              {lista.data?.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => setSelecionada(c.id)} className={`flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-slate-50 ${selecionada === c.id ? 'bg-brand-50' : ''}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{c.paciente?.nome ?? 'Número não identificado'}</span>
                      <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>{c.telefone ?? '—'}</span>
                      <span>· {c.mensagens} mensagens</span>
                      <span>· {fmtDateTime(c.ultimaEntradaEm)}</span>
                      {c.triagem && <Badge tone={TRIAGEM[c.triagem]?.tone ?? 'slate'}>{TRIAGEM[c.triagem]?.label ?? c.triagem}</Badge>}
                      {c.motivo && <span className="text-amber-700">· {MOTIVO[c.motivo] ?? c.motivo}</span>}
                    </div>
                    {c.ultima && (
                      <p className="truncate text-sm text-slate-600">
                        {c.ultima.direcao === 'ENTRADA' ? '👤 ' : '🤖 '}
                        {c.ultima.texto}
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
        <Card className="flex min-h-[420px] flex-col">
          {!selecionada && (
            <CardBody>
              <EmptyState title="Escolha uma conversa" description="O histórico completo aparece aqui, com a intenção reconhecida em cada mensagem." icon={<Sparkles className="h-8 w-8" />} />
            </CardBody>
          )}
          {selecionada && conversa.loading && !conversa.data && <Spinner />}
          {conversa.data && (
            <>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    {conversa.data.paciente ? (
                      <Link href={`/paciente?id=${conversa.data.paciente.id}`} className="text-brand-700 underline">
                        {conversa.data.paciente.nome}
                      </Link>
                    ) : (
                      'Número não identificado'
                    )}
                    <Badge tone={STATUS[conversa.data.status].tone}>{STATUS[conversa.data.status].label}</Badge>
                    {conversa.data.triagem && <Badge tone={TRIAGEM[conversa.data.triagem]?.tone ?? 'slate'}>Triagem: {TRIAGEM[conversa.data.triagem]?.label ?? conversa.data.triagem}</Badge>}
                  </span>
                }
                description={`${conversa.data.telefone ?? ''} · aberta em ${fmtDateTime(conversa.data.abertaEm)}${conversa.data.motivo ? ` · ${MOTIVO[conversa.data.motivo] ?? conversa.data.motivo}` : ''}`}
                actions={
                  conversa.data.status !== 'ENCERRADA' && session.can('assistente.responder') ? (
                    <Button size="sm" variant="ghost" onClick={encerrar}>
                      <XCircle className="h-4 w-4" /> Encerrar
                    </Button>
                  ) : undefined
                }
              />
              <CardBody className="flex max-h-[520px] flex-1 flex-col gap-2 overflow-y-auto bg-slate-50">
                {conversa.data.mensagens.map((m) => (
                  <div key={m.id} className={`flex ${m.direcao === 'ENTRADA' ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm ${m.direcao === 'ENTRADA' ? 'rounded-bl-sm bg-white' : m.autor ? 'rounded-br-sm bg-amber-100' : 'rounded-br-sm bg-brand-100'}`}>
                      <p className="whitespace-pre-wrap">{m.texto}</p>
                      <p className="mt-1 flex items-center gap-1 text-[11px] text-slate-500">
                        {m.direcao === 'ENTRADA' ? <UserRound className="h-3 w-3" /> : m.autor ? <UserRound className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
                        {m.autor ? `${m.autor} · ` : ''}
                        {fmtDateTime(m.em)}
                        {m.intencao ? ` · ${m.intencao.toLowerCase().replace(/_/g, ' ')}` : ''}
                        {m.detalhes && typeof m.detalhes.modelo === 'string' ? ' · IA' : ''}
                      </p>
                    </div>
                  </div>
                ))}
                <div ref={fim} />
              </CardBody>
              {conversa.data.status !== 'ENCERRADA' && session.can('assistente.responder') && (
                <div className="flex items-end gap-2 border-t border-slate-200 p-3">
                  <Textarea
                    rows={2}
                    value={texto}
                    onChange={(e) => setTexto(e.target.value)}
                    placeholder="Responder ao cidadão pelo WhatsApp (vai em seu nome, pelo número da instituição)"
                    aria-label="Resposta ao cidadão"
                    className="flex-1"
                    id="assistente-resposta"
                  />
                  <Button onClick={responder} loading={enviando} disabled={!texto.trim()} id="assistente-enviar">
                    <Send className="h-4 w-4" /> Enviar
                  </Button>
                </div>
              )}
              {conversa.data.status === 'AGUARDANDO_ATENDENTE' && (
                <p className="flex items-center gap-1 px-3 pb-3 text-xs text-amber-700">
                  <MessageSquareWarning className="h-3.5 w-3.5" /> O cidadão espera uma pessoa. Ao responder, a conversa volta para o assistente.
                </p>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
