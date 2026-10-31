'use client';

import { TURNO_VISITA, type OperacaoCampo } from '@omnisaude/shared';
import { CloudOff, CloudUpload, Home, MapPinned, Plus, RefreshCw, RotateCcw, Trash2, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { HouseholdForm, type DomicilioExistente } from '@/components/acs/household-form';
import { PersonForm } from '@/components/acs/person-form';
import { TerritoryMap, type PontoMapa } from '@/components/acs/territory-map';
import { VisitForm, type DomicilioVisitavel, type PessoaVisitavel } from '@/components/acs/visit-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { BASE_PATH, errorMessage } from '@/lib/api';
import { comCache, filaCampo, historicoEnvios, useFila, type Enviado, type ItemFila } from '@/lib/acs-store';
import { fmtDate, fmtDateTime, todayIso } from '@/lib/format';
import { registrarServiceWorker, useOnline } from '@/lib/offline';
import { useSession } from '@/lib/session';
import type { PatientSummary } from '@/lib/types';

interface Membro extends PatientSummary {
  kinship: string | null;
  phone: string | null;
  prioridades: string[];
  ultimaVisita: string | null;
}
interface Familia {
  id: string;
  recordNumber: string | null;
  incomeBracket: string | null;
  responsibleId: string | null;
  membros: Membro[];
}
interface Domicilio extends DomicilioExistente {
  addressLine: string | null;
  teamId: string | null;
  unitId: string | null;
  updatedAt: string;
  ultimaVisita: { at: string; desfecho: string; desfechoLabel: string; dias: number | null } | null;
  familias: Familia[];
}
interface Territorio {
  agente: { teamId: string | null; teamName: string | null; ine: string | null; microArea: string | null; unitId: string };
  escopo: string;
  serverTime: string;
  resumo: { domicilios: number; familias: number; pessoas: number; visitados30d: number; semVisita90d: number; gestantes: number; criancas: number; idosos: number; cronicos: number };
  domicilios: Domicilio[];
}
interface Visita {
  id: string;
  clientId: string | null;
  visitedAt: string;
  turno: number;
  desfecho: string;
  desfechoLabel: string;
  motivos: { codigo: string; descricao: string }[];
  medicoes: { pesoKg: number | null; alturaCm: number | null; sistolica: number | null; diastolica: number | null; temperatura: number | null; glicemia: number | null };
  profissional: { id: string; nome: string | null; cbo: string };
  pessoa: PatientSummary | null;
  domicilio: { id: string; addressLine: string | null } | null;
  observacoes: string | null;
}
interface Produtividade {
  escopo: string;
  from: string;
  to: string;
  agentes: {
    professionalId: string;
    nome: string;
    cbo: string | null;
    equipe: string | null;
    microArea: string | null;
    visitas: number;
    realizadas: number;
    recusadas: number;
    ausentes: number;
    domiciliosVisitados: number;
    pessoasVisitadas: number;
    cobertura: number | null;
    domiciliosTerritorio: number | null;
    cadastros: { pessoas: number; domicilios: number };
    ultimaSincronizacao: string | null;
    motivosFrequentes: { codigo: string; descricao: string; total: number }[];
  }[];
  totais: { visitas: number; realizadas: number; recusadas: number; ausentes: number; cadastrosPessoas: number; cadastrosDomicilios: number };
}
interface Escopo {
  unidadeAtual: string;
  unidades: { id: string; name: string }[];
  equipes: { id: string; name: string; ine: string; unitId: string; unitName: string }[];
}

const PRIORIDADE_LABEL: Record<string, { label: string; tone: 'red' | 'amber' | 'blue' | 'violet' | 'green' | 'slate' }> = {
  GESTANTE: { label: 'Gestante', tone: 'violet' },
  CRIANCA: { label: 'Criança < 2 anos', tone: 'blue' },
  IDOSO: { label: 'Pessoa idosa', tone: 'amber' },
  HIPERTENSAO: { label: 'Hipertensão', tone: 'red' },
  DIABETES: { label: 'Diabetes', tone: 'red' },
  TB_HANSENIASE: { label: 'TB / hanseníase', tone: 'red' },
  BOLSA_FAMILIA: { label: 'Bolsa Família', tone: 'green' },
};

const tomVisita = (dias: number | null | undefined, desfecho?: string | null): PontoMapa['tom'] => (dias === null || dias === undefined ? 'red' : dias <= 30 && desfecho === '1' ? 'green' : dias <= 90 ? 'amber' : 'red');
const rotuloVisita = (d: Domicilio['ultimaVisita']) => (!d ? 'nunca visitado' : `${d.desfechoLabel.toLowerCase()} há ${d.dias} dia${d.dias === 1 ? '' : 's'}`);

export default function AcsPage() {
  const session = useSession();
  const toast = useToast();
  const online = useOnline();
  const fila = useFila();
  const podeRegistrar = session.can('acs.campo');
  const ehAgente = session.me?.context.role === 'ACS';
  const [tab, setTab] = useState('territorio');
  const [escopo, setEscopo] = useState<{ teamId?: string; microArea?: string }>({});
  const [escopos, setEscopos] = useState<Escopo | null>(null);
  const [terr, setTerr] = useState<{ data: Territorio; deCache: boolean; savedAt: string | null } | null>(null);
  const [erroTerr, setErroTerr] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [busca, setBusca] = useState('');
  const [visitas, setVisitas] = useState<{ data: Visita[]; deCache: boolean; savedAt: string | null } | null>(null);
  const [enviados, setEnviados] = useState<Enviado[]>([]);
  const [prod, setProd] = useState<Produtividade | null>(null);
  const [erroProd, setErroProd] = useState<string | null>(null);
  const [periodo, setPeriodo] = useState({ from: todayIso(-30), to: todayIso() });
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [sincronizando, setSincronizando] = useState(false);
  const [dialogo, setDialogo] = useState<
    | { tipo: 'visita'; domicilio: DomicilioVisitavel | null; pessoas: PessoaVisitavel[]; pessoaInicial?: string | null }
    | { tipo: 'domicilio'; existente: DomicilioExistente | null }
    | { tipo: 'pessoa'; familia: { id: string; pendente: boolean; rotulo: string }; endereco: Domicilio | null }
    | null
  >(null);

  const query = useMemo(() => new URLSearchParams({ ...(escopo.teamId ? { teamId: escopo.teamId } : {}), ...(escopo.microArea ? { microArea: escopo.microArea } : {}) }).toString(), [escopo]);
  const chaveEscopo = `${session.me?.context.unitId ?? ''}:${session.me?.user.id ?? ''}:${query}`;

  const carregarTerritorio = useCallback(async () => {
    setCarregando(true);
    try {
      const r = await comCache<Territorio>(`territorio:${chaveEscopo}`, `/acs/territorio${query ? `?${query}` : ''}`);
      setTerr(r);
      setErroTerr(null);
    } catch (err) {
      setErroTerr(errorMessage(err));
    } finally {
      setCarregando(false);
    }
  }, [chaveEscopo, query]);

  const carregarVisitas = useCallback(async () => {
    try {
      setVisitas(await comCache<Visita[]>(`visitas:${chaveEscopo}`, `/acs/visitas${query ? `?${query}` : ''}`));
    } catch {
      setVisitas(null);
    }
    setEnviados(await historicoEnvios.listar());
  }, [chaveEscopo, query]);

  const sincronizar = useCallback(
    async (silencioso = false) => {
      if (sincronizando) return;
      setSincronizando(true);
      try {
        const r = await filaCampo.sincronizar();
        if (r.offline) {
          if (!silencioso) toast.error('Sem conexão: os registros ficam guardados no aparelho e são enviados quando a rede voltar.');
          return;
        }
        if (r.enviados || r.duplicados || r.erros) {
          if (r.erros) toast.error(`${r.enviados} registro(s) enviado(s); ${r.erros} com erro (veja a aba Visitas).`);
          else if (!silencioso || r.enviados) toast.success(`${r.enviados} registro(s) enviado(s)${r.duplicados ? `, ${r.duplicados} já estavam no servidor` : ''}.`);
          await Promise.all([carregarTerritorio(), carregarVisitas()]);
        } else if (!silencioso) toast.success('Nada pendente: tudo já está no servidor.');
      } finally {
        setSincronizando(false);
      }
    },
    [sincronizando, toast, carregarTerritorio, carregarVisitas],
  );

  useEffect(() => {
    registrarServiceWorker(BASE_PATH);
  }, []);
  useEffect(() => {
    void carregarTerritorio();
    void carregarVisitas();
  }, [carregarTerritorio, carregarVisitas]);
  useEffect(() => {
    if (ehAgente) return;
    comCache<Escopo>('escopos', '/programas/equipes')
      .then((r) => setEscopos(r.data))
      .catch(() => setEscopos(null));
  }, [ehAgente]);
  useEffect(() => {
    if (online && fila.pendentes > 0) void sincronizar(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);
  useEffect(() => {
    if (tab !== 'produtividade') return;
    setErroProd(null);
    comCache<Produtividade>(`produtividade:${chaveEscopo}:${periodo.from}:${periodo.to}`, `/acs/produtividade?${query}${query ? '&' : ''}from=${periodo.from}&to=${periodo.to}`)
      .then((r) => setProd(r.data))
      .catch((err) => setErroProd(errorMessage(err)));
  }, [tab, chaveEscopo, query, periodo]);

  async function registrar(ops: OperacaoCampo[], rotulo: string) {
    for (const op of ops) await filaCampo.adicionar(op, rotulo);
    if (online) await sincronizar(true);
    else toast.success('Registrado no aparelho. Será enviado quando houver conexão.');
  }

  // Domicílios ainda não enviados (cadastrados agora, sem rede) aparecem no território com a marca de pendência.
  const pendentes = fila.itens;
  const domiciliosPendentes = pendentes
    .filter((i) => i.op.tipo === 'DOMICILIO' && !i.op.householdId)
    .map((i) => {
      const op = i.op as Extract<OperacaoCampo, { tipo: 'DOMICILIO' }>;
      const pessoas = pendentes
        .filter((p) => p.op.tipo === 'PESSOA' && ((p.op as Extract<OperacaoCampo, { tipo: 'PESSOA' }>).familiaClientId === op.clientId || op.familia?.responsavelClientId === p.clientId))
        .map((p) => p.op as Extract<OperacaoCampo, { tipo: 'PESSOA' }>);
      return { clientId: op.clientId, status: i.status, erro: i.erro, dados: op.dados, pessoas, rotulo: [op.dados.street, op.dados.number, op.dados.district].filter(Boolean).join(', ') };
    });
  const visitasPendentesPor = (id: string) =>
    pendentes.filter((i) => i.op.tipo === 'VISITA' && ((i.op as Extract<OperacaoCampo, { tipo: 'VISITA' }>).householdId === id || (i.op as Extract<OperacaoCampo, { tipo: 'VISITA' }>).householdClientId === id)).length;

  const domicilios = useMemo(() => {
    const lista = terr?.data.domicilios ?? [];
    const q = busca.trim().toLowerCase();
    if (!q) return lista;
    return lista.filter((d) => (d.addressLine ?? '').toLowerCase().includes(q) || d.familias.some((f) => f.membros.some((m) => m.name.toLowerCase().includes(q))));
  }, [terr, busca]);

  const pontos: PontoMapa[] = useMemo(
    () =>
      (terr?.data.domicilios ?? [])
        .filter((d) => d.latitude !== null && d.longitude !== null)
        .map((d) => ({
          id: d.id,
          latitude: d.latitude as number,
          longitude: d.longitude as number,
          titulo: d.addressLine ?? 'Domicílio',
          subtitulo: `${d.familias.reduce((s, f) => s + f.membros.length, 0)} pessoa(s) · ${rotuloVisita(d.ultimaVisita)}`,
          tom: tomVisita(d.ultimaVisita?.dias, d.ultimaVisita?.desfecho),
        })),
    [terr],
  );

  const abrirVisita = (d: Domicilio | null, pessoaInicial?: string | null) =>
    setDialogo({
      tipo: 'visita',
      domicilio: d
        ? { id: d.id, pendente: false, rotulo: d.addressLine ?? 'Domicílio', microArea: d.microArea ?? null, propertyType: d.propertyType ?? null, latitude: d.latitude ?? null, longitude: d.longitude ?? null }
        : null,
      pessoas: d ? d.familias.flatMap((f) => f.membros.map((m) => ({ id: m.id, pendente: false, nome: m.name, idade: m.age }))) : [],
      pessoaInicial: pessoaInicial ?? null,
    });
  const abrirVisitaPendente = (p: (typeof domiciliosPendentes)[number]) =>
    setDialogo({
      tipo: 'visita',
      domicilio: {
        id: p.clientId,
        pendente: true,
        rotulo: p.rotulo,
        microArea: p.dados.microArea ?? null,
        propertyType: p.dados.propertyType ?? null,
        latitude: p.dados.latitude ?? null,
        longitude: p.dados.longitude ?? null,
      },
      pessoas: p.pessoas.map((x) => ({ id: x.clientId, pendente: true, nome: x.dados.name, idade: null })),
    });

  const municipio = terr?.data.domicilios.find((d) => d.city || d.ibgeCode) ?? null;
  const resumo = terr?.data.resumo;

  if (!session.me) return null;
  return (
    <>
      <PageHeader
        title="Agente comunitário de saúde"
        description={terr ? terr.data.escopo : 'Território, visitas domiciliares e cadastros em campo'}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={online ? 'green' : 'amber'}>
              {online ? <CloudUpload className="mr-1 inline h-3.5 w-3.5" /> : <CloudOff className="mr-1 inline h-3.5 w-3.5" />}
              {online ? 'Conectado' : 'Sem internet'}
            </Badge>
            {fila.pendentes > 0 && <Badge tone="blue">{fila.pendentes} a enviar</Badge>}
            {fila.erros > 0 && <Badge tone="red">{fila.erros} com erro</Badge>}
            {podeRegistrar && (
              <Button variant="secondary" size="sm" onClick={() => sincronizar(false)} loading={sincronizando} disabled={!online} id="acs-sincronizar">
                <RefreshCw className="mr-1 h-4 w-4" /> Sincronizar
              </Button>
            )}
          </div>
        }
      />
      {!online && (
        <Alert tone="warn" className="mb-4" title="Trabalhando sem internet">
          Você vê o território da última sincronização e pode registrar visitas e cadastros. Tudo fica guardado no aparelho e é enviado quando a conexão voltar.
        </Alert>
      )}
      {terr?.deCache && online && (
        <Alert tone="info" className="mb-4">
          Mostrando a cópia guardada em {fmtDateTime(terr.savedAt)}; não foi possível atualizar agora.
        </Alert>
      )}
      {!ehAgente && (
        <Card className="mb-4">
          <CardBody className="grid gap-3 sm:grid-cols-3">
            <Field label="Equipe" htmlFor="acs-equipe">
              <Select id="acs-equipe" value={escopo.teamId ?? ''} onChange={(e) => setEscopo((s) => ({ ...s, teamId: e.target.value || undefined }))}>
                <option value="">Toda a unidade</option>
                {(escopos?.equipes ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.unitName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Microárea" htmlFor="acs-micro">
              <Input id="acs-micro" value={escopo.microArea ?? ''} onChange={(e) => setEscopo((s) => ({ ...s, microArea: e.target.value || undefined }))} placeholder="todas" />
            </Field>
            <p className="self-end text-sm text-slate-500">Acompanhamento do trabalho dos agentes: o registro em campo é feito pelo próprio ACS no app.</p>
          </CardBody>
        </Card>
      )}
      {resumo && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          <Stat label="Domicílios" value={resumo.domicilios} />
          <Stat label="Pessoas" value={resumo.pessoas} hint={`${resumo.familias} famílias`} />
          <Stat label="Visitados em 30 dias" value={resumo.visitados30d} tone={resumo.domicilios && resumo.visitados30d / resumo.domicilios >= 0.5 ? 'good' : 'warn'} />
          <Stat label="Sem visita há 90 dias" value={resumo.semVisita90d} tone={resumo.semVisita90d ? 'bad' : 'good'} />
          <Stat label="Gestantes / crianças" value={`${resumo.gestantes} / ${resumo.criancas}`} />
          <Stat label="Idosos / crônicos" value={`${resumo.idosos} / ${resumo.cronicos}`} />
        </div>
      )}
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'territorio', label: 'Território' },
          { value: 'visitas', label: `Visitas${fila.itens.length ? ` (${fila.itens.length})` : ''}` },
          { value: 'mapa', label: 'Mapa' },
          { value: 'produtividade', label: 'Produtividade' },
        ]}
      >
        <TabPanel value="territorio">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por rua ou nome" aria-label="Buscar no território" className="max-w-sm" />
            {podeRegistrar && (
              <>
                <Button onClick={() => setDialogo({ tipo: 'domicilio', existente: null })} id="acs-novo-domicilio">
                  <Plus className="mr-1 h-4 w-4" /> Novo domicílio
                </Button>
                <Button variant="secondary" onClick={() => abrirVisita(null)}>
                  <Home className="mr-1 h-4 w-4" /> Visita fora do território
                </Button>
              </>
            )}
          </div>
          {erroTerr && !terr && <Alert tone="error">{erroTerr}</Alert>}
          {carregando && !terr && <Spinner />}
          {domiciliosPendentes.map((p) => (
            <Card key={p.clientId} className="mb-3 border-dashed border-brand-300">
              <CardHeader
                title={p.rotulo || 'Novo domicílio'}
                description={p.status === 'ERRO' ? `Erro ao enviar: ${p.erro}` : 'Aguardando envio ao servidor'}
                actions={
                  podeRegistrar && (
                    <Button size="sm" variant="secondary" onClick={() => abrirVisitaPendente(p)}>
                      Visitar
                    </Button>
                  )
                }
              />
              {p.pessoas.length > 0 && (
                <CardBody className="text-sm text-slate-600">
                  {p.pessoas.map((x) => x.dados.name).join(' · ')}
                  {podeRegistrar && (
                    <Button size="sm" variant="ghost" className="ml-2" onClick={() => setDialogo({ tipo: 'pessoa', familia: { id: p.clientId, pendente: true, rotulo: p.rotulo }, endereco: null })}>
                      <UserPlus className="mr-1 h-4 w-4" /> Nova pessoa
                    </Button>
                  )}
                </CardBody>
              )}
            </Card>
          ))}
          {terr && domicilios.length === 0 && !domiciliosPendentes.length && (
            <EmptyState title="Nenhum domicílio" description={busca ? 'Nada encontrado com esse texto.' : 'Cadastre o primeiro domicílio do território.'} icon={<MapPinned className="h-8 w-8" />} />
          )}
          <div className="flex flex-col gap-3">
            {domicilios.map((d) => {
              const pend = visitasPendentesPor(d.id);
              return (
                <Card key={d.id} id={`dom-${d.id}`} className={selecionado === d.id ? 'ring-2 ring-brand-400' : undefined}>
                  <CardHeader
                    title={
                      <span className="flex flex-wrap items-center gap-2">
                        {d.addressLine ?? 'Domicílio sem endereço'}
                        <Badge tone={tomVisita(d.ultimaVisita?.dias, d.ultimaVisita?.desfecho) === 'green' ? 'green' : tomVisita(d.ultimaVisita?.dias, d.ultimaVisita?.desfecho) === 'amber' ? 'amber' : 'red'}>
                          {rotuloVisita(d.ultimaVisita)}
                        </Badge>
                        {pend > 0 && <Badge tone="blue">{pend} visita(s) a enviar</Badge>}
                        {d.latitude === null && <Badge tone="slate">sem posição no mapa</Badge>}
                      </span>
                    }
                    description={`Microárea ${d.microArea ?? '—'}${d.cep ? ` · CEP ${d.cep}` : ''}${d.rooms ? ` · ${d.rooms} cômodos` : ''}`}
                    actions={
                      podeRegistrar && (
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" onClick={() => abrirVisita(d)} className="acs-visitar">
                            Visitar
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setDialogo({ tipo: 'domicilio', existente: d })}>
                            Editar
                          </Button>
                        </div>
                      )
                    }
                  />
                  <CardBody className="flex flex-col gap-3">
                    {d.familias.map((f, i) => (
                      <div key={f.id}>
                        <div className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                          <span>
                            Família {d.familias.length > 1 ? i + 1 : ''} · {f.membros.length} pessoa(s)
                          </span>
                          {podeRegistrar && (
                            <Button size="sm" variant="ghost" onClick={() => setDialogo({ tipo: 'pessoa', familia: { id: f.id, pendente: false, rotulo: d.addressLine ?? 'Domicílio' }, endereco: d })}>
                              <UserPlus className="mr-1 h-4 w-4" /> Nova pessoa
                            </Button>
                          )}
                        </div>
                        <ul className="divide-y divide-slate-100">
                          {f.membros.map((m) => (
                            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                              <div className="min-w-0">
                                <p className="font-medium">
                                  {m.name}
                                  {f.responsibleId === m.id && <span className="ml-1 text-xs font-normal text-slate-500">(responsável)</span>}
                                </p>
                                <p className="text-xs text-slate-500">
                                  {m.age} anos · {m.sex === 'F' ? 'feminino' : 'masculino'}
                                  {m.phone ? ` · ${m.phone}` : ''}
                                  {m.ultimaVisita ? ` · última visita ${fmtDate(m.ultimaVisita)}` : ' · sem visita registrada'}
                                </p>
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {m.prioridades.map((p) => (
                                    <Badge key={p} tone={PRIORIDADE_LABEL[p]?.tone ?? 'slate'}>
                                      {PRIORIDADE_LABEL[p]?.label ?? p}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                              {podeRegistrar && (
                                <Button size="sm" variant="secondary" onClick={() => abrirVisita(d, m.id)}>
                                  Visitar
                                </Button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    {d.familias.length === 0 && <p className="text-sm text-slate-500">Sem família cadastrada neste domicílio.</p>}
                  </CardBody>
                </Card>
              );
            })}
          </div>
        </TabPanel>

        <TabPanel value="visitas">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Fila do aparelho" description={fila.itens.length ? `${fila.pendentes} a enviar · ${fila.erros} com erro` : 'Nada pendente'} />
              <CardBody>
                {fila.itens.length === 0 ? (
                  <p className="text-sm text-slate-500">Tudo o que foi registrado já está no servidor.</p>
                ) : (
                  <ul className="divide-y divide-slate-100" id="acs-fila">
                    {fila.itens.map((i: ItemFila) => (
                      <li key={i.clientId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <div className="min-w-0">
                          <p className="font-medium">{i.rotulo}</p>
                          <p className="text-xs text-slate-500">
                            {fmtDateTime(i.criadoEm)} · {i.status === 'ERRO' ? <span className="text-red-700">{i.erro}</span> : 'aguardando envio'}
                          </p>
                        </div>
                        <div className="flex gap-1">
                          {i.status === 'ERRO' && (
                            <Button size="sm" variant="ghost" onClick={() => filaCampo.tentarDeNovo(i.clientId)} title="Tentar de novo">
                              <RotateCcw className="h-4 w-4" />
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => filaCampo.remover(i.clientId)} title="Descartar" aria-label="Descartar registro">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {enviados.length > 0 && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm text-slate-600">Últimos envios deste aparelho ({enviados.length})</summary>
                    <ul className="mt-2 text-xs text-slate-500">
                      {enviados.slice(0, 30).map((e) => (
                        <li key={e.clientId}>
                          {fmtDateTime(e.em)} · {e.rotulo}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Visitas registradas" description={visitas ? `${visitas.data.length} nos últimos 30 dias${visitas.deCache ? ` · cópia de ${fmtDateTime(visitas.savedAt)}` : ''}` : 'Carregando…'} />
              <CardBody className="p-0">
                {visitas && visitas.data.length === 0 && <p className="p-4 text-sm text-slate-500">Nenhuma visita no período.</p>}
                {visitas && visitas.data.length > 0 && (
                  <Table>
                    <THead>
                      <TR>
                        <TH>Quando</TH>
                        <TH>Pessoa / domicílio</TH>
                        <TH>Desfecho</TH>
                        <TH>Motivos</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {visitas.data.slice(0, 100).map((v) => (
                        <TR key={v.id}>
                          <TD className="whitespace-nowrap">
                            {fmtDateTime(v.visitedAt)}
                            <span className="block text-xs text-slate-500">{TURNO_VISITA[v.turno]}</span>
                          </TD>
                          <TD>
                            {v.pessoa?.name ?? <span className="text-slate-500">imóvel</span>}
                            <span className="block text-xs text-slate-500">{v.domicilio?.addressLine ?? 'fora do território'}</span>
                            {!ehAgente && <span className="block text-xs text-slate-500">{v.profissional.nome}</span>}
                          </TD>
                          <TD>
                            <Badge tone={v.desfecho === '1' ? 'green' : v.desfecho === '2' ? 'red' : 'amber'}>{v.desfechoLabel}</Badge>
                            {v.medicoes.sistolica && (
                              <span className="block text-xs text-slate-500">
                                PA {v.medicoes.sistolica}/{v.medicoes.diastolica}
                              </span>
                            )}
                          </TD>
                          <TD className="text-xs text-slate-600">{v.motivos.map((m) => m.descricao).join(', ')}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </CardBody>
            </Card>
          </div>
        </TabPanel>

        <TabPanel value="mapa">
          <Card>
            <CardHeader
              title="Mapa do território"
              description={`${pontos.length} de ${terr?.data.domicilios.length ?? 0} domicílios com posição · verde: visitado em 30 dias · âmbar: até 90 dias · vermelho: sem visita recente`}
              actions={
                selecionado &&
                podeRegistrar && (
                  <Button size="sm" onClick={() => abrirVisita(terr?.data.domicilios.find((d) => d.id === selecionado) ?? null)}>
                    Visitar selecionado
                  </Button>
                )
              }
            />
            <CardBody>
              {terr && pontos.length === 0 ? (
                <EmptyState
                  title="Nenhum domicílio com posição"
                  description="Marque a posição ao cadastrar o domicílio ou ao registrar a visita (botão “Marcar minha posição”)."
                  icon={<MapPinned className="h-8 w-8" />}
                />
              ) : (
                <TerritoryMap pontos={pontos} selecionado={selecionado} onSelect={setSelecionado} />
              )}
              {selecionado && <p className="mt-2 text-sm text-slate-600">{terr?.data.domicilios.find((d) => d.id === selecionado)?.addressLine}</p>}
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="produtividade">
          <Card>
            <CardHeader
              title="Produtividade dos agentes"
              description={prod ? `${prod.escopo} · ${fmtDate(prod.from)} a ${fmtDate(prod.to)}` : 'Visitas por desfecho, cobertura do território e cadastros no período'}
              actions={
                <div className="flex items-end gap-2">
                  <Field label="De" htmlFor="prod-de">
                    <Input id="prod-de" type="date" value={periodo.from} onChange={(e) => setPeriodo((p) => ({ ...p, from: e.target.value }))} />
                  </Field>
                  <Field label="Até" htmlFor="prod-ate">
                    <Input id="prod-ate" type="date" value={periodo.to} onChange={(e) => setPeriodo((p) => ({ ...p, to: e.target.value }))} />
                  </Field>
                </div>
              }
            />
            <CardBody className="p-0">
              {erroProd && (
                <Alert tone="error" className="m-4">
                  {erroProd}
                </Alert>
              )}
              {!prod && !erroProd && <Spinner />}
              {prod && (
                <>
                  <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
                    <Stat label="Visitas" value={prod.totais.visitas} />
                    <Stat label="Realizadas" value={prod.totais.realizadas} tone="good" />
                    <Stat label="Recusadas / ausentes" value={`${prod.totais.recusadas} / ${prod.totais.ausentes}`} />
                    <Stat label="Cadastros" value={`${prod.totais.cadastrosDomicilios} dom. · ${prod.totais.cadastrosPessoas} pessoas`} />
                  </div>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Agente</TH>
                        <TH>Realizadas</TH>
                        <TH>Recusadas</TH>
                        <TH>Ausentes</TH>
                        <TH>Domicílios</TH>
                        <TH>Cobertura</TH>
                        <TH>Cadastros</TH>
                        <TH>Motivos frequentes</TH>
                        <TH>Última sincronização</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {prod.agentes.map((a) => (
                        <TR key={a.professionalId}>
                          <TD>
                            {a.nome}
                            <span className="block text-xs text-slate-500">
                              {a.equipe ?? '—'}
                              {a.microArea ? ` · microárea ${a.microArea}` : ''}
                            </span>
                          </TD>
                          <TD>{a.realizadas}</TD>
                          <TD>{a.recusadas}</TD>
                          <TD>{a.ausentes}</TD>
                          <TD>
                            {a.domiciliosVisitados}
                            {a.domiciliosTerritorio !== null ? ` de ${a.domiciliosTerritorio}` : ''}
                          </TD>
                          <TD>{a.cobertura !== null ? `${a.cobertura}%` : '—'}</TD>
                          <TD>
                            {a.cadastros.domicilios} dom. · {a.cadastros.pessoas} pessoas
                          </TD>
                          <TD className="text-xs text-slate-600">{a.motivosFrequentes.map((m) => `${m.descricao} (${m.total})`).join(', ') || '—'}</TD>
                          <TD className="whitespace-nowrap text-xs">{a.ultimaSincronizacao ? fmtDateTime(a.ultimaSincronizacao) : '—'}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                  {prod.agentes.length === 0 && <p className="p-4 text-sm text-slate-500">Nenhum agente com CBO de ACS nesta equipe ou unidade.</p>}
                </>
              )}
            </CardBody>
          </Card>
        </TabPanel>
      </Tabs>

      <VisitForm
        aberto={dialogo?.tipo === 'visita'}
        onClose={() => setDialogo(null)}
        domicilio={dialogo?.tipo === 'visita' ? dialogo.domicilio : null}
        pessoas={dialogo?.tipo === 'visita' ? dialogo.pessoas : []}
        pessoaInicial={dialogo?.tipo === 'visita' ? dialogo.pessoaInicial : null}
        onSalvar={(op, rotulo) => registrar([op], rotulo)}
      />
      <HouseholdForm
        aberto={dialogo?.tipo === 'domicilio'}
        onClose={() => setDialogo(null)}
        existente={dialogo?.tipo === 'domicilio' ? dialogo.existente : null}
        microAreaPadrao={terr?.data.agente.microArea ?? null}
        municipio={municipio ? { city: municipio.city ?? null, uf: municipio.uf ?? null, ibgeCode: municipio.ibgeCode ?? null } : null}
        onSalvar={registrar}
      />
      <PersonForm
        aberto={dialogo?.tipo === 'pessoa'}
        onClose={() => setDialogo(null)}
        familia={dialogo?.tipo === 'pessoa' ? dialogo.familia : null}
        endereco={
          dialogo?.tipo === 'pessoa' && dialogo.endereco
            ? {
                cep: dialogo.endereco.cep,
                street: dialogo.endereco.street,
                number: dialogo.endereco.number,
                complement: dialogo.endereco.complement,
                district: dialogo.endereco.district,
                city: dialogo.endereco.city,
                uf: dialogo.endereco.uf,
                ibgeCode: dialogo.endereco.ibgeCode,
              }
            : null
        }
        onSalvar={(op, rotulo) => registrar([op], rotulo)}
      />
    </>
  );
}
