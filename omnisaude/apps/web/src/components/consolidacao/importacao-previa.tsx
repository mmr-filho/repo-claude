'use client';

import {
  ROTULO_CODIFICACAO,
  ROTULO_SITUACAO_CASO,
  ROTULO_TIPO_ARQUIVO,
  ROTULO_TIPO_REGISTRO,
  SISTEMA_INFO,
  type AmostraAlteracao,
  type AmostraRegistro,
  type ArquivoDetectado,
  type CodificacaoArquivo,
  type DetalheImportacao,
  type ResultadoAplicacao,
  type ResultadoDescarte,
} from '@omnisaude/shared';
import { CheckCircle2, RefreshCw, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { codificacoesParaTrocar, fmtBytes, linhasDasContagens, motivosOrdenados, resumoDaAplicacao, ROTULO_ORIGEM_CODIFICACAO, situacaoImportacao, textoExpiracao, textoPorTipo } from './importacao-regras';

const TOM_CONTAGEM = { default: 'text-slate-900', good: 'text-emerald-700', warn: 'text-amber-700', bad: 'text-red-700' } as const;

/** Arquivos que vieram no envio (o zip pode trazer vários), com o tipo detectado pelo conteúdo e a codificação. */
export function ArquivosDetectados({ arquivos }: { arquivos: ArquivoDetectado[] }) {
  if (!arquivos.length) return null;
  return (
    <Table>
      <caption className="sr-only">Arquivos do envio</caption>
      <THead>
        <tr>
          <TH>Arquivo</TH>
          <TH>Tipo detectado</TH>
          <TH className="text-right">Registros</TH>
          <TH>Codificação</TH>
          <TH>Notificações de</TH>
          <TH>Agravos</TH>
        </tr>
      </THead>
      <TBody>
        {arquivos.map((a, i) => (
          <TR key={`${a.nome}-${i}`}>
            <TD className="text-sm">
              <span className="font-medium">{a.nome}</span>
              <span className="block text-xs text-slate-500">{fmtBytes(a.tamanhoBytes)}</span>
              {a.identificado && (
                <Badge tone="violet" className="mt-1">
                  Com identificação do paciente
                </Badge>
              )}
              {a.ignorado && (
                <Badge tone="slate" className="mt-1">
                  Ignorado
                </Badge>
              )}
              {a.avisos.length > 0 && (
                <ul className="mt-1 list-inside list-disc text-xs text-amber-800">
                  {a.avisos.map((av) => (
                    <li key={av}>{av}</li>
                  ))}
                </ul>
              )}
            </TD>
            <TD className="text-sm">{ROTULO_TIPO_ARQUIVO[a.tipo] ?? a.tipo}</TD>
            <TD className="text-right tabular-nums">{a.registros.toLocaleString('pt-BR')}</TD>
            <TD className="text-xs">
              {a.codificacao ? ROTULO_CODIFICACAO[a.codificacao] : '—'}
              {a.origemCodificacao && <span className="block text-slate-500">{ROTULO_ORIGEM_CODIFICACAO[a.origemCodificacao]}</span>}
            </TD>
            <TD className="whitespace-nowrap text-xs">{a.periodo ? `${fmtDate(a.periodo.de)} a ${fmtDate(a.periodo.ate)}` : '—'}</TD>
            <TD className="text-xs">{a.agravos.length ? a.agravos.join(', ') : '—'}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function TabelaAmostras({ itens, alteracoes }: { itens: AmostraRegistro[]; alteracoes?: boolean }) {
  if (!itens.length) return <EmptyState title="Nenhum registro nesta lista" />;
  return (
    <Table>
      <THead>
        <tr>
          <TH>Número</TH>
          <TH>Notificação</TH>
          <TH>Agravo</TH>
          <TH>CNES</TH>
          <TH>Paciente</TH>
          <TH>Situação</TH>
          {alteracoes && <TH>O que muda</TH>}
        </tr>
      </THead>
      <TBody>
        {itens.map((a, i) => (
          <TR key={`${a.tipo}|${a.chave}|${i}`}>
            <TD className="whitespace-nowrap tabular-nums">
              {a.numero}
              {a.tipo !== 'INDIVIDUAL' && (
                <Badge tone="slate" className="ml-1">
                  {ROTULO_TIPO_REGISTRO[a.tipo]}
                </Badge>
              )}
            </TD>
            <TD className="whitespace-nowrap text-sm">{fmtDate(a.notificadoEm)}</TD>
            <TD className="text-sm">{a.grupo ?? a.agravo ?? '—'}</TD>
            <TD className="tabular-nums text-sm">{a.cnes ?? '—'}</TD>
            <TD className="text-sm">{a.paciente ?? (a.sigiloso ? <Badge tone="violet">Sigiloso</Badge> : <span className="text-slate-400">—</span>)}</TD>
            <TD className="text-sm">{ROTULO_SITUACAO_CASO[a.situacao]}</TD>
            {alteracoes && (
              <TD className="text-xs">
                <ul className="space-y-0.5">
                  {(a as AmostraAlteracao).campos.map((c) => (
                    <li key={c.campo}>
                      <span className="font-medium">{c.campo}</span>: {c.antes ?? 'vazio'} → {c.depois ?? 'vazio'}
                    </li>
                  ))}
                </ul>
              </TD>
            )}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

/** Amostras da prévia (até 200 por lista): novos, alterados, recusados, duplicados no arquivo e ausentes previstos. */
function Amostras({ d }: { d: DetalheImportacao }) {
  const [aba, setAba] = useState('novos');
  const p = d.previa;
  if (!p) return null;
  const n = (x: number) => x.toLocaleString('pt-BR');
  return (
    <Card>
      <CardHeader title="Amostras da prévia" description="Até 200 linhas por lista. A lista nominal fica registrada na auditoria." />
      <CardBody>
        <Tabs
          value={aba}
          onValueChange={setAba}
          tabs={[
            { value: 'novos', label: `Novos (${n(d.contagens.novos)})` },
            { value: 'alterados', label: `Alterados (${n(d.contagens.alterados)})` },
            { value: 'recusados', label: `Recusados (${n(d.contagens.recusados)})` },
            { value: 'duplicados', label: `Duplicados (${n(d.contagens.duplicadosNoArquivo)})` },
            { value: 'ausentes', label: `Ausentes (${n(d.contagens.ausentesPrevistos)})` },
          ]}
        >
          <TabPanel value="novos">
            <TabelaAmostras itens={p.novos} />
          </TabPanel>
          <TabPanel value="alterados">
            <TabelaAmostras itens={p.alterados} alteracoes />
          </TabPanel>
          <TabPanel value="recusados">
            {p.recusados.length ? (
              <Table>
                <THead>
                  <tr>
                    <TH>Arquivo</TH>
                    <TH className="text-right">Linha</TH>
                    <TH>Número</TH>
                    <TH>Motivo</TH>
                  </tr>
                </THead>
                <TBody>
                  {p.recusados.map((r, i) => (
                    <TR key={`${r.arquivo}-${r.linha}-${i}`}>
                      <TD className="text-sm">{r.arquivo}</TD>
                      <TD className="text-right tabular-nums">{r.linha}</TD>
                      <TD className="tabular-nums">{r.numero ?? '—'}</TD>
                      <TD className="text-sm">{r.motivo}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <EmptyState title="Nenhum registro recusado" />
            )}
          </TabPanel>
          <TabPanel value="duplicados">
            {p.duplicados.length ? (
              <Table>
                <THead>
                  <tr>
                    <TH>Arquivo</TH>
                    <TH>Chave</TH>
                    <TH>Linhas</TH>
                    <TH>Ficou</TH>
                  </tr>
                </THead>
                <TBody>
                  {p.duplicados.map((x) => (
                    <TR key={`${x.arquivo}-${x.chave}`}>
                      <TD className="text-sm">{x.arquivo}</TD>
                      <TD className="font-mono text-xs">{x.chave}</TD>
                      <TD className="tabular-nums text-sm">{x.linhas.join(', ')}</TD>
                      <TD className="tabular-nums text-sm">linha {x.mantida} (a mais completa)</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <EmptyState title="Nenhuma chave repetida no envio" />
            )}
          </TabPanel>
          <TabPanel value="ausentes">
            <p className="mb-2 text-xs text-slate-500">Registros do mesmo sistema, tipo, agravos e período que estão no banco e não vieram. Ao aplicar, ficam marcados como ausentes (não são apagados).</p>
            <TabelaAmostras itens={p.ausentes} />
          </TabPanel>
        </Tabs>
      </CardBody>
    </Card>
  );
}

/**
 * Detalhe de uma importação: arquivos detectados, contagens, avisos e, na prévia, as amostras, a troca de codificação
 * (reenvia o arquivo, que ainda está na tela) e os botões de aplicar e descartar.
 */
export function DetalheDaImportacao({
  id,
  inicial,
  podeReprocessar,
  reprocessando,
  onReprocessar,
  onMudou,
  onFechar,
}: {
  id: string;
  /** A resposta do envio (evita ler de novo a prévia nominal, que é auditada a cada leitura). */
  inicial?: DetalheImportacao | null;
  /** O arquivo enviado ainda está na tela: dá para trocar a codificação. */
  podeReprocessar: boolean;
  reprocessando: boolean;
  onReprocessar: (codificacao: CodificacaoArquivo) => void;
  onMudou: () => void;
  onFechar: () => void;
}) {
  const toast = useToast();
  const [d, setD] = useState<DetalheImportacao | null>(inicial ?? null);
  const [erro, setErro] = useState<string | null>(null);
  const [confirmar, setConfirmar] = useState<'aplicar' | 'descartar' | null>(null);
  const [busy, setBusy] = useState(false);
  const [resultado, setResultado] = useState<ResultadoAplicacao | null>(null);
  const [codificacao, setCodificacao] = useState<CodificacaoArquivo | ''>('');

  const carregar = useCallback(async () => {
    try {
      setD(await api.get<DetalheImportacao>(`/vigilancia/importacoes/${id}`));
      setErro(null);
    } catch (err) {
      setErro(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    if (!inicial) void carregar();
  }, [carregar, inicial]);

  async function agir(acao: 'aplicar' | 'descartar') {
    setBusy(true);
    try {
      if (acao === 'aplicar') {
        const r = await api.post<ResultadoAplicacao>(`/vigilancia/importacoes/${id}/aplicar`);
        setResultado(r);
        toast.success('Importação aplicada.');
      } else {
        await api.post<ResultadoDescarte>(`/vigilancia/importacoes/${id}/descartar`);
        toast.success('Prévia descartada.');
      }
      setConfirmar(null);
      await carregar();
      onMudou();
    } catch (err) {
      toast.error(errorMessage(err));
      setConfirmar(null);
      await carregar();
      onMudou();
    } finally {
      setBusy(false);
    }
  }

  if (!d) return erro ? <Alert tone="error">{erro}</Alert> : <Spinner />;
  const situacao = situacaoImportacao(d);
  const previa = d.status === 'PREVIA';
  const expira = previa ? textoExpiracao(d.expiraEm, new Date()) : null;
  const trocas = previa && podeReprocessar ? codificacoesParaTrocar(d.arquivos) : [];
  const motivos = motivosOrdenados(d.contagens.motivosRecusa ?? {});
  const porTipo = textoPorTipo(d.contagens.porTipo ?? {});

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={d.arquivo}
          description={`${SISTEMA_INFO[d.sistema]?.label ?? d.sistema} · ${fmtBytes(d.tamanhoBytes)} · enviado em ${fmtDateTime(d.criadoEm)}${d.criadoPor ? ` por ${d.criadoPor}` : ''}`}
          actions={
            <>
              {previa && (
                <>
                  <Button size="sm" variant="success" onClick={() => setConfirmar('aplicar')}>
                    <CheckCircle2 className="h-4 w-4" /> Aplicar
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setConfirmar('descartar')}>
                    <XCircle className="h-4 w-4" /> Descartar
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" onClick={onFechar} aria-label="Fechar o detalhe">
                <X className="h-4 w-4" />
              </Button>
            </>
          }
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
            <Badge tone={situacao.tom}>{situacao.rotulo}</Badge>
            {d.periodo && (
              <span>
                Período: {fmtDate(d.periodo.de)} a {fmtDate(d.periodo.ate)} {d.periodoDeclarado ? '(declarado no envio)' : '(pelas datas de notificação lidas)'}
              </span>
            )}
            {d.identificado && <Badge tone="violet">Com identificação do paciente</Badge>}
            <span className="font-mono text-xs text-slate-500" title={d.sha256}>
              SHA-256 {d.sha256.slice(0, 12)}…
            </span>
          </div>
          {d.aplicadoEm && (
            <p className="text-sm text-slate-700">
              Aplicada em {fmtDateTime(d.aplicadoEm)}
              {d.aplicadoPor ? ` por ${d.aplicadoPor}` : ''}.
            </p>
          )}
          {d.descartadoEm && (
            <p className="text-sm text-slate-700">
              {d.expirada ? 'Prévia expirada' : 'Descartada'} em {fmtDateTime(d.descartadoEm)}
              {d.descartadoPor ? ` por ${d.descartadoPor}` : ''}.
            </p>
          )}
          {expira && <Alert tone={expira.startsWith('A prévia expirou') ? 'warn' : 'info'}>{expira} Confira as contagens e as amostras antes de aplicar.</Alert>}
          {resultado && (
            <Alert tone="success" title="Importação aplicada">
              <ul className="list-inside list-disc">
                {resumoDaAplicacao(resultado).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              {resultado.avisos.length > 0 && (
                <ul className="mt-2 list-inside list-disc text-amber-900">
                  {resultado.avisos.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              )}
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
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {linhasDasContagens(d.contagens).map((c) => (
              <div key={c.chave} className="rounded-lg border border-slate-200 px-3 py-2">
                <dt className="text-xs text-slate-500">{c.rotulo}</dt>
                <dd className={`text-xl font-semibold ${TOM_CONTAGEM[c.tom]}`}>{c.valor.toLocaleString('pt-BR')}</dd>
                {c.dica && <dd className="text-[11px] leading-tight text-slate-500">{c.dica}</dd>}
              </div>
            ))}
          </dl>
          {porTipo && <p className="text-sm text-slate-700">Por tipo: {porTipo}.</p>}
          {motivos.length > 0 && (
            <div className="text-sm">
              <p className="font-medium text-slate-700">Motivos de recusa</p>
              <ul className="mt-1 list-inside list-disc text-slate-700">
                {motivos.map((m) => (
                  <li key={m.motivo}>
                    {m.motivo}: <span className="tabular-nums">{m.quantidade.toLocaleString('pt-BR')}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {trocas.length > 0 && (
            <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-3">
              <Field label="Acentos trocados? Leia com outra codificação" htmlFor="imp-trocar-cod" className="min-w-64">
                <Select id="imp-trocar-cod" value={codificacao} onChange={(e) => setCodificacao(e.target.value as CodificacaoArquivo | '')}>
                  <option value="">Escolha a codificação</option>
                  {trocas.map((c) => (
                    <option key={c} value={c}>
                      {ROTULO_CODIFICACAO[c]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button variant="secondary" disabled={!codificacao} loading={reprocessando} onClick={() => codificacao && onReprocessar(codificacao)}>
                <RefreshCw className="h-4 w-4" /> Refazer a prévia
              </Button>
              <p className="w-full text-xs text-slate-500">O arquivo é lido de novo com a codificação escolhida; esta prévia é descartada.</p>
            </div>
          )}
          {previa && !podeReprocessar && <p className="text-xs text-slate-500">Para trocar a codificação, envie o arquivo de novo escolhendo a codificação no envio.</p>}
          <ArquivosDetectados arquivos={d.arquivos} />
        </CardBody>
      </Card>

      <Amostras d={d} />

      <Dialog
        open={confirmar !== null}
        onOpenChange={(o) => !o && setConfirmar(null)}
        title={confirmar === 'aplicar' ? 'Aplicar a importação' : 'Descartar a prévia'}
        description={
          confirmar === 'aplicar'
            ? 'Grava os registros novos e os alterados, marca como ausentes os do período que não vieram, liga as unidades pelo CNES, roda a conciliação automática e confere os atestos de notificação negativa. Fica na auditoria.'
            : 'A prévia e os registros lidos são apagados. Para importar depois, envie o arquivo de novo.'
        }
        footer={
          <Button variant={confirmar === 'aplicar' ? 'success' : 'danger'} loading={busy} onClick={() => confirmar && agir(confirmar)}>
            {confirmar === 'aplicar' ? 'Aplicar' : 'Descartar'}
          </Button>
        }
      >
        {confirmar === 'aplicar' ? (
          <p className="text-sm text-slate-700">
            {d.contagens.novos.toLocaleString('pt-BR')} novo(s), {d.contagens.alterados.toLocaleString('pt-BR')} alterado(s), {d.contagens.ausentesPrevistos.toLocaleString('pt-BR')} ausente(s) previsto(s)
            {d.contagens.recusados ? ` e ${d.contagens.recusados.toLocaleString('pt-BR')} recusado(s), que ficam de fora` : ''}.
          </p>
        ) : (
          <p className="text-sm text-slate-700">Nada é gravado nos registros oficiais.</p>
        )}
      </Dialog>
    </div>
  );
}
