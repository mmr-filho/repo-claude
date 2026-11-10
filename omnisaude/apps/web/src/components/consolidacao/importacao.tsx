'use client';

import { ROTULO_CODIFICACAO, SISTEMA_INFO, type ArquivoJaImportado, type CodificacaoArquivo, type DetalheImportacao, type ListaImportacoes, type RespostaEnvioImportacao } from '@omnisaude/shared';
import { FileUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { ArquivosDetectados, DetalheDaImportacao } from './importacao-previa';
import { conferirArquivo, conferirPeriodo, consultaDoEnvio, detalhesDoErroDeEnvio, fmtBytes, jaImportado, situacaoImportacao } from './importacao-regras';

/** Erro do envio, com o que a API achou nos arquivos (quando não sobrou registro para importar). */
interface ErroDoEnvio {
  mensagem: string;
  detalhes: ReturnType<typeof detalhesDoErroDeEnvio>;
}

/** Arquivo enviado nesta tela: fica guardado para refazer a prévia com outra codificação. */
interface EnvioLocal {
  arquivo: File;
  de: string;
  ate: string;
}

function ComoExportar() {
  return (
    <details className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
      <summary className="cursor-pointer font-medium text-slate-800">Como exportar dos sistemas oficiais</summary>
      <ul className="mt-2 list-inside list-disc space-y-1">
        <li>Sinan Net: as notificações individuais (NINDINET), o DBF de investigação de cada agravo, as negativas (NNEGANET) e os surtos (NSURTNET). Envie o zip ou o DBF.</li>
        <li>Sinan Online: dengue (DENGON) e chikungunya (CHIKON), um arquivo por ano; o período não cruza o ano. A mesma solicitação em menos de 24 horas devolve o mesmo arquivo.</li>
        <li>e-SUS Notifica: o CSV exportado com o perfil de gestor municipal, um arquivo por ano de notificação.</li>
        <li>e-SUS Sinan: o CSV exportado por agravo.</li>
        <li>O tipo do arquivo é reconhecido pelo conteúdo, não pelo nome. Telefone, e-mail, endereço e notificante são descartados na leitura.</li>
        <li>A exportação identificada é dado sensível: a prévia e as listas da conciliação ficam na auditoria.</li>
      </ul>
    </details>
  );
}

/** Lista das importações (a mais recente primeiro). */
function Historico({ lista, aberta, onAbrir }: { lista: ReturnType<typeof useApi<ListaImportacoes>>; aberta: string | null; onAbrir: (id: string) => void }) {
  return (
    <Card>
      <CardHeader title="Importações" description="As 200 mais recentes. A prévia expira se não for aplicada a tempo." />
      {lista.loading && !lista.data ? (
        <Spinner />
      ) : lista.error ? (
        <CardBody>
          <Alert tone="error">{lista.error}</Alert>
        </CardBody>
      ) : !lista.data?.length ? (
        <EmptyState title="Nenhuma importação ainda" description="Envie a primeira exportação acima." />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Enviada em</TH>
              <TH>Arquivo</TH>
              <TH>Sistema</TH>
              <TH>Situação</TH>
              <TH>Período</TH>
              <TH className="text-right">Novos</TH>
              <TH className="text-right">Alterados</TH>
              <TH className="text-right">Recusados</TH>
              <TH />
            </tr>
          </THead>
          <TBody>
            {lista.data.map((r) => {
              const s = situacaoImportacao(r);
              return (
                <TR key={r.id} className={aberta === r.id ? 'bg-brand-50' : undefined}>
                  <TD className="whitespace-nowrap text-sm">
                    {fmtDateTime(r.criadoEm)}
                    {r.criadoPor && <span className="block text-xs text-slate-500">{r.criadoPor}</span>}
                  </TD>
                  <TD className="text-sm">
                    <span className="break-all">{r.arquivo}</span>
                    <span className="block text-xs text-slate-500">{fmtBytes(r.tamanhoBytes)}</span>
                  </TD>
                  <TD className="text-sm">{SISTEMA_INFO[r.sistema]?.label ?? r.sistema}</TD>
                  <TD>
                    <Badge tone={s.tom}>{s.rotulo}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-xs">{r.periodo ? `${fmtDate(r.periodo.de)} a ${fmtDate(r.periodo.ate)}` : '—'}</TD>
                  <TD className="text-right tabular-nums">{r.contagens.novos?.toLocaleString('pt-BR') ?? '—'}</TD>
                  <TD className="text-right tabular-nums">{r.contagens.alterados?.toLocaleString('pt-BR') ?? '—'}</TD>
                  <TD className="text-right tabular-nums">{r.contagens.recusados?.toLocaleString('pt-BR') ?? '—'}</TD>
                  <TD className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => onAbrir(r.id)} aria-label={`Abrir a importação ${r.arquivo}`}>
                      Abrir
                    </Button>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

/**
 * Importação das exportações oficiais (Sinan Net, Sinan Online, e-SUS Sinan, e-SUS Notifica): envio do arquivo cru
 * (zip, DBF ou CSV), prévia com as contagens e as amostras, aplicar e descartar, histórico. Permissão
 * `vigilancia.importar` (a aba só aparece com ela).
 */
export function AbaImportacao() {
  const toast = useToast();
  const lista = useApi<ListaImportacoes>('/vigilancia/importacoes');
  const entrada = useRef<HTMLInputElement>(null);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [periodo, setPeriodo] = useState({ de: '', ate: '' });
  const [codificacao, setCodificacao] = useState<CodificacaoArquivo | ''>('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<ErroDoEnvio | null>(null);
  const [ja, setJa] = useState<ArquivoJaImportado['jaImportado'] | null>(null);
  const [aberta, setAberta] = useState<{ id: string; inicial: DetalheImportacao | null } | null>(null);
  const [envio, setEnvio] = useState<(EnvioLocal & { id: string }) | null>(null);
  const detalhe = useRef<HTMLDivElement>(null);
  // O detalhe abre acima do histórico: leva a tela até ele.
  useEffect(() => {
    if (aberta?.id) detalhe.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [aberta?.id]);

  const problemaArquivo = arquivo ? conferirArquivo(arquivo) : null;
  const problemaPeriodo = conferirPeriodo(periodo.de, periodo.ate);

  async function enviar(local: EnvioLocal, cod: CodificacaoArquivo | '') {
    setEnviando(true);
    setErro(null);
    setJa(null);
    try {
      const r = await api.post<RespostaEnvioImportacao>(`/vigilancia/importacoes${consultaDoEnvio({ nome: local.arquivo.name, de: local.de, ate: local.ate, codificacao: cod })}`, local.arquivo, {
        raw: true,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (jaImportado(r)) {
        setJa(r.jaImportado);
        setAberta(null);
        setEnvio(null);
      } else {
        setAberta({ id: r.id, inicial: r });
        setEnvio({ ...local, id: r.id });
        toast.success('Prévia pronta: confira e aplique.');
      }
      setArquivo(null);
      if (entrada.current) entrada.current.value = '';
      void lista.reload();
    } catch (err) {
      setErro({ mensagem: errorMessage(err), detalhes: err instanceof ApiError ? detalhesDoErroDeEnvio(err.details) : detalhesDoErroDeEnvio(null) });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Enviar uma exportação" description="Zip, DBF ou CSV de até 95 MB. Nada é gravado antes de você conferir a prévia e aplicar." />
        <CardBody className="space-y-4">
          <form
            className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto] xl:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (arquivo && !problemaArquivo && !problemaPeriodo) void enviar({ arquivo, de: periodo.de, ate: periodo.ate }, codificacao);
            }}
          >
            <Field label="Arquivo" htmlFor="imp-arquivo" error={problemaArquivo}>
              <Input id="imp-arquivo" ref={entrada} type="file" accept=".zip,.dbf,.csv,application/zip,text/csv" onChange={(e) => setArquivo(e.target.files?.[0] ?? null)} />
            </Field>
            <Field label="Período da exportação: de" htmlFor="imp-de" error={problemaPeriodo}>
              <Input id="imp-de" type="date" value={periodo.de} onChange={(e) => setPeriodo({ ...periodo, de: e.target.value })} />
            </Field>
            <Field label="até" htmlFor="imp-ate">
              <Input id="imp-ate" type="date" value={periodo.ate} onChange={(e) => setPeriodo({ ...periodo, ate: e.target.value })} />
            </Field>
            <Field label="Codificação" htmlFor="imp-cod">
              <Select id="imp-cod" value={codificacao} onChange={(e) => setCodificacao(e.target.value as CodificacaoArquivo | '')}>
                <option value="">Automática</option>
                {(Object.keys(ROTULO_CODIFICACAO) as CodificacaoArquivo[]).map((c) => (
                  <option key={c} value={c}>
                    {ROTULO_CODIFICACAO[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" loading={enviando} disabled={!arquivo || !!problemaArquivo || !!problemaPeriodo}>
              <FileUp className="h-4 w-4" /> Enviar e ver a prévia
            </Button>
          </form>
          <p className="text-xs text-slate-500">
            O período é opcional: informe o período pedido na exportação. É ele que define quais registros do banco &quot;não vieram&quot; (ausentes). Sem ele, vale o das datas de notificação lidas.
          </p>
          {ja && (
            <Alert tone="info" title="Este arquivo já foi importado">
              O mesmo arquivo (mesmo conteúdo) foi aplicado em {fmtDateTime(ja.aplicadoEm)}. Nada foi criado.{' '}
              <Button variant="link" size="sm" className="h-auto" onClick={() => setAberta({ id: ja.id, inicial: null })}>
                Abrir a importação
              </Button>
            </Alert>
          )}
          {erro && (
            <Alert tone="error" title="O envio não gerou prévia">
              <p>{erro.mensagem}</p>
              {erro.detalhes.motivos.length > 0 && (
                <ul className="mt-1 list-inside list-disc">
                  {erro.detalhes.motivos.map((m) => (
                    <li key={m.motivo}>
                      {m.motivo}: {m.quantidade.toLocaleString('pt-BR')}
                    </li>
                  ))}
                </ul>
              )}
            </Alert>
          )}
          {erro && erro.detalhes.arquivos.length > 0 && <ArquivosDetectados arquivos={erro.detalhes.arquivos} />}
          <ComoExportar />
        </CardBody>
      </Card>

      {aberta && (
        <div ref={detalhe} className="scroll-mt-4">
          <DetalheDaImportacao
            key={aberta.id}
            id={aberta.id}
            inicial={aberta.inicial}
            podeReprocessar={envio?.id === aberta.id}
            reprocessando={enviando}
            onReprocessar={(cod) => envio && void enviar(envio, cod)}
            onMudou={() => void lista.reload()}
            onFechar={() => setAberta(null)}
          />
        </div>
      )}

      <Historico lista={lista} aberta={aberta?.id ?? null} onAbrir={(id) => setAberta({ id, inicial: null })} />
    </div>
  );
}
