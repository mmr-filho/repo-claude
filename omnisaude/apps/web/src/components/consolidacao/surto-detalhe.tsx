'use client';

import { CATEGORIA_SURTO, DELIMITACAO_SURTO, LOCAL_INICIAL_SURTO, ROTULO_EVENTO_SURTO, ROTULO_STATUS_SURTO, type DetalheSurto, type TipoEventoSurto } from '@omnisaude/shared';
import { ArrowLeft, Ban, CheckCheck, Hash, Megaphone } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { OpcaoAgravo } from './diagrama-agravos';
import { ComunicarSurto, DescartarSurto, EncerrarSurto, NumeroSinanSurto } from './surto-acoes';
import { SurtoFicha } from './surto-ficha';
import { PrazosSurto } from './surto-lista';
import { SurtoPlanilha } from './surto-planilha';
import { comunicacoesDoSurto, dataBr, ROTULO_CANAL_COMUNICACAO, textoEvento, TOM_STATUS_SURTO } from './surto-regras';

type Acao = 'encerrar' | 'descartar' | 'numero' | 'comunicar';

/** Eventos que mudam os campos da ficha: só eles recarregam o formulário (incluir caso não apaga a edição em curso). */
const MUDAM_A_FICHA: TipoEventoSurto[] = ['EDITADO', 'INVESTIGADO', 'ENCERRADO', 'DESCARTADO'];

function Dado({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{rotulo}</dt>
      <dd className="text-sm text-slate-900">{children}</dd>
    </div>
  );
}

function Comunicacoes({ d, podeComunicar, onComunicar }: { d: DetalheSurto; podeComunicar: boolean; onComunicar: () => void }) {
  const lista = comunicacoesDoSurto(d.eventos);
  return (
    <Card>
      <CardHeader
        title="Comunicações"
        description={d.esp ? 'Com ESP: comunicação imediata à SMS, à SES e ao MS.' : 'Comunicação imediata à SMS (24 h do conhecimento).'}
        actions={
          podeComunicar ? (
            <Button size="sm" onClick={onComunicar}>
              <Megaphone className="h-4 w-4" /> Registrar comunicação
            </Button>
          ) : undefined
        }
      />
      <CardBody className="space-y-3 pt-3">
        <PrazosSurto prazos={d.prazos} />
        {lista.length === 0 ? (
          <p className="text-sm text-slate-600">Nenhuma comunicação registrada.</p>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Quando</TH>
                <TH>Para</TH>
                <TH>Meio</TH>
                <TH>Com quem</TH>
                <TH>Protocolo</TH>
                <TH>Nota</TH>
                <TH>Registrado por</TH>
              </tr>
            </THead>
            <TBody>
              {lista.map((c) => (
                <TR key={c.id}>
                  <TD className="whitespace-nowrap tabular-nums">{fmtDateTime(c.em)}</TD>
                  <TD>
                    <Badge tone="blue">{c.alvo}</Badge>
                  </TD>
                  <TD>{ROTULO_CANAL_COMUNICACAO[c.canal as keyof typeof ROTULO_CANAL_COMUNICACAO] ?? c.canal}</TD>
                  <TD>{c.contraparte}</TD>
                  <TD>{c.protocolo ?? '—'}</TD>
                  <TD className="text-xs">{c.nota ?? '—'}</TD>
                  <TD className="text-xs">
                    {c.por ?? '—'}
                    <span className="block text-slate-500">{fmtDateTime(c.registradoEm)}</span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}

function LinhaDoTempo({ d }: { d: DetalheSurto }) {
  const eventos = [...d.eventos].reverse();
  return (
    <Card>
      <CardHeader title="Linha do tempo" description="Do mais recente para o mais antigo." />
      <ol className="divide-y divide-slate-100">
        {eventos.map((e) => (
          <li key={e.id} className="flex flex-wrap items-start gap-3 px-5 py-3 text-sm">
            <span className="w-36 shrink-0 text-xs tabular-nums text-slate-600">{fmtDateTime(e.em)}</span>
            <Badge tone="slate" className="shrink-0">
              {ROTULO_EVENTO_SURTO[e.tipo]}
            </Badge>
            <span className="min-w-[12rem] flex-1 text-slate-800">
              {textoEvento(e)}
              {e.por && <span className="block text-xs text-slate-500">{e.por}</span>}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Espelho({ d }: { d: DetalheSurto }) {
  const e = d.espelho;
  const colunas = e.planilha.length ? Object.keys(e.planilha[0]!) : [];
  return (
    <div className="space-y-4">
      {e.avisos.length > 0 && (
        <Alert tone="warn" title="Antes de digitar no Sinan Net">
          <ul className="list-inside list-disc space-y-0.5">
            {e.avisos.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </Alert>
      )}
      <Card>
        <CardHeader title="Notificação e investigação de surto" description="Variáveis do dicionário de dados do Sinan Net (surto v5), como vão para a digitação." />
        <Table>
          <THead>
            <tr>
              <TH>Variável</TH>
              <TH>Campo</TH>
              <TH>Valor</TH>
            </tr>
          </THead>
          <TBody>
            {e.campos.map((c) => (
              <TR key={c.variavel}>
                <TD className="font-mono text-xs">{c.variavel}</TD>
                <TD className="text-xs text-slate-700">{c.rotulo}</TD>
                <TD>{c.valor ?? <span className="text-slate-400">em branco</span>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <Card>
        <CardHeader title="Planilha de acompanhamento" description="Os valores da planilha em códigos do Sinan (1 sim, 2 não, 9 ignorado)." />
        {e.planilha.length === 0 ? (
          <CardBody className="pt-3 text-sm text-slate-600">Planilha vazia.</CardBody>
        ) : (
          <Table className="text-xs">
            <THead>
              <tr>
                {colunas.map((c) => (
                  <TH key={c} className="font-mono normal-case">
                    {c}
                  </TH>
                ))}
              </tr>
            </THead>
            <TBody>
              {e.planilha.map((linha, i) => (
                <TR key={i}>
                  {colunas.map((c) => (
                    <TD key={c} className="tabular-nums">
                      {linha[c] ?? ''}
                    </TD>
                  ))}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {e.dta.length > 0 && (
        <Card>
          <CardHeader title="Ficha de DTA" />
          <Table>
            <THead>
              <tr>
                <TH>Variável</TH>
                <TH>Campo</TH>
                <TH>Valor</TH>
              </tr>
            </THead>
            <TBody>
              {e.dta.map((c) => (
                <TR key={c.variavel}>
                  <TD className="font-mono text-xs">{c.variavel}</TD>
                  <TD className="text-xs text-slate-700">{c.rotulo}</TD>
                  <TD>{c.valor ?? <span className="text-slate-400">em branco</span>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

/** Notificação de surto aberta: dados, prazos, pendências e avisos, ficha, planilha, comunicações, linha do tempo e espelho. */
export function SurtoDetalhe({ id, opcoes, onVoltar, onMudou }: { id: string; opcoes: OpcaoAgravo[]; onVoltar: () => void; onMudou: () => void }) {
  const session = useSession();
  // A vigilância municipal (papel com `vigilancia.consolidacao`) comunica também à SES e ao MS; a API confere o papel.
  const municipal = session.can('vigilancia.consolidacao');
  const r = useApi<DetalheSurto>(`/vigilancia/surtos/${id}`);
  const [secao, setSecao] = useState('ficha');
  const [acao, setAcao] = useState<Acao | null>(null);
  const d = r.data && r.data.id === id ? r.data : null;
  const atualizar = (novo: DetalheSurto) => {
    r.setData(novo);
    setAcao(null);
    onMudou();
  };
  const recarregar = () => {
    void r.reload();
    onMudou();
  };

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onVoltar}>
        <ArrowLeft className="h-4 w-4" /> Voltar à lista
      </Button>
      {r.error && <Alert tone="error">{r.error}</Alert>}
      {!d && r.loading && <Spinner label="Abrindo o surto…" />}
      {d && (
        <>
          <Card>
            <CardHeader
              title={`Surto ${d.numero} · ${d.agravo}`}
              description={`${CATEGORIA_SURTO[d.categoria]} · ${d.unidade.nome} (CNES ${d.unidade.cnes})`}
              actions={
                <>
                  <Badge tone={TOM_STATUS_SURTO[d.status]}>{ROTULO_STATUS_SURTO[d.status]}</Badge>
                  {d.esp && <Badge tone="red">ESP</Badge>}
                  {d.status !== 'DESCARTADO' && (
                    <Button size="sm" variant="secondary" onClick={() => setAcao('comunicar')}>
                      <Megaphone className="h-4 w-4" /> Comunicar
                    </Button>
                  )}
                  {d.permissoes.numeroOficial && (
                    <Button size="sm" variant="secondary" onClick={() => setAcao('numero')}>
                      <Hash className="h-4 w-4" /> Número do Sinan
                    </Button>
                  )}
                  {d.permissoes.encerrar && (
                    <Button size="sm" variant="success" onClick={() => setAcao('encerrar')}>
                      <CheckCheck className="h-4 w-4" /> Encerrar
                    </Button>
                  )}
                  {d.permissoes.descartar && (
                    <Button size="sm" variant="danger" onClick={() => setAcao('descartar')}>
                      <Ban className="h-4 w-4" /> Descartar
                    </Button>
                  )}
                </>
              }
            />
            <CardBody className="space-y-4 pt-4">
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
                <Dado rotulo="Notificado em">{dataBr(d.notificadoEm)}</Dado>
                <Dado rotulo="A vigilância soube em">{fmtDateTime(d.conhecidoEm)}</Dado>
                <Dado rotulo="Primeiros sintomas do 1º caso">{dataBr(d.primeirosSintomasEm)}</Dado>
                <Dado rotulo="Casos (informados / na planilha)">
                  {d.casos} / {d.planilha.length}
                </Dado>
                <Dado rotulo="Local inicial">
                  {d.localInicial} - {LOCAL_INICIAL_SURTO[d.localInicial] ?? '?'}
                  {d.localInicialTexto ? `: ${d.localInicialTexto}` : ''}
                </Dado>
                <Dado rotulo="Número do Sinan">{d.numeroOficial ?? 'ainda não digitado'}</Dado>
                <Dado rotulo="Notificado por">{d.notificador ?? '—'}</Dado>
                <Dado rotulo="Agente etiológico">{d.agente ?? '—'}</Dado>
                {d.status === 'ENCERRADO' && (
                  <Dado rotulo="Encerramento">
                    {dataBr(d.encerradoEm)}
                    {d.delimitacao ? ` · ${d.delimitacao} - ${DELIMITACAO_SURTO[d.delimitacao] ?? '?'}${d.delimitacaoTexto ? `: ${d.delimitacaoTexto}` : ''}` : ''}
                    {d.notasEncerramento && <span className="block text-xs text-slate-600">{d.notasEncerramento}</span>}
                  </Dado>
                )}
                {d.descarte && (
                  <Dado rotulo="Descarte">
                    {fmtDateTime(d.descarte.em)}
                    {d.descarte.por ? ` por ${d.descarte.por}` : ''}
                    <span className="block text-xs text-slate-600">{d.descarte.motivo}</span>
                  </Dado>
                )}
              </dl>
              <div className="space-y-1">
                <p className="text-xs text-slate-500">Prazos da comunicação imediata</p>
                <PrazosSurto prazos={d.prazos} />
              </div>
              {d.pendencias.length > 0 && (
                <Alert tone="warn" title={d.status === 'ABERTO' ? 'Pendências para encerrar' : 'Pendências'}>
                  <ul className="list-inside list-disc space-y-0.5">
                    {d.pendencias.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </Alert>
              )}
              {d.avisos.length > 0 && (
                <Alert tone="warn" title="Avisos">
                  <ul className="list-inside list-disc space-y-0.5">
                    {d.avisos.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                </Alert>
              )}
            </CardBody>
          </Card>
          <Tabs
            value={secao}
            onValueChange={setSecao}
            tabs={[
              { value: 'ficha', label: 'Ficha' },
              { value: 'planilha', label: `Planilha de casos (${d.planilha.length})` },
              { value: 'comunicacoes', label: 'Comunicações' },
              { value: 'tempo', label: 'Linha do tempo' },
              { value: 'espelho', label: 'Espelho do Sinan' },
            ]}
          >
            <TabPanel value="ficha">
              <SurtoFicha key={`${d.id}-${d.status}-${d.eventos.filter((e) => MUDAM_A_FICHA.includes(e.tipo)).length}`} d={d} opcoes={opcoes} onSalvo={atualizar} />
            </TabPanel>
            <TabPanel value="planilha">
              <SurtoPlanilha d={d} onMudou={recarregar} />
            </TabPanel>
            <TabPanel value="comunicacoes">
              <Comunicacoes d={d} podeComunicar={d.status !== 'DESCARTADO'} onComunicar={() => setAcao('comunicar')} />
            </TabPanel>
            <TabPanel value="tempo">
              <LinhaDoTempo d={d} />
            </TabPanel>
            <TabPanel value="espelho">
              <Espelho d={d} />
            </TabPanel>
          </Tabs>
          {acao === 'encerrar' && <EncerrarSurto d={d} onFechar={() => setAcao(null)} onFeito={atualizar} />}
          {acao === 'descartar' && <DescartarSurto d={d} onFechar={() => setAcao(null)} onFeito={atualizar} />}
          {acao === 'numero' && <NumeroSinanSurto d={d} onFechar={() => setAcao(null)} onFeito={atualizar} />}
          {acao === 'comunicar' && <ComunicarSurto d={d} municipal={municipal} onFechar={() => setAcao(null)} onFeito={atualizar} />}
        </>
      )}
    </div>
  );
}
