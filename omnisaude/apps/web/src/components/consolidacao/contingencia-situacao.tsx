'use client';

import { ROTULO_STATUS_ACAO, ROTULO_STATUS_SEMANA, ROTULO_TIPO_CRITERIO, type AcaoChecklist, type AcionamentoResumo, type RespostaManualCriterio, type SituacaoContingencia, type StatusAcao } from '@omnisaude/shared';
import { Siren } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateTime } from '@/lib/format';
import { ContingenciaAcionar } from './contingencia-acionar';
import {
  checklistPorEixo,
  classeDoEstagio,
  criteriosPorEstagio,
  dataBr,
  exigenciaDoCriterio,
  manuaisDaSemana,
  nomeDoEstagio,
  patchAcao,
  progressoChecklist,
  resumoIndicadores,
  rotuloSemana,
  situacaoDoCriterio,
  textoSugestao,
  textoValor,
  TOM_STATUS_ACAO,
  ultimasSemanas,
  type TerritorioDaContingencia,
} from './contingencia-regras';
import { TOM_STATUS, textoSemanas } from './diagrama-dados';
import { nomeDoAgravo, type OpcaoAgravo } from './diagrama-agravos';

/** Selo do estágio com a cor da posição no plano e o nome escrito. */
export function SeloEstagio({ plano, chave, nome, grande }: { plano: SituacaoContingencia['plano']; chave: string; nome?: string; grande?: boolean }) {
  return <Badge className={cn(classeDoEstagio(plano?.definicao ?? null, chave), grande && 'px-3 py-1 text-sm font-semibold')}>{nome ?? nomeDoEstagio(plano?.definicao ?? null, chave)}</Badge>;
}

/** Resposta da vigilância a um critério manual na semana de referência. */
function RespostaManual({
  criterioId,
  resposta,
  semana,
  territorio,
  podeAgir,
  onMudou,
}: {
  criterioId: string;
  resposta: RespostaManualCriterio | null;
  semana: string;
  territorio: TerritorioDaContingencia;
  podeAgir: boolean;
  onMudou: () => void;
}) {
  const toast = useToast();
  const [nota, setNota] = useState(resposta?.nota ?? '');
  const [busy, setBusy] = useState<boolean | null>(null);
  async function responder(atendido: boolean) {
    setBusy(atendido);
    try {
      await api.post<RespostaManualCriterio>('/vigilancia/contingencia/respostas', { semana, criterio: criterioId, atendido, nota: nota.trim() || null, nivel: territorio.nivel, territorio: territorio.territorio });
      toast.success(`Resposta da SE ${rotuloSemana(semana)} gravada.`);
      onMudou();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="space-y-1.5">
      <p className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        {resposta ? (
          <>
            <Badge tone={resposta.atendido ? 'red' : 'green'}>{resposta.atendido ? 'Atendido' : 'Não atendido'}</Badge>
            <span>
              {resposta.respondidoPor ?? 'Vigilância'}, {fmtDateTime(resposta.respondidoEm)}
              {resposta.nota ? `. ${resposta.nota}` : ''}
            </span>
          </>
        ) : (
          <Badge tone="slate">Sem resposta na semana: não avaliado</Badge>
        )}
      </p>
      {podeAgir && (
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="Nota da resposta" className="h-8 max-w-xs text-xs" value={nota} maxLength={1000} onChange={(e) => setNota(e.target.value)} placeholder="Nota (opcional): fonte do dado" />
          <Button size="sm" variant="secondary" loading={busy === true} disabled={busy !== null} onClick={() => responder(true)}>
            Atendido
          </Button>
          <Button size="sm" variant="secondary" loading={busy === false} disabled={busy !== null} onClick={() => responder(false)}>
            Não atendido
          </Button>
        </div>
      )}
    </div>
  );
}

/** Uma ação do checklist: situação, responsável e nota. */
function LinhaAcao({ a, podeAgir, planoDoEstagio, onSalvo }: { a: AcaoChecklist; podeAgir: boolean; planoDoEstagio: SituacaoContingencia['plano']; onSalvo: (nova: AcaoChecklist) => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<StatusAcao>(a.status);
  const [responsavel, setResponsavel] = useState(a.responsavel ?? '');
  const [nota, setNota] = useState(a.nota ?? '');
  const [busy, setBusy] = useState(false);
  const patch = patchAcao(a, { status, responsavel, nota });
  return (
    <TR>
      <TD className="min-w-[16rem]">
        <span className="block text-sm text-slate-900">{a.descricao}</span>
        <span className="mt-1 inline-flex flex-wrap gap-1">
          <SeloEstagio plano={planoDoEstagio} chave={a.estagio} />
        </span>
        {a.atualizadoPor && (
          <span className="mt-0.5 block text-[11px] text-slate-500">
            Atualizada por {a.atualizadoPor} em {fmtDateTime(a.atualizadoEm)}
          </span>
        )}
      </TD>
      <TD className="min-w-[10rem]">
        {podeAgir ? (
          <Select aria-label="Situação da ação" className="h-8 text-xs" value={status} onChange={(e) => setStatus(e.target.value as StatusAcao)}>
            {(Object.keys(ROTULO_STATUS_ACAO) as StatusAcao[]).map((s) => (
              <option key={s} value={s}>
                {ROTULO_STATUS_ACAO[s]}
              </option>
            ))}
          </Select>
        ) : (
          <Badge tone={TOM_STATUS_ACAO[a.status]}>{ROTULO_STATUS_ACAO[a.status]}</Badge>
        )}
      </TD>
      <TD className="min-w-[10rem]">
        {podeAgir ? <Input aria-label="Responsável" className="h-8 text-xs" maxLength={200} value={responsavel} onChange={(e) => setResponsavel(e.target.value)} /> : (a.responsavel ?? '—')}
      </TD>
      <TD className="min-w-[12rem]">{podeAgir ? <Input aria-label="Nota" className="h-8 text-xs" maxLength={1000} value={nota} onChange={(e) => setNota(e.target.value)} /> : (a.nota ?? '—')}</TD>
      {podeAgir && (
        <TD className="text-right">
          <Button
            size="sm"
            variant={patch ? 'primary' : 'secondary'}
            disabled={!patch}
            loading={busy}
            onClick={async () => {
              if (!patch) return;
              setBusy(true);
              try {
                const nova = await api.patch<AcaoChecklist>(`/vigilancia/contingencia/acoes/${a.id}`, { ...patch });
                onSalvo(nova);
                toast.success('Ação atualizada.');
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Salvar
          </Button>
        </TD>
      )}
    </TR>
  );
}

function Checklist({ s, podeAgir }: { s: SituacaoContingencia; podeAgir: boolean }) {
  // As ações salvas ficam aqui até a próxima leitura da situação (sem recarregar a tela inteira a cada ação).
  const [salvas, setSalvas] = useState<Record<string, AcaoChecklist>>({});
  const lista = useMemo(
    () =>
      s.checklist.map((a) => {
        const x = salvas[a.id];
        return x && Date.parse(x.atualizadoEm) >= Date.parse(a.atualizadoEm) ? x : a;
      }),
    [s.checklist, salvas],
  );
  const grupos = checklistPorEixo(lista, s.plano?.definicao ?? null);
  const p = progressoChecklist(lista);
  return (
    <Card>
      <CardHeader
        title="Checklist de ações do estágio em vigor"
        description={`As ações do estágio e dos anteriores ("manter e intensificar"). ${p.feitas} de ${p.total} feitas; ${p.emAndamento} em andamento; ${p.pendentes} pendentes.`}
      />
      {grupos.map((g) => (
        <div key={g.eixo} className="border-t border-slate-100">
          <p className="flex items-center justify-between gap-2 bg-slate-50 px-5 py-2 text-sm font-medium text-slate-800">
            {g.rotulo}
            <span className="text-xs font-normal text-slate-600">
              {g.feitas} de {g.total} feitas
            </span>
          </p>
          <Table>
            <THead>
              <tr>
                <TH>Ação</TH>
                <TH>Situação</TH>
                <TH>Responsável</TH>
                <TH>Nota</TH>
                {podeAgir && <TH className="text-right">Gravar</TH>}
              </tr>
            </THead>
            <TBody>
              {g.acoes.map((a) => (
                <LinhaAcao key={`${a.id}-${a.atualizadoEm}`} a={a} podeAgir={podeAgir} planoDoEstagio={s.plano} onSalvo={(nova) => setSalvas((x) => ({ ...x, [nova.id]: nova }))} />
              ))}
            </TBody>
          </Table>
        </div>
      ))}
    </Card>
  );
}

function Historico({ s, opcoes }: { s: SituacaoContingencia; opcoes: OpcaoAgravo[] }) {
  if (!s.historico.length) return null;
  return (
    <Card>
      <CardHeader title="Histórico de acionamentos" description="Vigências sem sobreposição: cada acionamento fecha o anterior na véspera." />
      <Table>
        <THead>
          <tr>
            <TH>Estágio</TH>
            <TH>Vigência</TH>
            <TH>Justificativa e ato</TH>
            <TH>Decisão</TH>
            <TH>Indicadores no acionamento</TH>
          </tr>
        </THead>
        <TBody>
          {s.historico.map((h: AcionamentoResumo) => (
            <TR key={h.id}>
              <TD>
                <SeloEstagio plano={s.plano} chave={h.estagio} nome={h.estagioNome} />
              </TD>
              <TD className="whitespace-nowrap text-xs">
                {dataBr(h.inicio)} (SE {rotuloSemana(h.semanaInicio)})<span className="block">{h.fim ? `até ${dataBr(h.fim)}${h.semanaFim ? ` (SE ${rotuloSemana(h.semanaFim)})` : ''}` : 'em vigor'}</span>
              </TD>
              <TD className="max-w-md text-xs">
                {h.justificativa}
                {h.ato && <span className="mt-0.5 block text-slate-600">Ato: {h.ato}</span>}
              </TD>
              <TD className="text-xs">
                {h.decididoPor ?? '—'}
                <span className="block text-slate-500">{fmtDateTime(h.decididoEm)}</span>
              </TD>
              <TD className="text-xs">
                {h.indicadores.length ? (
                  <details>
                    <summary className="cursor-pointer">{h.indicadores.length} agravo(s)</summary>
                    <ul className="mt-1 space-y-0.5">
                      {h.indicadores.map((i) => (
                        <li key={i.grupo}>
                          {nomeDoAgravo(opcoes, i.grupo)}: {i.provaveis} prováveis, {i.graves + i.sinaisAlarme} graves ou com sinais de alarme, {i.obitosAgravo} óbito(s)
                          {i.obitosInvestigacao ? `, ${i.obitosInvestigacao} em investigação` : ''}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  '—'
                )}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

/**
 * Situação da semana: estágio em vigor, sugestão pelos critérios do plano (o sistema sugere; a vigilância decide),
 * critérios com valor e detalhe, indicadores do ano, respostas manuais, checklist e histórico.
 */
export function ContingenciaSituacao({ s, podeAgir, territorio, opcoes, onMudou }: { s: SituacaoContingencia; podeAgir: boolean; territorio: TerritorioDaContingencia; opcoes: OpcaoAgravo[]; onMudou: () => void }) {
  const [acionar, setAcionar] = useState(false);
  const definicao = s.plano?.definicao ?? null;
  const grupos = definicao ? criteriosPorEstagio(definicao, s.avaliacao) : [];
  const manuais = definicao ? manuaisDaSemana(definicao, s.respostas, s.semanaReferencia) : [];
  const ref = rotuloSemana(s.semanaReferencia);

  return (
    <div className="space-y-4">
      {s.avisos.length > 0 && (
        <Alert tone="warn" title="Avisos">
          <ul className="list-inside list-disc space-y-0.5">
            {s.avisos.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={`Estágio em vigor · ${s.territorio.nome}`} />
          <CardBody className="space-y-2 pt-4 text-sm text-slate-700">
            <SeloEstagio plano={s.plano} chave={s.estagioAtual.chave} nome={s.estagioAtual.nome} grande />
            <p>{s.estagioAtual.desde ? `Desde ${dataBr(s.estagioAtual.desde)}.` : 'Sem acionamento registrado: vale a normalidade.'}</p>
            <p className="text-xs text-slate-600">{s.plano ? `Plano em vigor: ${s.plano.nome} (versão ${s.plano.versao}), desde ${dataBr(s.plano.vigenteDesde)}.` : 'Nenhum plano em vigor.'}</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title={`Sugestão da SE ${ref}`}
            description="Última semana completa. O sistema sugere; a vigilância avalia e decide o acionamento."
            actions={
              podeAgir && s.plano ? (
                <Button size="sm" onClick={() => setAcionar(true)}>
                  <Siren className="h-4 w-4" /> Acionar estágio
                </Button>
              ) : undefined
            }
          />
          <CardBody className="space-y-2 pt-4 text-sm text-slate-700">
            {s.avaliacao && definicao ? (
              <>
                <SeloEstagio plano={s.plano} chave={s.avaliacao.sugerido} grande />
                <p>{textoSugestao(definicao, s.estagioAtual.chave, s.avaliacao)}</p>
                <p className="text-xs text-slate-600">
                  Critérios atendidos:{' '}
                  {Object.entries(s.avaliacao.porEstagio)
                    .filter(([chave]) => definicao.criterios.some((c) => c.estagio === chave))
                    .map(([chave, n]) => `${nomeDoEstagio(definicao, chave)} ${n}`)
                    .join(' · ')}
                </p>
              </>
            ) : (
              <p>Sem plano em vigor, não há sugestão. Crie um rascunho do modelo do MS na aba Plano e ponha em vigor.</p>
            )}
            {s.semanasIncompletas.length > 0 && <p className="text-xs text-slate-600">Semanas incompletas (atraso de notificação, fora da avaliação): {textoSemanas(s.semanasIncompletas)}.</p>}
          </CardBody>
        </Card>
      </div>

      {definicao && (
        <Card>
          <CardHeader title={`Critérios do plano na SE ${ref}`} description="Um resultado por agravo nos critérios automáticos. Critério manual sem resposta na semana fica sem avaliação, nunca atendido." />
          <Table>
            <THead>
              <tr>
                <TH>Critério</TH>
                <TH>Agravo</TH>
                <TH>Situação</TH>
                <TH>Valor</TH>
                <TH>Detalhe</TH>
              </tr>
            </THead>
            <TBody>
              {grupos.map((g) => (
                <Fragment key={g.estagio.chave}>
                  <tr className="bg-slate-50">
                    <td colSpan={5} className="px-3 py-2">
                      <span className="flex flex-wrap items-center gap-2 text-sm">
                        <SeloEstagio plano={s.plano} chave={g.estagio.chave} />
                        <span className="text-slate-600">{g.atendidos} critério(s) atendido(s)</span>
                      </span>
                    </td>
                  </tr>
                  {g.itens.map((item) => {
                    const linhas = item.avaliacoes.length ? item.avaliacoes : [null];
                    return linhas.map((a, i) => {
                      const sit = situacaoDoCriterio(a?.atendido ?? null);
                      return (
                        <TR key={`${item.criterio.id}-${a?.agravo ?? i}`}>
                          {i === 0 && (
                            <TD rowSpan={linhas.length} className="max-w-sm">
                              <span className="block text-sm text-slate-900">{item.criterio.descricao}</span>
                              <span className="block text-xs text-slate-600">
                                {ROTULO_TIPO_CRITERIO[item.criterio.tipo]} · {exigenciaDoCriterio(item.criterio)}
                              </span>
                              {item.criterio.fonte && <span className="block text-[11px] text-slate-500">{item.criterio.fonte}</span>}
                            </TD>
                          )}
                          <TD className="whitespace-nowrap text-xs">
                            {a?.agravo ? nomeDoAgravo(opcoes, a.agravo) : item.criterio.agravos.length ? item.criterio.agravos.map((g2) => nomeDoAgravo(opcoes, g2)).join(', ') : 'Todos'}
                          </TD>
                          <TD>
                            <Badge tone={sit.tom}>{sit.texto}</Badge>
                          </TD>
                          <TD className="whitespace-nowrap tabular-nums">{textoValor(item.criterio.tipo, a?.valor)}</TD>
                          <TD className="text-xs text-slate-700">{a?.detalhe ?? 'Sem avaliação (sem plano em vigor).'}</TD>
                        </TR>
                      );
                    });
                  })}
                </Fragment>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      {manuais.length > 0 && (
        <Card>
          <CardHeader
            title={`Critérios avaliados pela vigilância na SE ${ref}`}
            description="Nowcasting, positividade laboratorial, sorotipo e atendimentos não são calculados pelo sistema: a vigilância responde toda semana (InfoDengue, Lacen, unidades)."
          />
          <ul className="divide-y divide-slate-100">
            {manuais.map((m) => (
              <li key={m.criterio.id} className="space-y-1.5 px-5 py-3">
                <p className="flex flex-wrap items-center gap-2 text-sm text-slate-900">
                  {m.estagio && <SeloEstagio plano={s.plano} chave={m.estagio.chave} />}
                  {m.criterio.descricao}
                  {m.criterio.agravos.length > 0 && <span className="text-xs text-slate-500">({m.criterio.agravos.map((g) => nomeDoAgravo(opcoes, g)).join(', ')})</span>}
                </p>
                <RespostaManual
                  key={`${m.criterio.id}-${m.resposta?.respondidoEm ?? 'nada'}`}
                  criterioId={m.criterio.id}
                  resposta={m.resposta}
                  semana={s.semanaReferencia}
                  territorio={territorio}
                  podeAgir={podeAgir && !!s.plano}
                  onMudou={onMudou}
                />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {s.indicadores.length > 0 && (
        <Card>
          <CardHeader title="Indicadores do ano epidemiológico" description={`Até a SE ${ref}. Gravidade e óbitos em investigação vêm dos registros oficiais importados.`} />
          <CardBody className="grid gap-4 pt-4 md:grid-cols-2 xl:grid-cols-3">
            {s.indicadores.map((ind) => (
              <div key={ind.grupo} className="space-y-2 rounded-lg border border-slate-200 p-3">
                <p className="font-medium text-slate-900">{nomeDoAgravo(opcoes, ind.grupo)}</p>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  {resumoIndicadores(ind).map((x) => (
                    <Fragment key={x.rotulo}>
                      <dt className="text-slate-600">{x.rotulo}</dt>
                      <dd className="text-right font-medium tabular-nums text-slate-900">{x.valor}</dd>
                    </Fragment>
                  ))}
                </dl>
                <div>
                  <p className="mb-1 text-[11px] text-slate-600">Últimas semanas no canal</p>
                  <ul className="flex flex-wrap gap-1">
                    {ultimasSemanas(ind).map((w) => (
                      <li key={w.semana}>
                        <Badge
                          tone={TOM_STATUS[w.status]}
                          className={cn(!w.completa && 'border border-dashed border-slate-400')}
                          title={`SE ${w.rotulo}: ${ROTULO_STATUS_SEMANA[w.status]}${w.completa ? '' : ' (incompleta)'}`}
                        >
                          {w.rotulo.slice(0, 2)}
                          <span className="sr-only">
                            : {ROTULO_STATUS_SEMANA[w.status]}
                            {w.completa ? '' : ', incompleta'}
                          </span>
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </CardBody>
          <CardBody className="border-t border-slate-100 py-3 text-[11px] text-slate-600">
            Cores das semanas: {(['ABAIXO_LI', 'ATE_CENTRO', 'ENTRE_CENTRO_E_LS', 'ACIMA_LS', 'SEM_CANAL'] as const).map((st) => ROTULO_STATUS_SEMANA[st]).join(' · ')}. Borda tracejada: semana incompleta.
          </CardBody>
        </Card>
      )}

      {s.checklist.length > 0 ? (
        <Checklist key={s.estagioAtual.acionamentoId ?? 'nenhum'} s={s} podeAgir={podeAgir} />
      ) : (
        <Card>
          <CardBody className="text-sm text-slate-600">
            {s.estagioAtual.acionamentoId ? 'O acionamento em vigor não tem ações no plano.' : 'Sem acionamento em vigor: o checklist de ações nasce quando a vigilância aciona um estágio.'}
          </CardBody>
        </Card>
      )}

      <Historico s={s} opcoes={opcoes} />

      {acionar && s.plano && <ContingenciaAcionar s={s} territorio={territorio} onFechar={() => setAcionar(false)} onAcionado={onMudou} />}
    </div>
  );
}
