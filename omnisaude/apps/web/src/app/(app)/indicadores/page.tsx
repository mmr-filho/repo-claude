'use client';

import { ExternalLink, ListChecks, RefreshCw, Target } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { fmtDateTime, fmtMoney, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';

type Conceito = 'OTIMO' | 'BOM' | 'SUFICIENTE' | 'REGULAR';
type Fonte = 'DISPONIVEL' | 'PARCIAL' | 'SEM_FONTE';
interface ResultadoMes {
  competencia: string;
  valor: number | null;
  numerador: number;
  denominador: number;
  detalhe?: Record<string, { obtido: number; possivel: number }>;
}
interface AvaliacaoIndicador {
  codigo: string;
  titulo: string;
  peso: number;
  unidade: '%' | 'média';
  fonteApp: { situacao: Fonte; descricao: string };
  meses: ResultadoMes[];
  resultado: number | null;
  conceito: Conceito | null;
  nota: number;
}
interface Equipe {
  team: { id: string; ine: string; name: string; typeCode: string; typeLabel: string; unitId: string; unitName: string; modality: string | null; modalityLabel: string | null };
  bloco: string;
  pessoasVinculadas: number;
  membros: number;
  indicadores: AvaliacaoIndicador[];
  semResultado: string[];
  notaFinal: number;
  notaEstimada: number;
  classificacao: Conceito;
  valorMensal: number | null;
  repasseQuadrimestre: number | null;
  proximoNivel: { classificacao: Conceito; valorMensal: number; diferencaMensal: number } | null;
}
interface Painel {
  competencia: string;
  quadrimestre: { numero: number; ano: number; rotulo: string; meses: { competencia: string; ate: string; parcial: boolean }[] };
  geradoEm: string;
  equipes: Equipe[];
  totais: { equipes: number; porClassificacao: Record<Conceito, number>; valorMensal: number; repasseQuadrimestre: number; valorMensalSeProximoNivel: number };
}
interface BoaPratica {
  letra: string;
  descricao: string;
  pontos: number;
  fonte: Fonte;
  fonteDescricao: string;
  eapIntegral?: boolean;
}
interface Ficha {
  codigo: string;
  bloco: string;
  titulo: string;
  tituloCompleto: string;
  objetivo: string;
  numerador: string;
  denominador: string;
  unidade: '%' | 'média';
  janela: string;
  peso: number;
  parametroTexto: string;
  boasPraticas?: BoaPratica[];
  populacao?: string;
  fonteDados: string[];
  fonteApp: { situacao: Fonte; descricao: string };
  notaMetodologica: string;
}
interface Fichas {
  indicadores: Ficha[];
  pontuacaoConceito: Record<Conceito, number>;
  classificacaoNotaFinal: { classificacao: Conceito; regra: string }[];
  valores: Record<string, Record<Conceito, number>>;
  modalidades: Record<string, string>;
  referencias: { titulo: string; url: string }[];
}
interface Pendencias {
  competencia: string;
  ate: string;
  team: { id: string; name: string; ine: string; unitName: string };
  codigo: string;
  mes: ResultadoMes;
  pessoas: { patientId: string; nome: string; idade: number; sexo: string; pontos: number; maximo: number; faltam: { letra: string; descricao: string; pontos: number }[]; observacao?: string }[];
}

const CONCEITO_LABEL: Record<Conceito, string> = { OTIMO: 'Ótimo', BOM: 'Bom', SUFICIENTE: 'Suficiente', REGULAR: 'Regular' };
const CONCEITO_TONE: Record<Conceito, 'green' | 'blue' | 'amber' | 'red'> = { OTIMO: 'green', BOM: 'blue', SUFICIENTE: 'amber', REGULAR: 'red' };
const FONTE_LABEL: Record<Fonte, string> = { DISPONIVEL: 'apurado no sistema', PARCIAL: 'apurado em parte', SEM_FONTE: 'sem fonte ainda' };
const FONTE_TONE: Record<Fonte, 'green' | 'amber' | 'red'> = { DISPONIVEL: 'green', PARCIAL: 'amber', SEM_FONTE: 'red' };
const BLOCO_LABEL: Record<string, string> = { ESF_EAP: 'eSF e eAP', ESB: 'Saúde Bucal', EMULTI: 'eMulti' };
const NOMINAIS = ['C2', 'C3', 'C4', 'C5', 'C6', 'C7'];

const fmtValor = (v: number | null, unidade: '%' | 'média') =>
  v === null ? '—' : unidade === '%' ? `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : v.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const mesLabel = (c: string) => {
  const [y, m] = c.split('-');
  return `${m}/${y}`;
};

export default function IndicadoresPage() {
  const [competencia, setCompetencia] = useState(todayIso().slice(0, 7));
  const [unitId, setUnitId] = useState('');
  const [tab, setTab] = useState('painel');
  const [selected, setSelected] = useState<string | null>(null);
  const [pend, setPend] = useState<{ teamId: string; codigo: string } | null>(null);
  const painel = useApi<Painel>(`/indicadores-aps?competencia=${competencia}`);
  const fichas = useApi<Fichas>('/indicadores-aps/fichas');
  const pendencias = useApi<Pendencias>(pend ? `/indicadores-aps/pendencias?teamId=${pend.teamId}&codigo=${pend.codigo}&competencia=${competencia}` : null);

  const unidades = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of painel.data?.equipes ?? []) m.set(e.team.unitId, e.team.unitName);
    return [...m.entries()];
  }, [painel.data]);
  const equipes = (painel.data?.equipes ?? []).filter((e) => !unitId || e.team.unitId === unitId);
  const equipe = equipes.find((e) => e.team.id === selected) ?? null;
  const d = painel.data;

  function abrirPendencias(teamId: string, codigo: string) {
    setPend({ teamId, codigo });
    setTab('pendencias');
  }

  return (
    <div>
      <PageHeader
        title="Indicadores da APS"
        description="Componente de qualidade do cofinanciamento federal (Portaria GM/MS 3.493/2024): os 15 indicadores por equipe, resultado do quadrimestre, quem falta em cada boa prática e projeção do repasse."
        actions={
          <Button variant="secondary" onClick={() => void painel.reload()}>
            <RefreshCw className="h-4 w-4" /> Atualizar
          </Button>
        }
      />
      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Competência" htmlFor="ind-comp">
            <Input id="ind-comp" type="month" value={competencia} max={todayIso().slice(0, 7)} onChange={(e) => e.target.value && setCompetencia(e.target.value)} />
          </Field>
          <Field label="Unidade" htmlFor="ind-unit">
            <Select id="ind-unit" value={unitId} onChange={(e) => setUnitId(e.target.value)} className="w-64">
              <option value="">Todas as unidades</option>
              {unidades.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          {d && (
            <p className="text-sm text-slate-600">
              {d.quadrimestre.rotulo} · meses apurados: {d.quadrimestre.meses.map((m) => `${mesLabel(m.competencia)}${m.parcial ? ' (parcial)' : ''}`).join(', ')} · gerado em {fmtDateTime(d.geradoEm)}
            </p>
          )}
        </CardBody>
      </Card>
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'painel', label: 'Resultado por equipe' },
          { value: 'pendencias', label: 'Quem falta' },
          { value: 'fichas', label: 'Fichas técnicas' },
        ]}
      >
        <TabPanel value="painel">
          {painel.error && <Alert tone="error">{String(painel.error)}</Alert>}
          {painel.loading && !d ? (
            <Spinner />
          ) : d ? (
            <>
              <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
                <Stat label="Equipes avaliadas" value={equipes.length} />
                <Stat label="Repasse mensal projetado" value={fmtMoney(equipes.reduce((s, e) => s + (e.valorMensal ?? 0), 0))} hint="pela classificação atual" tone="good" />
                <Stat label="Próximo quadrimestre" value={fmtMoney(equipes.reduce((s, e) => s + (e.repasseQuadrimestre ?? 0), 0))} hint="4 parcelas mensais" />
                <Stat label="Se cada equipe subir um nível" value={fmtMoney(equipes.reduce((s, e) => s + (e.proximoNivel?.valorMensal ?? e.valorMensal ?? 0), 0))} hint="por mês" tone="warn" />
                <Stat
                  label="Classificação"
                  value={
                    <span className="flex flex-wrap gap-1 text-sm">
                      {(['OTIMO', 'BOM', 'SUFICIENTE', 'REGULAR'] as Conceito[]).map((c) => (
                        <Badge key={c} tone={CONCEITO_TONE[c]}>
                          {equipes.filter((e) => e.classificacao === c).length} {CONCEITO_LABEL[c].toLowerCase()}
                        </Badge>
                      ))}
                    </span>
                  }
                />
              </div>
              <Card className="mb-4">
                <CardHeader
                  title="Equipes"
                  description="Resultado do quadrimestre = média dos meses apurados. Nota final = soma dos pontos do conceito × peso (Nota Técnica 8/2026). Indicadores sem população ou sem fonte não entram na nota estimada."
                />
                {equipes.length === 0 ? (
                  <EmptyState icon={<Target className="h-8 w-8" />} title="Nenhuma equipe eSF, eAP, eSB ou eMulti ativa" description="Cadastre as equipes (INE) em Administração e vincule os domicílios às equipes." />
                ) : (
                  <Table>
                    <THead>
                      <TR>
                        <TH>Equipe</TH>
                        <TH>Vinculados</TH>
                        <TH>Indicadores</TH>
                        <TH>Nota</TH>
                        <TH>Classificação</TH>
                        <TH>Valor mensal</TH>
                        <TH>Próximo nível</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {equipes.map((e) => (
                        <TR key={e.team.id} className={selected === e.team.id ? 'bg-brand-50/40' : undefined}>
                          <TD>
                            <button type="button" className="text-left font-medium text-brand-700 underline" onClick={() => setSelected(e.team.id)}>
                              {e.team.name}
                            </button>
                            <span className="block text-xs text-slate-500">
                              {e.team.typeLabel} · INE {e.team.ine} · {e.team.unitName}
                              {e.team.modalityLabel ? ` · ${e.team.modalityLabel}` : ''}
                            </span>
                          </TD>
                          <TD>
                            {e.pessoasVinculadas}
                            <span className="block text-xs text-slate-500">{e.membros} profissionais</span>
                          </TD>
                          <TD className="text-xs">
                            {e.indicadores.map((i) => (
                              <Badge key={i.codigo} tone={i.conceito ? CONCEITO_TONE[i.conceito] : 'slate'} className="mr-1 mb-1" title={`${i.titulo}: ${i.conceito ? CONCEITO_LABEL[i.conceito] : 'sem resultado'}`}>
                                {i.codigo} {fmtValor(i.resultado, i.unidade)}
                              </Badge>
                            ))}
                          </TD>
                          <TD>
                            {e.notaEstimada.toLocaleString('pt-BR')}
                            {e.semResultado.length > 0 && <span className="block text-xs text-slate-500">estimada ({e.semResultado.join(', ')} sem resultado)</span>}
                          </TD>
                          <TD>
                            <Badge tone={CONCEITO_TONE[e.classificacao]}>{CONCEITO_LABEL[e.classificacao]}</Badge>
                          </TD>
                          <TD className="whitespace-nowrap">{e.valorMensal === null ? '—' : fmtMoney(e.valorMensal)}</TD>
                          <TD className="whitespace-nowrap text-xs">
                            {e.proximoNivel ? (
                              <>
                                {CONCEITO_LABEL[e.proximoNivel.classificacao]}: {fmtMoney(e.proximoNivel.valorMensal)}
                                <span className="block text-emerald-700">+{fmtMoney(e.proximoNivel.diferencaMensal)}/mês</span>
                              </>
                            ) : (
                              'nível máximo'
                            )}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </Card>
              {equipe && (
                <Card>
                  <CardHeader
                    title={`${equipe.team.name} · ${BLOCO_LABEL[equipe.bloco] ?? equipe.bloco}`}
                    description={`${equipe.pessoasVinculadas} pessoas vinculadas pelo domicílio · nota final ${equipe.notaFinal.toLocaleString('pt-BR')} de 10 (estimada ${equipe.notaEstimada.toLocaleString('pt-BR')}) · ${CONCEITO_LABEL[equipe.classificacao]}`}
                  />
                  <Table>
                    <THead>
                      <TR>
                        <TH>Indicador</TH>
                        {d.quadrimestre.meses.map((m) => (
                          <TH key={m.competencia}>{mesLabel(m.competencia)}</TH>
                        ))}
                        <TH>Quadrimestre</TH>
                        <TH>Conceito</TH>
                        <TH>Peso</TH>
                        <TH>Nota</TH>
                        <TH>Fonte no sistema</TH>
                        <TH></TH>
                      </TR>
                    </THead>
                    <TBody>
                      {equipe.indicadores.map((i) => (
                        <TR key={i.codigo}>
                          <TD>
                            <span className="font-medium">{i.codigo}</span> {i.titulo}
                          </TD>
                          {i.meses.map((m) => (
                            <TD key={m.competencia} className="text-sm" title={`${m.numerador} / ${m.denominador}`}>
                              {fmtValor(m.valor, i.unidade)}
                              <span className="block text-xs text-slate-500">
                                {m.numerador.toLocaleString('pt-BR')}/{m.denominador.toLocaleString('pt-BR')}
                              </span>
                            </TD>
                          ))}
                          <TD className="font-medium">{fmtValor(i.resultado, i.unidade)}</TD>
                          <TD>{i.conceito ? <Badge tone={CONCEITO_TONE[i.conceito]}>{CONCEITO_LABEL[i.conceito]}</Badge> : <Badge tone="slate">sem resultado</Badge>}</TD>
                          <TD>{i.peso}</TD>
                          <TD>{i.nota.toLocaleString('pt-BR')}</TD>
                          <TD className="max-w-xs text-xs">
                            <Badge tone={FONTE_TONE[i.fonteApp.situacao]}>{FONTE_LABEL[i.fonteApp.situacao]}</Badge>
                            <span className="mt-1 block text-slate-500">{i.fonteApp.descricao}</span>
                          </TD>
                          <TD className="whitespace-nowrap">
                            {NOMINAIS.includes(i.codigo) && (
                              <Button size="sm" variant="ghost" onClick={() => abrirPendencias(equipe.team.id, i.codigo)}>
                                <ListChecks className="h-4 w-4" /> Quem falta
                              </Button>
                            )}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                  {equipe.indicadores.some((i) => i.meses.some((m) => m.detalhe)) && (
                    <CardBody className="text-xs text-slate-600">
                      <p className="mb-1 font-medium text-slate-800">Boas práticas no último mês apurado (pessoas que cumpriram / pessoas avaliadas)</p>
                      {equipe.indicadores
                        .filter((i) => i.meses[i.meses.length - 1]?.detalhe)
                        .map((i) => {
                          const det = i.meses[i.meses.length - 1]!.detalhe!;
                          return (
                            <p key={i.codigo}>
                              <b>{i.codigo}</b>:{' '}
                              {Object.entries(det)
                                .map(([letra, v]) => `${letra} ${v.obtido}/${v.possivel}`)
                                .join(' · ')}
                            </p>
                          );
                        })}
                    </CardBody>
                  )}
                </Card>
              )}
            </>
          ) : null}
        </TabPanel>
        <TabPanel value="pendencias">
          <Card className="mb-4">
            <CardHeader title="Quem falta" description="Pessoas em acompanhamento na competência e as boas práticas que ainda não pontuaram. O acesso à lista nominal fica registrado na auditoria." />
            <CardBody className="flex flex-wrap items-end gap-3">
              <Field label="Equipe" htmlFor="pend-team">
                <Select id="pend-team" value={pend?.teamId ?? ''} onChange={(e) => setPend({ teamId: e.target.value, codigo: pend?.codigo ?? 'C4' })} className="w-72">
                  <option value="">Escolha a equipe</option>
                  {(d?.equipes ?? [])
                    .filter((e) => e.bloco === 'ESF_EAP')
                    .map((e) => (
                      <option key={e.team.id} value={e.team.id}>
                        {e.team.name} · {e.team.unitName}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Indicador" htmlFor="pend-ind">
                <Select id="pend-ind" value={pend?.codigo ?? 'C4'} onChange={(e) => setPend({ teamId: pend?.teamId ?? '', codigo: e.target.value })} className="w-80">
                  {(fichas.data?.indicadores ?? [])
                    .filter((f) => NOMINAIS.includes(f.codigo))
                    .map((f) => (
                      <option key={f.codigo} value={f.codigo}>
                        {f.codigo} · {f.titulo}
                      </option>
                    ))}
                </Select>
              </Field>
            </CardBody>
          </Card>
          {pend?.teamId && pendencias.loading && !pendencias.data ? <Spinner /> : null}
          {pendencias.data && pend?.teamId && (
            <Card>
              <CardHeader
                title={`${pendencias.data.team.name} · ${pendencias.data.codigo}`}
                description={`Até ${fmtDateTime(pendencias.data.ate)} · resultado do mês ${fmtValor(pendencias.data.mes.valor, '%')} (${pendencias.data.mes.denominador} pessoas avaliadas) · ${pendencias.data.pessoas.length} com pendência`}
              />
              {pendencias.data.pessoas.length === 0 ? (
                <EmptyState title="Ninguém com pendência" description="Todas as pessoas em acompanhamento já pontuaram as boas práticas apuráveis." />
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Pessoa</TH>
                      <TH>Pontos</TH>
                      <TH>Falta</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {pendencias.data.pessoas.map((p) => (
                      <TR key={p.patientId}>
                        <TD>
                          <a className="font-medium text-brand-700 underline" href={`/paciente?id=${p.patientId}`}>
                            {p.nome}
                          </a>
                          <span className="block text-xs text-slate-500">
                            {p.idade} anos · {p.sexo === 'F' ? 'feminino' : 'masculino'}
                            {p.observacao ? ` · ${p.observacao}` : ''}
                          </span>
                        </TD>
                        <TD className="whitespace-nowrap">
                          {p.pontos}/{p.maximo}
                        </TD>
                        <TD className="text-xs">
                          {p.faltam.map((f) => (
                            <Badge key={f.letra} tone="amber" className="mr-1 mb-1" title={f.descricao}>
                              {f.letra} · {f.descricao.length > 70 ? `${f.descricao.slice(0, 70)}…` : f.descricao} (+{f.pontos})
                            </Badge>
                          ))}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>
          )}
        </TabPanel>
        <TabPanel value="fichas">
          {fichas.data ? (
            <>
              <Card className="mb-4">
                <CardHeader
                  title="Como a nota é calculada"
                  description="Nota Técnica nº 8/2026-DEAPS/SAPS/MS: cada conceito vale pontos; a nota final é a soma dos pontos ponderada pelo peso (total 10) e define a classificação que paga o componente de qualidade por 4 meses."
                />
                <CardBody className="grid gap-4 text-sm md:grid-cols-3">
                  <div>
                    <p className="mb-1 font-medium">Pontos por conceito</p>
                    {(['OTIMO', 'BOM', 'SUFICIENTE', 'REGULAR'] as Conceito[]).map((c) => (
                      <p key={c}>
                        <Badge tone={CONCEITO_TONE[c]}>{CONCEITO_LABEL[c]}</Badge> {fichas.data!.pontuacaoConceito[c].toLocaleString('pt-BR')} × peso
                      </p>
                    ))}
                  </div>
                  <div>
                    <p className="mb-1 font-medium">Classificação pela nota final</p>
                    {fichas.data.classificacaoNotaFinal.map((c) => (
                      <p key={c.classificacao}>
                        <Badge tone={CONCEITO_TONE[c.classificacao]}>{CONCEITO_LABEL[c.classificacao]}</Badge> {c.regra}
                      </p>
                    ))}
                  </div>
                  <div>
                    <p className="mb-1 font-medium">Referências</p>
                    {fichas.data.referencias.map((r) => (
                      <p key={r.url}>
                        <a className="text-brand-700 underline" href={r.url} target="_blank" rel="noreferrer">
                          {r.titulo}
                        </a>
                      </p>
                    ))}
                  </div>
                </CardBody>
              </Card>
              <Card className="mb-4">
                <CardHeader title="Valor mensal do componente de qualidade" description="Portaria GM/MS 7.799/2025, anexo XCIX-B. A modalidade de cada equipe é definida em Administração › Equipes." />
                <Table>
                  <THead>
                    <TR>
                      <TH>Modalidade</TH>
                      {(['OTIMO', 'BOM', 'SUFICIENTE', 'REGULAR'] as Conceito[]).map((c) => (
                        <TH key={c}>{CONCEITO_LABEL[c]}</TH>
                      ))}
                    </TR>
                  </THead>
                  <TBody>
                    {Object.entries(fichas.data.valores).map(([mod, v]) => (
                      <TR key={mod}>
                        <TD>{fichas.data!.modalidades[mod] ?? mod}</TD>
                        {(['OTIMO', 'BOM', 'SUFICIENTE', 'REGULAR'] as Conceito[]).map((c) => (
                          <TD key={c} className="whitespace-nowrap">
                            {fmtMoney(v[c])}
                          </TD>
                        ))}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </Card>
              {fichas.data.indicadores.map((f) => (
                <Card key={f.codigo} className="mb-4">
                  <CardHeader
                    title={`${f.codigo} · ${f.titulo}`}
                    description={`${BLOCO_LABEL[f.bloco] ?? f.bloco} · peso ${f.peso} · ${f.janela}`}
                    actions={
                      <a className="inline-flex items-center gap-1 text-sm text-brand-700 underline" href={f.notaMetodologica} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-4 w-4" /> Nota metodológica
                      </a>
                    }
                  />
                  <CardBody className="grid gap-3 text-sm md:grid-cols-2">
                    <div>
                      <p className="font-medium">{f.tituloCompleto}</p>
                      <p className="text-slate-600">{f.objetivo}</p>
                      {f.populacao && (
                        <p className="mt-2">
                          <b>População:</b> {f.populacao}
                        </p>
                      )}
                      <p className="mt-2">
                        <b>Numerador:</b> {f.numerador}
                      </p>
                      <p>
                        <b>Denominador:</b> {f.denominador}
                      </p>
                      <p className="mt-2">
                        <b>Parâmetro:</b> {f.parametroTexto}
                      </p>
                      <p>
                        <b>Fonte oficial:</b> {f.fonteDados.join(' · ')}
                      </p>
                      <p className="mt-2">
                        <Badge tone={FONTE_TONE[f.fonteApp.situacao]}>{FONTE_LABEL[f.fonteApp.situacao]}</Badge> <span className="text-slate-600">{f.fonteApp.descricao}</span>
                      </p>
                    </div>
                    {f.boasPraticas && (
                      <Table>
                        <THead>
                          <TR>
                            <TH>Boa prática</TH>
                            <TH>Pontos</TH>
                            <TH>No sistema</TH>
                          </TR>
                        </THead>
                        <TBody>
                          {f.boasPraticas.map((bp) => (
                            <TR key={bp.letra}>
                              <TD className="text-xs">
                                <b>{bp.letra}</b> {bp.descricao}
                              </TD>
                              <TD>{bp.pontos}</TD>
                              <TD className="text-xs">
                                <Badge tone={FONTE_TONE[bp.fonte]}>{FONTE_LABEL[bp.fonte]}</Badge>
                                <span className="block text-slate-500">{bp.fonteDescricao}</span>
                              </TD>
                            </TR>
                          ))}
                        </TBody>
                      </Table>
                    )}
                  </CardBody>
                </Card>
              ))}
            </>
          ) : (
            <Spinner />
          )}
        </TabPanel>
      </Tabs>
    </div>
  );
}
