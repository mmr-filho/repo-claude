'use client';

import {
  localDateString,
  ROLE_LABELS,
  ROTULO_TIPO_RESPONSAVEL,
  type ListaUnidadesNotificantes,
  type ListaUsuariosLotados,
  type ResponsavelNegativa,
  type Role,
  type TipoResponsavelNegativa,
  type UnidadeNotificante,
} from '@omnisaude/shared';
import { Search, UserPlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, Stat } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useApi } from '@/lib/hooks';
import { useDataHora, useFuso } from './fuso';
import {
  avisoTitularSubstituido,
  dataBr,
  designacaoValida,
  filtrarUnidades,
  MINIMO_MOTIVO_FIM,
  motivoNaoAtesta,
  pendenciasAbrirPeriodo,
  pendenciasDesignacao,
  pendenciasEncerrarPeriodo,
  periodoAberto,
  periodoParaEncerrar,
  responsaveisAtivos,
  resumoUnidades,
  rotuloDesignar,
  rotuloEncerrarPeriodo,
  rotuloRevogar,
  rotuloTipoUnidade,
  rotuloTornarNotificante,
  situacaoDaUnidade,
  titularQueNaoVale,
  type FiltroUnidades,
} from './negativa-regras';

/** "Hoje" no fuso da instituição (valor inicial das datas). */
function useHoje() {
  return localDateString(new Date(), useFuso());
}

type Acao = { tipo: 'abrir' | 'encerrar' | 'designar'; u: UnidadeNotificante } | { tipo: 'revogar'; u: UnidadeNotificante; r: ResponsavelNegativa };

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

/** Abre o período em que a unidade é notificante (entra no denominador da negativa). */
function AbrirPeriodo({ u, onFechar, onFeito }: { u: UnidadeNotificante; onFechar: () => void; onFeito: () => void }) {
  const toast = useToast();
  const hojeNoFuso = useHoje();
  const [desde, setDesde] = useState(hojeNoFuso);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const pend = pendenciasAbrirPeriodo(u, desde);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onFechar()}
      title={`Tornar notificante: ${u.unidade.nome}`}
      description="A partir do início, a unidade entra na grade e deve informar toda semana (positiva ou negativa)."
      footer={
        <Button
          disabled={pend.length > 0}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              await api.post('/vigilancia/unidades-notificantes', { unitId: u.unidade.id, desde });
              toast.success(`${u.unidade.nome} é notificante desde ${dataBr(desde)}.`);
              onFeito();
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Abrir período
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Notificante desde" htmlFor="neg-abrir-desde">
          <Input id="neg-abrir-desde" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </Field>
        <Pendencias itens={pend} />
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}

/**
 * Encerra o período aberto (a unidade sai do denominador depois do fim; o histórico não muda). Na unidade inativa, a
 * data vai até hoje, e o período que ainda termina depois de hoje também se encerra (a API encurta o fim).
 */
export function EncerrarPeriodo({ u, onFechar, onFeito }: { u: UnidadeNotificante; onFechar: () => void; onFeito: () => void }) {
  const toast = useToast();
  const hojeNoFuso = useHoje();
  const [ate, setAte] = useState(hojeNoFuso);
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const pend = pendenciasEncerrarPeriodo(u, ate, motivo, hojeNoFuso);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onFechar()}
      title={`Encerrar o período: ${u.unidade.nome}`}
      description={
        u.ativa
          ? 'Use quando a unidade deixa de atender ou de ser fonte de notificação. As semanas até o fim continuam contando.'
          : 'A unidade está inativa: o fim vai até hoje. Use a data da desativação; as semanas até o fim continuam contando.'
      }
      footer={
        <Button
          variant="danger"
          disabled={pend.length > 0}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              await api.post(`/vigilancia/unidades-notificantes/${u.unidade.id}/encerrar`, { ate, motivo: motivo.trim() });
              toast.success(`Período de ${u.unidade.nome} encerrado em ${dataBr(ate)}.`);
              onFeito();
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Encerrar período
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Último dia como notificante" htmlFor="neg-encerrar-ate">
          <Input id="neg-encerrar-ate" type="date" value={ate} max={u.ativa ? undefined : hojeNoFuso} onChange={(e) => setAte(e.target.value)} />
        </Field>
        <Field label="Motivo" htmlFor="neg-encerrar-motivo" hint={`Pelo menos ${MINIMO_MOTIVO_FIM} caracteres. Ex.: unidade desativada no CNES.`}>
          <Textarea id="neg-encerrar-motivo" rows={2} maxLength={500} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </Field>
        <Pendencias itens={pend} />
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}

/**
 * Designa o responsável pela negativa entre os usuários lotados na unidade. O titular cuja designação não vale não trava
 * a vaga: designar outro titular encerra a dele hoje (a API faz na mesma transação).
 */
function Designar({ u, onFechar, onFeito }: { u: UnidadeNotificante; onFechar: () => void; onFeito: () => void }) {
  const toast = useToast();
  const hojeNoFuso = useHoje();
  const temTitular = responsaveisAtivos(u).some((r) => r.tipo === 'TITULAR' && designacaoValida(r));
  const [busca, setBusca] = useState('');
  const [termo, setTermo] = useState('');
  const [userId, setUserId] = useState('');
  const [tipo, setTipo] = useState<TipoResponsavelNegativa>(temTitular ? 'SUBSTITUTO' : 'TITULAR');
  const [desde, setDesde] = useState(hojeNoFuso);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // A busca vai à API depois de uma pausa na digitação.
  useEffect(() => {
    const t = setTimeout(() => setTermo(busca.trim()), 350);
    return () => clearTimeout(t);
  }, [busca]);
  const lotados = useApi<ListaUsuariosLotados>(`/vigilancia/unidades-notificantes/${u.unidade.id}/lotados${termo ? `?${new URLSearchParams({ busca: termo })}` : ''}`);
  const escolhido = lotados.data?.find((l) => l.userId === userId) ?? null;
  const pend = pendenciasDesignacao(u, { userId, tipo, desde }, escolhido?.nome, escolhido);
  const substituido = avisoTitularSubstituido(u, tipo);
  const antigo = tipo === 'TITULAR' ? titularQueNaoVale(u) : null;
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onFechar()}
      title={`Responsável pela negativa: ${u.unidade.nome}`}
      description="Só quem tem lotação ativa na unidade, em papel que atesta a negativa, pode ser designado. Um titular por unidade; substitutos, quantos forem precisos."
      footer={
        <Button
          disabled={pend.length > 0}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              await api.post(`/vigilancia/unidades-notificantes/${u.unidade.id}/responsaveis`, { userId, tipo, desde });
              toast.success(`${escolhido?.nome ?? 'Responsável'} designado(a) ${tipo === 'TITULAR' ? 'titular' : 'substituto(a)'}.${antigo ? ` A designação de ${antigo.nome} terminou hoje.` : ''}`);
              onFeito();
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <UserPlus className="h-4 w-4" /> Designar
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Buscar usuário lotado na unidade" htmlFor="neg-designar-busca" hint="Pelo nome ou pelo CPF completo (11 dígitos).">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input id="neg-designar-busca" className="pl-9" maxLength={60} value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Nome ou CPF completo" autoComplete="off" />
          </div>
        </Field>
        {lotados.error && <Alert tone="error">{lotados.error}</Alert>}
        {lotados.loading && !lotados.data && <Spinner label="Buscando…" />}
        {lotados.data && lotados.data.length === 0 && <p className="text-sm text-slate-600">Nenhum usuário ativo lotado na unidade{termo ? ' com esse nome ou CPF (o CPF só com os 11 dígitos)' : ''}.</p>}
        {!!lotados.data?.length && (
          <fieldset className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
            <legend className="sr-only">Usuários lotados</legend>
            {lotados.data.map((l) => {
              const naoAtesta = motivoNaoAtesta(l);
              return (
                <label
                  key={l.userId}
                  className={cn('flex items-start gap-2 rounded-md px-2 py-1.5 text-sm', naoAtesta ? 'cursor-not-allowed text-slate-500' : 'cursor-pointer hover:bg-slate-50', userId === l.userId && 'bg-brand-50')}
                >
                  <input type="radio" name="neg-designar-usuario" className="mt-1" checked={userId === l.userId} disabled={!!naoAtesta} onChange={() => setUserId(l.userId)} />
                  <span className="flex-1">
                    <span className="font-medium">{l.nome}</span>
                    <span className="block text-xs text-slate-600">
                      {l.papeis.map((p) => ROLE_LABELS[p as Role] ?? p).join(', ')}
                      {l.cbo ? ` · CBO ${l.cbo}` : ''}
                    </span>
                    {naoAtesta && <span className="block text-xs text-amber-800">{naoAtesta}</span>}
                  </span>
                  {l.responsavel && <Badge tone="blue">Já é {ROTULO_TIPO_RESPONSAVEL[l.responsavel].toLowerCase()}</Badge>}
                </label>
              );
            })}
          </fieldset>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tipo" htmlFor="neg-designar-tipo" hint={temTitular ? 'A unidade já tem titular: revogue antes de trocar.' : undefined}>
            <Select id="neg-designar-tipo" value={tipo} onChange={(e) => setTipo(e.target.value as TipoResponsavelNegativa)}>
              <option value="TITULAR">Titular</option>
              <option value="SUBSTITUTO">Substituto</option>
            </Select>
          </Field>
          <Field label="A partir de" htmlFor="neg-designar-desde">
            <Input id="neg-designar-desde" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
          </Field>
        </div>
        {substituido && <Alert tone="warn">{substituido}</Alert>}
        {userId && <Pendencias itens={pend} />}
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}

/** Revoga a designação (termina hoje; os atestos já feitos continuam valendo). */
function Revogar({ u, r, onFechar, onFeito }: { u: UnidadeNotificante; r: ResponsavelNegativa; onFechar: () => void; onFeito: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  return (
    <Dialog
      open
      size="sm"
      onOpenChange={(o) => !o && onFechar()}
      title="Revogar a designação"
      description={`${r.nome} deixa de ser ${r.tipo === 'TITULAR' ? 'titular' : 'substituto(a)'} da negativa de ${u.unidade.nome} hoje. Os atestos já feitos continuam valendo.`}
      footer={
        <Button
          variant="danger"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              await api.post(`/vigilancia/responsaveis/${r.id}/revogar`);
              toast.success(`Designação de ${r.nome} revogada.`);
              onFeito();
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Revogar
        </Button>
      }
    >
      {erro ? <Alert tone="error">{erro}</Alert> : <p className="text-sm text-slate-700">Confirme para revogar.</p>}
    </Dialog>
  );
}

/** Unidades notificantes (períodos) e responsáveis pela negativa (titular e substitutos). Permissão `vigilancia.consolidacao`. */
export function NegativaUnidades() {
  const lista = useApi<ListaUnidadesNotificantes>('/vigilancia/unidades-notificantes');
  const { dataHora } = useDataHora();
  const hojeNoFuso = useHoje();
  const [filtro, setFiltro] = useState<FiltroUnidades>('TODAS');
  const [busca, setBusca] = useState('');
  const [acao, setAcao] = useState<Acao | null>(null);
  const resumo = useMemo(() => (lista.data ? resumoUnidades(lista.data) : null), [lista.data]);
  const visiveis = useMemo(() => (lista.data ? filtrarUnidades(lista.data, filtro, busca) : []), [lista.data, filtro, busca]);
  const feito = () => {
    setAcao(null);
    void lista.reload();
  };

  return (
    <div className="space-y-4">
      {resumo && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Unidades notificantes" value={resumo.notificantes} />
          <Stat
            label="Sem configuração"
            value={resumo.semConfiguracao}
            tone={resumo.semConfiguracao ? 'warn' : 'good'}
            hint="Unidades ativas que atendem sem período: nunca tiveram ou foram reativadas depois da desativação"
          />
          <Stat label="Notificantes sem titular" value={resumo.semTitular} tone={resumo.semTitular ? 'warn' : 'good'} hint="Sem titular cuja designação vale" />
          <Stat label="Sem nenhum responsável" value={resumo.semResponsavel} tone={resumo.semResponsavel ? 'bad' : 'good'} hint="Ninguém com designação que vale pode atestar a negativa" />
        </div>
      )}
      <Card>
        <CardHeader
          title="Unidades notificantes e responsáveis"
          description="O período define quando a unidade entra no denominador da negativa. O responsável (titular ou substituto) atesta a semana sem caso na tela Notificação negativa."
          actions={
            <div className="flex flex-wrap gap-2">
              <Select aria-label="Mostrar" value={filtro} onChange={(e) => setFiltro(e.target.value as FiltroUnidades)} className="w-auto">
                <option value="TODAS">Todas</option>
                <option value="NOTIFICANTES">Notificantes</option>
                <option value="SEM_TITULAR">Notificantes sem titular</option>
                <option value="SEM_CONFIGURACAO">Sem configuração</option>
                <option value="NAO_NOTIFICANTES">Não notificantes</option>
              </Select>
              <Input aria-label="Buscar unidade" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Nome ou CNES" className="w-48" />
            </div>
          }
        />
        {lista.loading && !lista.data && <Spinner />}
        {lista.error && (
          <CardBody>
            <Alert tone="error">{lista.error}</Alert>
          </CardBody>
        )}
        {lista.data && visiveis.length === 0 && <EmptyState title="Nenhuma unidade com este filtro" />}
        {visiveis.length > 0 && (
          <Table>
            <THead>
              <tr>
                <TH>Unidade</TH>
                <TH>Situação</TH>
                <TH>Responsáveis</TH>
                <TH className="text-right">Ações</TH>
              </tr>
            </THead>
            <TBody>
              {visiveis.map((u) => {
                const sit = situacaoDaUnidade(u);
                const ativos = responsaveisAtivos(u);
                const antigos = u.responsaveis.filter((r) => r.ate !== null);
                const aberto = periodoAberto(u);
                // Na unidade inativa, também o período que ainda termina depois de hoje (o aviso pede o encerramento).
                const paraEncerrar = periodoParaEncerrar(u, hojeNoFuso);
                return (
                  <TR key={u.unidade.id}>
                    <TD>
                      <span className="block font-medium text-slate-900">{u.unidade.nome}</span>
                      <span className="block text-xs text-slate-500">
                        CNES {u.unidade.cnes} · {rotuloTipoUnidade(u.tipoUnidade)}
                        {!u.ativa ? ' · inativa' : ''}
                      </span>
                      {(u.avisos ?? []).map((a) => (
                        <span key={a} className="mt-1 block text-xs text-amber-800">
                          {a}
                        </span>
                      ))}
                    </TD>
                    <TD>
                      <Badge tone={sit.tom}>{sit.texto}</Badge>
                      {u.periodos.length > 0 && (
                        <span className="mt-1 block text-xs text-slate-600">
                          Períodos: {u.periodos.map((p) => `${dataBr(p.desde)} a ${p.ate ? dataBr(p.ate) : 'hoje'}${p.motivoFim ? ` (${p.motivoFim})` : ''}`).join('; ')}
                        </span>
                      )}
                    </TD>
                    <TD>
                      {ativos.length === 0 ? (
                        <span className={cn('text-sm', aberto ? 'text-amber-800' : 'text-slate-500')}>{aberto ? 'Ninguém designado' : '—'}</span>
                      ) : (
                        <ul className="space-y-1">
                          {ativos.map((r) => (
                            <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                              <Badge tone={r.tipo === 'TITULAR' ? 'blue' : 'slate'}>{ROTULO_TIPO_RESPONSAVEL[r.tipo]}</Badge>
                              <span>{r.nome}</span>
                              <span className="text-xs text-slate-500">desde {dataBr(r.desde)}</span>
                              {!designacaoValida(r) && (
                                <span className="flex flex-wrap items-center gap-1 text-xs text-red-800">
                                  <Badge tone="red">Não vale</Badge>
                                  {r.motivoInvalido}
                                </span>
                              )}
                              <Button size="sm" variant="link" className="h-auto" aria-label={rotuloRevogar(r)} onClick={() => setAcao({ tipo: 'revogar', u, r })}>
                                Revogar
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {antigos.length > 0 && (
                        <details className="mt-1 text-xs text-slate-600">
                          <summary className="cursor-pointer">Designações anteriores ({antigos.length})</summary>
                          <ul className="mt-1 space-y-0.5">
                            {antigos.map((r) => (
                              <li key={r.id}>
                                {r.nome} ({ROTULO_TIPO_RESPONSAVEL[r.tipo].toLowerCase()}), de {dataBr(r.desde)} a {dataBr(r.ate)}; designado(a) em {dataHora(r.designadoEm)}
                                {r.designadoPor ? ` por ${r.designadoPor}` : ''}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </TD>
                    <TD className="text-right">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {aberto && (
                          <Button size="sm" aria-label={rotuloDesignar(u)} onClick={() => setAcao({ tipo: 'designar', u })}>
                            Designar
                          </Button>
                        )}
                        {paraEncerrar && (
                          <Button size="sm" variant="secondary" aria-label={rotuloEncerrarPeriodo(u)} onClick={() => setAcao({ tipo: 'encerrar', u })}>
                            Encerrar período
                          </Button>
                        )}
                        {!paraEncerrar && u.ativa && (
                          <Button size="sm" variant="secondary" aria-label={rotuloTornarNotificante(u)} onClick={() => setAcao({ tipo: 'abrir', u })}>
                            Tornar notificante
                          </Button>
                        )}
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
      {acao?.tipo === 'abrir' && <AbrirPeriodo u={acao.u} onFechar={() => setAcao(null)} onFeito={feito} />}
      {acao?.tipo === 'encerrar' && <EncerrarPeriodo u={acao.u} onFechar={() => setAcao(null)} onFeito={feito} />}
      {acao?.tipo === 'designar' && <Designar u={acao.u} onFechar={() => setAcao(null)} onFeito={feito} />}
      {acao?.tipo === 'revogar' && <Revogar u={acao.u} r={acao.r} onFechar={() => setAcao(null)} onFeito={feito} />}
    </div>
  );
}
