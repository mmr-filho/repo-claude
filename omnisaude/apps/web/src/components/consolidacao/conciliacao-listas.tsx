'use client';

import {
  ROTULO_GRAVIDADE,
  ROTULO_METODO_VINCULO,
  ROTULO_SITUACAO_CASO,
  ROTULO_TIPO_REGISTRO,
  type FiltroConciliacao,
  type ListaDivergentes,
  type ListaSoOficial,
  type ListaSoOmnisaude,
  type ListaSugestoesVinculo,
  type NotificacaoParaConciliar,
  type PaginaConciliacao,
  type RegistroOficialResumo,
  type RespostaOk,
  type RespostaVincular,
} from '@omnisaude/shared';
import { ChevronLeft, ChevronRight, Link2, Link2Off, Search, ThumbsDown } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { consultaConciliacao, MOTIVO_MAXIMO, MOTIVO_MINIMO, motivoValido, podePreencherNumero, rotuloSistema, temPaginaSeguinte, textoDaPagina, textoDivergencia, textoPaciente } from './conciliacao-regras';

// ─── Células ────────────────────────────────────────────────────────────────

/** Registro oficial numa célula: número, sistema, agravo, data e situação. */
function CelulaRegistro({ r }: { r: RegistroOficialResumo }) {
  return (
    <div className="space-y-0.5 text-sm">
      <p className="font-medium tabular-nums text-slate-900">
        {r.numero}
        <span className="ml-1.5 text-xs font-normal text-slate-500">{rotuloSistema(r.sistema)}</span>
        {r.tipo !== 'INDIVIDUAL' && (
          <Badge tone="slate" className="ml-1.5">
            {ROTULO_TIPO_REGISTRO[r.tipo]}
          </Badge>
        )}
      </p>
      <p className="text-slate-700">{r.agravoNome ?? r.grupo ?? r.agravo ?? 'Agravo não identificado'}</p>
      <p className="text-xs text-slate-500">
        Notificado em {fmtDate(r.notificadoEm)}
        {r.semanaNotificacao ? ` (SE ${r.semanaNotificacao.slice(4)}/${r.semanaNotificacao.slice(0, 4)})` : ''} · {r.unidade.nome ?? (r.unidade.cnes ? `CNES ${r.unidade.cnes}` : 'unidade não informada')}
      </p>
      <p className="text-xs text-slate-600">{textoPaciente(r.paciente, r.sigiloso)}</p>
      <p className="flex flex-wrap gap-1">
        <Badge tone="slate">{ROTULO_SITUACAO_CASO[r.situacao]}</Badge>
        {r.gravidade && <Badge tone="amber">{ROTULO_GRAVIDADE[r.gravidade]}</Badge>}
        {r.sigiloso && <Badge tone="violet">Sigiloso</Badge>}
        {r.ausenteDesde && <Badge tone="amber">Não veio na última exportação ({fmtDate(r.ausenteDesde)})</Badge>}
      </p>
    </div>
  );
}

/** Notificação do OmniSaúde numa célula: número, agravo, data, unidade e o número oficial, se já tem. */
function CelulaNotificacao({ n }: { n: NotificacaoParaConciliar }) {
  return (
    <div className="space-y-0.5 text-sm">
      <p className="font-medium tabular-nums text-slate-900">
        {n.numero}
        <span className="ml-1.5 text-xs font-normal text-slate-500">{n.status === 'ENCERRADA' ? 'Encerrada' : 'Notificada'}</span>
      </p>
      <p className="text-slate-700">{n.agravo}</p>
      <p className="text-xs text-slate-500">
        Notificada em {fmtDate(n.notificadaEm)}
        {n.inicioSintomas ? ` · sintomas em ${fmtDate(n.inicioSintomas)}` : ''} · {n.unidade.nome}
      </p>
      <p className="text-xs text-slate-600">{textoPaciente(n.paciente, n.sigilosa)}</p>
      <p className="flex flex-wrap gap-1">
        <Badge tone="slate">{ROTULO_SITUACAO_CASO[n.situacao]}</Badge>
        {n.sigilosa && <Badge tone="violet">Sigilosa</Badge>}
        <Badge tone={n.numeroOficial ? 'blue' : 'slate'}>{n.numeroOficial ? `${rotuloSistema(n.sistemaOficial)} nº ${n.numeroOficial}` : `${rotuloSistema(n.sistemaOficial)}: sem número`}</Badge>
      </p>
    </div>
  );
}

function Paginacao({ p, onPagina }: { p: PaginaConciliacao<unknown>; onPagina: (pagina: number) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-2 text-sm text-slate-600">
      <span>{textoDaPagina(p)}</span>
      <span className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={p.pagina <= 1} onClick={() => onPagina(p.pagina - 1)} aria-label="Página anterior">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="secondary" disabled={!temPaginaSeguinte(p)} onClick={() => onPagina(p.pagina + 1)} aria-label="Próxima página">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </span>
    </div>
  );
}

// ─── Diálogos ───────────────────────────────────────────────────────────────

/** Motivo obrigatório (desvincular, "não é o mesmo caso"). */
function DialogoMotivo({
  aberto,
  titulo,
  descricao,
  botao,
  onFechar,
  onConfirmar,
}: {
  aberto: boolean;
  titulo: string;
  descricao: string;
  botao: string;
  onFechar: () => void;
  onConfirmar: (motivo: string) => Promise<void>;
}) {
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  return (
    <Dialog
      open={aberto}
      onOpenChange={(o) => !o && onFechar()}
      title={titulo}
      description={descricao}
      footer={
        <Button
          variant="danger"
          loading={busy}
          disabled={!motivoValido(motivo)}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              await onConfirmar(motivo.trim());
              setMotivo('');
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {botao}
        </Button>
      }
    >
      <Field label={`Motivo (mínimo de ${MOTIVO_MINIMO} caracteres)`} htmlFor="conc-motivo">
        <Textarea id="conc-motivo" rows={3} maxLength={MOTIVO_MAXIMO} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </Field>
      {erro && (
        <Alert tone="error" className="mt-3">
          {erro}
        </Alert>
      )}
    </Dialog>
  );
}

/** Mensagem do vínculo gravado. */
function textoVinculo(r: RespostaVincular): string {
  return [
    'Vínculo gravado.',
    r.numeroOficialPreenchido ? 'O número oficial foi preenchido na notificação.' : null,
    r.divergencias.length ? `${r.divergencias.length} divergência(s) entre os dois: veja a lista "Divergentes".` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Vínculo manual: com o par já escolhido (sugestão), só confirma; com um lado só, busca o outro na lista "só no
 * OmniSaúde" (para um registro) ou "só no oficial" (para uma notificação), no mesmo agravo. Oferece preencher o
 * número oficial da notificação que ainda não tem.
 */
export function DialogoVincular({ registro, notificacao, onFechar, onFeito }: { registro: RegistroOficialResumo | null; notificacao: NotificacaoParaConciliar | null; onFechar: () => void; onFeito: () => void }) {
  const toast = useToast();
  const session = useSession();
  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState<FiltroConciliacao>({ grupo: (registro?.grupo ?? notificacao?.grupo) || undefined });
  const [escolhidoR, setEscolhidoR] = useState<RegistroOficialResumo | null>(registro);
  const [escolhidoN, setEscolhidoN] = useState<NotificacaoParaConciliar | null>(notificacao);
  const [motivo, setMotivo] = useState('');
  const [preencher, setPreencher] = useState(true);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const buscaNotificacao = !!registro && !notificacao;
  const buscaRegistro = !!notificacao && !registro;
  const candidatosN = useApi<ListaSoOmnisaude>(buscaNotificacao ? `/vigilancia/conciliacao/so-omnisaude${consultaConciliacao(filtro)}` : null);
  const candidatosR = useApi<ListaSoOficial>(buscaRegistro ? `/vigilancia/conciliacao/so-oficial${consultaConciliacao(filtro)}` : null);
  const candidatos = buscaNotificacao ? candidatosN : candidatosR;
  const r = escolhidoR;
  const n = escolhidoN;
  const oferece = !!r && !!n && podePreencherNumero(n, r, session.can('vigilancia.digitar'));

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onFechar()}
      size="lg"
      title="Vincular registro oficial e notificação"
      description="O vínculo diz que os dois são o mesmo caso: o par conta uma vez no diagrama, pelo registro oficial. Fica na auditoria."
      footer={
        <Button
          loading={busy}
          disabled={!r || !n}
          onClick={async () => {
            if (!r || !n) return;
            setBusy(true);
            setErro(null);
            try {
              const resp = await api.post<RespostaVincular>('/vigilancia/conciliacao/vincular', { recordId: r.id, notificationId: n.id, motivo: motivo.trim() || null, preencherNumeroOficial: oferece && preencher });
              toast.success(textoVinculo(resp));
              onFeito();
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Link2 className="h-4 w-4" /> Vincular
        </Button>
      }
    >
      <div className="space-y-4">
        {(buscaNotificacao || buscaRegistro) && (
          <div className="space-y-2">
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setFiltro({ ...filtro, busca: busca.trim() || undefined, pagina: undefined });
              }}
            >
              <Field label={buscaNotificacao ? 'Buscar a notificação (número, nome ou CNS)' : 'Buscar o registro oficial (número, nome, CNS ou CPF)'} htmlFor="conc-vinc-busca" className="min-w-64 flex-1">
                <Input id="conc-vinc-busca" value={busca} maxLength={60} onChange={(e) => setBusca(e.target.value)} />
              </Field>
              <Button type="submit" variant="secondary">
                <Search className="h-4 w-4" /> Buscar
              </Button>
              {filtro.grupo && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setFiltro({ ...filtro, grupo: undefined, pagina: undefined })}>
                  Buscar em todos os agravos
                </Button>
              )}
            </form>
            {candidatos.loading && !candidatos.data ? (
              <Spinner />
            ) : candidatos.error ? (
              <Alert tone="error">{candidatos.error}</Alert>
            ) : !candidatos.data?.itens.length ? (
              <p className="text-sm text-slate-500">Nada encontrado{filtro.grupo ? ' neste agravo' : ''}.</p>
            ) : (
              <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200" aria-label="Candidatos">
                {buscaNotificacao
                  ? candidatosN.data?.itens.map((c) => (
                      <li key={c.id}>
                        <label className="flex cursor-pointer gap-3 px-3 py-2 hover:bg-slate-50">
                          <input type="radio" name="conc-candidato" className="mt-1" checked={escolhidoN?.id === c.id} onChange={() => setEscolhidoN(c)} />
                          <CelulaNotificacao n={c} />
                        </label>
                      </li>
                    ))
                  : candidatosR.data?.itens.map((c) => (
                      <li key={c.id}>
                        <label className="flex cursor-pointer gap-3 px-3 py-2 hover:bg-slate-50">
                          <input type="radio" name="conc-candidato" className="mt-1" checked={escolhidoR?.id === c.id} onChange={() => setEscolhidoR(c)} />
                          <CelulaRegistro r={c} />
                        </label>
                      </li>
                    ))}
              </ul>
            )}
            {candidatos.data && candidatos.data.total > candidatos.data.itens.length && (
              <p className="text-xs text-slate-500">
                Mostrando {candidatos.data.itens.length} de {candidatos.data.total}: refine a busca.
              </p>
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="mb-1 text-xs font-medium text-slate-500">Registro oficial</p>
            {r ? <CelulaRegistro r={r} /> : <p className="text-sm text-slate-500">Escolha na lista acima.</p>}
          </div>
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="mb-1 text-xs font-medium text-slate-500">Notificação do OmniSaúde</p>
            {n ? <CelulaNotificacao n={n} /> : <p className="text-sm text-slate-500">Escolha na lista acima.</p>}
          </div>
        </div>
        {oferece && r && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={preencher} onChange={(e) => setPreencher(e.target.checked)} />
            Preencher o número oficial da notificação com {r.numero} (sai da fila de digitação do {rotuloSistema(r.sistema)})
          </label>
        )}
        <Field label="Motivo (opcional)" htmlFor="conc-vinc-motivo">
          <Input id="conc-vinc-motivo" value={motivo} maxLength={MOTIVO_MAXIMO} onChange={(e) => setMotivo(e.target.value)} />
        </Field>
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}

// ─── Listas ─────────────────────────────────────────────────────────────────

function useLista<T>(caminho: string, filtro: FiltroConciliacao) {
  const [pagina, setPagina] = useState(1);
  const lista = useApi<PaginaConciliacao<T>>(`${caminho}${consultaConciliacao({ ...filtro, pagina })}`);
  return { lista, setPagina };
}

function Estado({ lista, vazio }: { lista: { loading: boolean; error: string | null; data: PaginaConciliacao<unknown> | null }; vazio: string }) {
  if (lista.loading && !lista.data) return <Spinner />;
  if (lista.error) return <Alert tone="error">{lista.error}</Alert>;
  if (!lista.data?.itens.length) return <EmptyState title={vazio} />;
  return null;
}

/** Registros oficiais sem notificação do OmniSaúde vinculada. */
export function ListaSoNoOficial({ filtro, onMudou }: { filtro: FiltroConciliacao; onMudou: () => void }) {
  const { lista, setPagina } = useLista<RegistroOficialResumo>('/vigilancia/conciliacao/so-oficial', filtro);
  const [vincular, setVincular] = useState<RegistroOficialResumo | null>(null);
  const estado = <Estado lista={lista} vazio="Nenhum registro oficial sem vínculo" />;
  return (
    <>
      {lista.data?.itens.length ? (
        <>
          <Table>
            <THead>
              <tr>
                <TH>Registro oficial</TH>
                <TH className="w-40" />
              </tr>
            </THead>
            <TBody>
              {(lista.data as ListaSoOficial).itens.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <CelulaRegistro r={r} />
                  </TD>
                  <TD className="text-right">
                    {r.tipo === 'INDIVIDUAL' && (
                      <Button size="sm" variant="secondary" onClick={() => setVincular(r)}>
                        <Link2 className="h-4 w-4" /> Vincular…
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Paginacao p={lista.data} onPagina={setPagina} />
        </>
      ) : (
        estado
      )}
      {vincular && (
        <DialogoVincular
          registro={vincular}
          notificacao={null}
          onFechar={() => setVincular(null)}
          onFeito={() => {
            setVincular(null);
            void lista.reload();
            onMudou();
          }}
        />
      )}
    </>
  );
}

/** Notificações do OmniSaúde (notificadas ou encerradas, de sistema e período cobertos) sem registro oficial vinculado. */
export function ListaSoNoOmnisaude({ filtro, onMudou }: { filtro: FiltroConciliacao; onMudou: () => void }) {
  const { lista, setPagina } = useLista<NotificacaoParaConciliar>('/vigilancia/conciliacao/so-omnisaude', filtro);
  const [vincular, setVincular] = useState<NotificacaoParaConciliar | null>(null);
  return (
    <>
      <p className="px-4 pt-3 text-xs text-slate-500">Só entram os sistemas e os períodos cobertos por alguma importação aplicada: fora deles, a falta do registro oficial não quer dizer nada.</p>
      {lista.data?.itens.length ? (
        <>
          <Table>
            <THead>
              <tr>
                <TH>Notificação do OmniSaúde</TH>
                <TH className="w-40" />
              </tr>
            </THead>
            <TBody>
              {(lista.data as ListaSoOmnisaude).itens.map((n) => (
                <TR key={n.id}>
                  <TD>
                    <CelulaNotificacao n={n} />
                  </TD>
                  <TD className="text-right">
                    <Button size="sm" variant="secondary" onClick={() => setVincular(n)}>
                      <Link2 className="h-4 w-4" /> Vincular…
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Paginacao p={lista.data} onPagina={setPagina} />
        </>
      ) : (
        <Estado lista={lista} vazio="Nenhuma notificação sem registro oficial no período coberto" />
      )}
      {vincular && (
        <DialogoVincular
          registro={null}
          notificacao={vincular}
          onFechar={() => setVincular(null)}
          onFeito={() => {
            setVincular(null);
            void lista.reload();
            onMudou();
          }}
        />
      )}
    </>
  );
}

/** Pares vinculados com diferença de situação, evolução ou encerramento. */
export function ListaDivergentesConciliacao({ filtro, onMudou }: { filtro: FiltroConciliacao; onMudou: () => void }) {
  const toast = useToast();
  const { lista, setPagina } = useLista<ListaDivergentes['itens'][number]>('/vigilancia/conciliacao/divergentes', filtro);
  const [desvincular, setDesvincular] = useState<RegistroOficialResumo | null>(null);
  return (
    <>
      {lista.data?.itens.length ? (
        <>
          <Table>
            <THead>
              <tr>
                <TH>Registro oficial</TH>
                <TH>Notificação do OmniSaúde</TH>
                <TH>Diferenças</TH>
                <TH className="w-36" />
              </tr>
            </THead>
            <TBody>
              {lista.data.itens.map((p) => (
                <TR key={p.registro.id}>
                  <TD>
                    <CelulaRegistro r={p.registro} />
                  </TD>
                  <TD>
                    <CelulaNotificacao n={p.notificacao} />
                    {p.registro.vinculo && <p className="mt-1 text-xs text-slate-500">Vínculo: {ROTULO_METODO_VINCULO[p.registro.vinculo.metodo]}</p>}
                  </TD>
                  <TD>
                    <ul className="space-y-1 text-sm">
                      {p.divergencias.map((d) => {
                        const t = textoDivergencia(d);
                        return (
                          <li key={d.campo}>
                            <span className="font-medium">{t.campo}:</span> oficial {t.oficial} × OmniSaúde {t.omnisaude}
                          </li>
                        );
                      })}
                    </ul>
                  </TD>
                  <TD className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setDesvincular(p.registro)}>
                      <Link2Off className="h-4 w-4" /> Desvincular…
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Paginacao p={lista.data} onPagina={setPagina} />
        </>
      ) : (
        <Estado lista={lista} vazio="Nenhum par com diferença" />
      )}
      <DialogoMotivo
        key={desvincular?.id ?? 'nenhum'}
        aberto={desvincular !== null}
        titulo="Desvincular o par"
        descricao="Os dois deixam de ser o mesmo caso e o par não volta no vínculo automático. Fica na auditoria."
        botao="Desvincular"
        onFechar={() => setDesvincular(null)}
        onConfirmar={async (motivo) => {
          if (!desvincular) return;
          await api.post<RespostaOk>('/vigilancia/conciliacao/desvincular', { recordId: desvincular.id, motivo });
          toast.success('Par desvinculado.');
          setDesvincular(null);
          void lista.reload();
          onMudou();
        }}
      />
    </>
  );
}

/** Pares sugeridos (nome, nascimento e sexo; ou candidato não único no número oficial ou no CNS/CPF). */
export function ListaSugestoesConciliacao({ filtro, onMudou }: { filtro: FiltroConciliacao; onMudou: () => void }) {
  const toast = useToast();
  const { lista, setPagina } = useLista<ListaSugestoesVinculo['itens'][number]>('/vigilancia/conciliacao/sugestoes', filtro);
  const [vincular, setVincular] = useState<ListaSugestoesVinculo['itens'][number] | null>(null);
  const [rejeitar, setRejeitar] = useState<ListaSugestoesVinculo['itens'][number] | null>(null);
  return (
    <>
      {lista.data?.itens.length ? (
        <>
          <Table>
            <THead>
              <tr>
                <TH>Registro oficial</TH>
                <TH>Notificação do OmniSaúde</TH>
                <TH>Por quê</TH>
                <TH className="w-44" />
              </tr>
            </THead>
            <TBody>
              {lista.data.itens.map((s) => (
                <TR key={`${s.registro.id}-${s.notificacao.id}`}>
                  <TD>
                    <CelulaRegistro r={s.registro} />
                  </TD>
                  <TD>
                    <CelulaNotificacao n={s.notificacao} />
                  </TD>
                  <TD className="text-sm">
                    <Badge tone={s.degrau === 3 ? 'amber' : 'blue'}>Degrau {s.degrau}</Badge>
                    <p className="mt-1 text-slate-700">{s.motivo}</p>
                  </TD>
                  <TD>
                    <div className="flex flex-col items-end gap-1">
                      <Button size="sm" onClick={() => setVincular(s)}>
                        <Link2 className="h-4 w-4" /> Vincular
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRejeitar(s)}>
                        <ThumbsDown className="h-4 w-4" /> Não é o mesmo caso
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Paginacao p={lista.data} onPagina={setPagina} />
        </>
      ) : (
        <Estado lista={lista} vazio="Nenhuma sugestão de vínculo" />
      )}
      {vincular && (
        <DialogoVincular
          registro={vincular.registro}
          notificacao={vincular.notificacao}
          onFechar={() => setVincular(null)}
          onFeito={() => {
            setVincular(null);
            void lista.reload();
            onMudou();
          }}
        />
      )}
      <DialogoMotivo
        key={rejeitar ? `${rejeitar.registro.id}-${rejeitar.notificacao.id}` : 'nenhum'}
        aberto={rejeitar !== null}
        titulo="Não é o mesmo caso"
        descricao="A sugestão não volta. Use quando o registro oficial e a notificação são de pessoas ou episódios diferentes."
        botao="Gravar"
        onFechar={() => setRejeitar(null)}
        onConfirmar={async (motivo) => {
          if (!rejeitar) return;
          await api.post<RespostaOk>('/vigilancia/conciliacao/rejeitar', { recordId: rejeitar.registro.id, notificationId: rejeitar.notificacao.id, motivo });
          toast.success('Sugestão rejeitada: não volta mais.');
          setRejeitar(null);
          void lista.reload();
          onMudou();
        }}
      />
    </>
  );
}
