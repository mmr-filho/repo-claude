'use client';

import { PROGRAMAS_APS, type CodigoPrograma, type TipoEstratificacao } from '@omnisaude/shared';
import { ListChecks, RefreshCw, Stethoscope, UserRoundSearch } from 'lucide-react';
import { useState } from 'react';
import { RESULT_LABEL, RESULT_TONE, StratificationDialog } from '@/components/programs/stratification-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Escopo {
  unidadeAtual: string;
  unidades: { id: string; name: string }[];
  equipes: { id: string; name: string; ine: string; unitId: string; unitName: string }[];
}
interface Resumo {
  escopo: string;
  ate: string;
  programas: { codigo: CodigoPrograma; titulo: string; populacao: number; faltosos: number; indicadores: string[] }[];
}
interface Pessoa {
  patientId: string;
  nome: string;
  idade: number;
  sexo: string;
  situacao: string;
  faltas: { codigo: string; descricao: string }[];
  proximaAcao: string | null;
  linhas: string[];
  estratificacao: { kind: TipoEstratificacao; result: string; assessedAt: string; nextDueAt: string | null } | null;
  pontos?: number;
  maximo?: number;
  buscaAtiva: { id: string; lineOfCare: string; status: string } | null;
}
interface Lista {
  codigo: CodigoPrograma;
  titulo: string;
  escopo: string;
  ate: string;
  populacao: number;
  faltosos: number;
  indicadores: string[];
  pessoas: Pessoa[];
}

const INSTRUMENTO: Partial<Record<CodigoPrograma, TipoEstratificacao>> = { PRE_NATAL: 'GESTANTE', HAS_DM: 'PE_DIABETICO', PUERICULTURA: 'MCHAT' };
const CASE_LABEL: Record<string, string> = { ABERTO: 'busca ativa aberta', EM_CONTATO: 'em contato', AGENDADO: 'agendado' };

export default function ProgramasPage() {
  const session = useSession();
  const toast = useToast();
  const [escopo, setEscopo] = useState<{ unitId?: string; teamId?: string }>({});
  const [programa, setPrograma] = useState<CodigoPrograma>('PRE_NATAL');
  const [soFaltosos, setSoFaltosos] = useState(true);
  const [estrat, setEstrat] = useState<{ patientId: string; nome: string; kind: TipoEstratificacao } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const query = new URLSearchParams({ ...(escopo.unitId ? { unitId: escopo.unitId } : {}), ...(escopo.teamId ? { teamId: escopo.teamId } : {}) });
  const escopos = useApi<Escopo>('/programas/equipes');
  const resumo = useApi<Resumo>(`/programas/resumo?${query}`, [escopo]);
  const lista = useApi<Lista>(`/programas/${programa}?${query}&faltosos=${soFaltosos}`, [programa, escopo, soFaltosos]);
  const def = PROGRAMAS_APS.find((p) => p.codigo === programa)!;

  async function buscaAtiva(p: Pessoa) {
    const linha = p.linhas[0];
    if (!linha) return;
    setBusy(p.patientId);
    try {
      await api.post('/social/cases', { patientId: p.patientId, lineOfCare: linha });
      toast.success(`Busca ativa aberta para ${p.nome}`);
      await lista.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Programas da APS"
        description="Ações programáticas por ciclo de vida e condição: quem está em acompanhamento, o que está em atraso e a próxima ação. Cada falta alimenta o indicador do cofinanciamento correspondente e pode virar um caso de busca ativa."
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              void resumo.reload();
              void lista.reload();
            }}
          >
            <RefreshCw className="h-4 w-4" /> Atualizar
          </Button>
        }
      />
      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Escopo" htmlFor="prog-escopo">
            <Select
              id="prog-escopo"
              value={escopo.teamId ? `team:${escopo.teamId}` : escopo.unitId ? `unit:${escopo.unitId}` : ''}
              onChange={(e) => {
                const [tipo, id] = e.target.value.split(':');
                setEscopo(tipo === 'team' ? { teamId: id } : tipo === 'unit' ? { unitId: id } : {});
              }}
              className="w-80"
            >
              <option value="">Unidade atual (toda a população vinculada)</option>
              {(escopos.data?.unidades ?? []).map((u) => (
                <option key={u.id} value={`unit:${u.id}`}>
                  Unidade · {u.name}
                </option>
              ))}
              {(escopos.data?.equipes ?? []).map((t) => (
                <option key={t.id} value={`team:${t.id}`}>
                  Equipe · {t.name} ({t.unitName})
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" className="h-5 w-5" checked={soFaltosos} onChange={(e) => setSoFaltosos(e.target.checked)} />
            Só quem tem pendência
          </label>
          {resumo.data && (
            <p className="text-sm text-slate-600">
              {resumo.data.escopo} · apurado em {fmtDateTime(resumo.data.ate)}
            </p>
          )}
        </CardBody>
      </Card>
      {resumo.error && <Alert tone="error">{String(resumo.error)}</Alert>}
      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
        {(resumo.data?.programas ?? PROGRAMAS_APS.map((p) => ({ codigo: p.codigo, titulo: p.titulo, populacao: 0, faltosos: 0, indicadores: p.indicadores }))).map((p) => (
          <button
            key={p.codigo}
            type="button"
            onClick={() => setPrograma(p.codigo)}
            className={`rounded-lg border p-3 text-left transition-colors ${programa === p.codigo ? 'border-brand-600 bg-brand-50/50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
          >
            <p className="text-sm font-medium text-slate-800">{p.titulo}</p>
            <p className="text-xs text-slate-500">
              {p.populacao} em acompanhamento · <span className={p.faltosos ? 'text-amber-700' : 'text-emerald-700'}>{p.faltosos} com pendência</span>
              {p.indicadores.length ? ` · ${p.indicadores.join(', ')}` : ''}
            </p>
          </button>
        ))}
      </div>
      <Card className="mb-4">
        <CardHeader title={def.titulo} description={`${def.descricao} População: ${def.populacao}${def.indicadores.length ? ` Alimenta ${def.indicadores.join(' e ')}.` : ''}`} />
        <CardBody className="text-xs text-slate-600">
          <p className="mb-1 font-medium text-slate-800">Ações programáticas</p>
          <ul className="grid gap-1 md:grid-cols-2">
            {def.acoes.map((a) => (
              <li key={a.codigo}>
                <b>{a.descricao}</b>: {a.periodicidade}
              </li>
            ))}
          </ul>
          <p className="mt-2">Referências: {def.referencias.join(' · ')}</p>
        </CardBody>
      </Card>
      {lista.error && <Alert tone="error">{String(lista.error)}</Alert>}
      {lista.loading && !lista.data ? (
        <Spinner />
      ) : lista.data ? (
        <Card>
          <CardHeader title={`${lista.data.titulo}: ${soFaltosos ? 'faltosos' : 'em acompanhamento'}`} description={`${lista.data.populacao} pessoas em acompanhamento · ${lista.data.faltosos} com pendência`} />
          <div className="mb-4 grid grid-cols-2 gap-3 px-4 md:grid-cols-4">
            <Stat label="Em acompanhamento" value={lista.data.populacao} />
            <Stat label="Com pendência" value={lista.data.faltosos} tone={lista.data.faltosos ? 'warn' : 'good'} />
            <Stat label="Em busca ativa" value={lista.data.pessoas.filter((p) => p.buscaAtiva).length} />
            <Stat label="Estratificados" value={lista.data.pessoas.filter((p) => p.estratificacao).length} hint={INSTRUMENTO[programa] ? 'com instrumento aplicado' : 'não se aplica'} />
          </div>
          {lista.data.pessoas.length === 0 ? (
            <EmptyState
              icon={<ListChecks className="h-8 w-8" />}
              title={soFaltosos ? 'Ninguém com pendência' : 'Ninguém em acompanhamento'}
              description="Vincule as pessoas às equipes pelo cadastro domiciliar e registre as condições de saúde."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Pessoa</TH>
                  <TH>Situação</TH>
                  <TH>Pendências</TH>
                  <TH>Próxima ação</TH>
                  <TH></TH>
                </TR>
              </THead>
              <TBody>
                {lista.data.pessoas.map((p) => (
                  <TR key={p.patientId}>
                    <TD>
                      <a className="font-medium text-brand-700 underline" href={`/paciente?id=${p.patientId}`}>
                        {p.nome}
                      </a>
                      <span className="block text-xs text-slate-500">
                        {p.idade} anos · {p.sexo === 'F' ? 'feminino' : 'masculino'}
                        {p.maximo ? ` · ${p.pontos}/${p.maximo} pontos` : ''}
                      </span>
                      {p.buscaAtiva && (
                        <Badge tone="violet" className="mt-1">
                          {CASE_LABEL[p.buscaAtiva.status] ?? p.buscaAtiva.status.toLowerCase()}
                        </Badge>
                      )}
                    </TD>
                    <TD className="text-sm">
                      {p.situacao}
                      {p.estratificacao && (
                        <span className="block">
                          <Badge tone={RESULT_TONE[p.estratificacao.result] ?? 'slate'}>{RESULT_LABEL[p.estratificacao.result] ?? p.estratificacao.result}</Badge>
                          <span className="ml-1 text-xs text-slate-500">
                            em {fmtDate(p.estratificacao.assessedAt)}
                            {p.estratificacao.nextDueAt ? ` · reavaliar até ${fmtDate(p.estratificacao.nextDueAt)}` : ''}
                          </span>
                        </span>
                      )}
                    </TD>
                    <TD className="text-xs">
                      {p.faltas.length === 0 ? (
                        <Badge tone="green">em dia</Badge>
                      ) : (
                        p.faltas.map((f) => (
                          <Badge key={f.codigo} tone="amber" className="mr-1 mb-1" title={f.descricao}>
                            {f.descricao.length > 60 ? `${f.descricao.slice(0, 60)}…` : f.descricao}
                          </Badge>
                        ))
                      )}
                    </TD>
                    <TD className="text-xs text-slate-700">{p.proximaAcao ?? '—'}</TD>
                    <TD className="whitespace-nowrap text-right">
                      {INSTRUMENTO[programa] && session.can('prontuario.evoluir') && (
                        <Button size="sm" variant="ghost" onClick={() => setEstrat({ patientId: p.patientId, nome: p.nome, kind: INSTRUMENTO[programa]! })}>
                          <Stethoscope className="h-4 w-4" /> Estratificar
                        </Button>
                      )}
                      {session.can('busca_ativa.gerir') && p.faltas.length > 0 && !p.buscaAtiva && (
                        <Button size="sm" variant="secondary" onClick={() => void buscaAtiva(p)} loading={busy === p.patientId}>
                          <UserRoundSearch className="h-4 w-4" /> Busca ativa
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      ) : null}
      {estrat && (
        <StratificationDialog
          patientId={estrat.patientId}
          patientName={estrat.nome}
          kind={estrat.kind}
          open
          onOpenChange={(o) => {
            if (!o) setEstrat(null);
          }}
          onSaved={() => void lista.reload()}
        />
      )}
    </div>
  );
}
