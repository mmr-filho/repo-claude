'use client';

import { STATUS_MIRA, type FonteRegulacao, type StatusMira } from '@omnisaude/shared';
import { CloudUpload, Eye, RefreshCw, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, Stat } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Painel {
  habilitado: boolean;
  configurado: boolean;
  ambiente: string | null;
  regulatorCnes: string | null;
  porStatus: Record<'PENDENTE' | 'ENVIADO' | 'ERRO' | 'DESCARTADO', number>;
  atrasados: number;
  ultimoEnvio: string | null;
  solicitacoes: { ambulatorial: number; leito: number };
}
interface Documento {
  id: string;
  requestId: string;
  fonte: FonteRegulacao;
  sequencia: number | null;
  statusLocal: string;
  evento: string | null;
  statusMira: StatusMira;
  statusMiraLabel: string;
  alteradoEm: string;
  envio: { status: 'PENDENTE' | 'ENVIADO' | 'ERRO' | 'DESCARTADO'; attempts: number; lastError: string | null; externalId: string | null; sentAt: string | null; notBefore: string; createdAt: string };
  solicitacao: { protocol: string; descricao: string; status: string; paciente: string; identificado: boolean } | null;
}
interface Previa {
  ok: boolean;
  erro?: string;
  validacao: { valid: boolean; issues: { severity: string; path: string; message: string }[] } | null;
  bundle: unknown;
}

const ENVIO_TONE: Record<Documento['envio']['status'], 'slate' | 'green' | 'amber' | 'red'> = { PENDENTE: 'slate', ENVIADO: 'green', ERRO: 'amber', DESCARTADO: 'red' };
const ENVIO_LABEL: Record<Documento['envio']['status'], string> = { PENDENTE: 'Na fila', ENVIADO: 'Enviado', ERRO: 'Erro (nova tentativa)', DESCARTADO: 'Descartado' };
const AMBIENTE: Record<string, string> = { homologacao: 'homologação', producao: 'produção', simulado: 'simulador local', personalizado: 'endereços manuais' };

/** Envio da regulação à RNDS (Portaria GM/MS 6.656/2025): fila, documentos por solicitação, pré-visualização e reenvio. */
export function RndsTab() {
  const session = useSession();
  const toast = useToast();
  const regula = session.can('regulacao.regular') || session.can('leitos_rede.regular');
  const [status, setStatus] = useState<'' | Documento['envio']['status']>('');
  const [fonte, setFonte] = useState<'' | FonteRegulacao>('');
  const [previa, setPrevia] = useState<{ doc: Documento; data: Previa | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const painel = useApi<Painel>('/regulacao/rnds/painel');
  const docs = useApi<Documento[]>(`/regulacao/rnds/documentos?${new URLSearchParams({ ...(status ? { status } : {}), ...(fonte ? { fonte } : {}) }).toString()}`, [status, fonte]);
  const p = painel.data;
  const recarregar = () => {
    void painel.reload();
    void docs.reload();
  };

  async function abrirPrevia(doc: Documento) {
    setPrevia({ doc, data: null });
    try {
      setPrevia({ doc, data: await api.get<Previa>(`/regulacao/rnds/documentos/${doc.id}/previa`) });
    } catch (err) {
      toast.error(errorMessage(err));
      setPrevia(null);
    }
  }
  async function acao(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      recarregar();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {p && (
        <>
          {!p.habilitado && (
            <Alert tone="info" title="Envio à RNDS desligado">
              Os documentos ficam na fila e são enviados quando a instituição ligar a RNDS (Administração &gt; Integrações), depois do credenciamento.
            </Alert>
          )}
          {p.habilitado && !p.configurado && <Alert tone="warn">A RNDS está ligada, mas não configurada (ambiente, certificado e CNS do solicitante).</Alert>}
          {p.atrasados > 0 && (
            <Alert tone="warn" title={`${p.atrasados} documento(s) há mais de 24 h sem envio`}>
              A Portaria 6.656/2025 exige a transmissão diária com as informações até o dia anterior. Verifique os erros abaixo e reenvie.
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Na fila" value={p.porStatus.PENDENTE} />
            <Stat label="Enviados" value={p.porStatus.ENVIADO} tone="good" />
            <Stat label="Com erro" value={p.porStatus.ERRO} tone={p.porStatus.ERRO ? 'warn' : 'default'} />
            <Stat label="Descartados" value={p.porStatus.DESCARTADO} tone={p.porStatus.DESCARTADO ? 'bad' : 'default'} />
            <Stat label="Último envio" value={p.ultimoEnvio ? fmtDateTime(p.ultimoEnvio) : '—'} hint={p.ambiente ? `ambiente: ${AMBIENTE[p.ambiente] ?? p.ambiente}` : 'RNDS não configurada'} />
            <Stat label="Solicitações" value={p.solicitacoes.ambulatorial + p.solicitacoes.leito} hint={`${p.solicitacoes.ambulatorial} ambulatoriais · ${p.solicitacoes.leito} de leito`} />
          </div>
        </>
      )}
      <Card>
        <CardHeader
          title="Registros de Regulação Assistencial (RIRA)"
          description="Um documento FHIR por mudança de situação, no Modelo de Informação da Regulação Assistencial (MIRA). Autor: central reguladora configurada."
          actions={
            <div className="flex flex-wrap gap-2">
              <Select value={fonte} onChange={(e) => setFonte(e.target.value as '' | FonteRegulacao)} aria-label="Fonte" className="w-44">
                <option value="">Ambulatorial e leitos</option>
                <option value="AMBULATORIAL">Ambulatorial</option>
                <option value="LEITO">Leitos</option>
              </Select>
              <Select value={status} onChange={(e) => setStatus(e.target.value as '' | Documento['envio']['status'])} aria-label="Situação do envio" className="w-48">
                <option value="">Todas as situações</option>
                {(Object.keys(ENVIO_LABEL) as Documento['envio']['status'][]).map((s) => (
                  <option key={s} value={s}>
                    {ENVIO_LABEL[s]}
                  </option>
                ))}
              </Select>
              <Button variant="secondary" onClick={recarregar}>
                <RefreshCw className="h-4 w-4" /> Atualizar
              </Button>
              {regula && (
                <Button variant="secondary" onClick={() => acao('carga', () => api.post('/regulacao/rnds/carga-inicial'), 'Solicitações sem documento enfileiradas')} loading={busy === 'carga'} id="rnds-carga-inicial">
                  <CloudUpload className="h-4 w-4" /> Carga inicial
                </Button>
              )}
            </div>
          }
        />
        <CardBody className="p-0">
          {docs.error && (
            <Alert tone="error" className="m-4">
              {docs.error}
            </Alert>
          )}
          {docs.loading && !docs.data && <Spinner />}
          {docs.data && docs.data.length === 0 && <EmptyState title="Nenhum documento" description="Cada solicitação e cada mudança de situação geram um documento aqui." icon={<CloudUpload className="h-8 w-8" />} />}
          {docs.data && docs.data.length > 0 && (
            <Table>
              <THead>
                <TR>
                  <TH>Solicitação</TH>
                  <TH>Situação (MIRA)</TH>
                  <TH>Alterada em</TH>
                  <TH>Envio</TH>
                  <TH>Id na RNDS</TH>
                  <TH></TH>
                </TR>
              </THead>
              <TBody>
                {docs.data.map((d) => (
                  <TR key={d.id}>
                    <TD>
                      <span className="font-mono text-xs">{d.solicitacao?.protocol ?? d.requestId.slice(0, 8)}</span>
                      <span className="block text-xs text-slate-500">
                        {d.solicitacao?.paciente}
                        {d.solicitacao && !d.solicitacao.identificado && <span className="text-red-700"> · sem CPF/CNS</span>}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {d.fonte === 'LEITO' ? 'Leito' : 'Ambulatorial'} · {d.solicitacao?.descricao}
                      </span>
                    </TD>
                    <TD>
                      <Badge tone="blue">{STATUS_MIRA[d.statusMira] ?? d.statusMiraLabel}</Badge>
                      <span className="block text-xs text-slate-500">
                        {d.statusLocal}
                        {d.evento ? ` · ${d.evento}` : ''} · doc. {d.sequencia ?? '—'}
                      </span>
                    </TD>
                    <TD className="whitespace-nowrap text-xs">{fmtDateTime(d.alteradoEm)}</TD>
                    <TD>
                      <Badge tone={ENVIO_TONE[d.envio.status]}>{ENVIO_LABEL[d.envio.status]}</Badge>
                      {d.envio.sentAt && <span className="block text-xs text-slate-500">{fmtDateTime(d.envio.sentAt)}</span>}
                      {d.envio.lastError && (
                        <span className="block max-w-xs truncate text-xs text-red-700" title={d.envio.lastError}>
                          {d.envio.lastError}
                        </span>
                      )}
                      {d.envio.attempts > 0 && <span className="block text-xs text-slate-500">{d.envio.attempts} tentativa(s)</span>}
                    </TD>
                    <TD className="font-mono text-xs">{d.envio.externalId ? d.envio.externalId.slice(0, 12) : '—'}</TD>
                    <TD className="whitespace-nowrap">
                      {regula && (
                        <Button size="sm" variant="ghost" onClick={() => abrirPrevia(d)} aria-label={`Pré-visualizar ${d.solicitacao?.protocol ?? ''}`}>
                          <Eye className="h-4 w-4" /> FHIR
                        </Button>
                      )}
                      {regula && d.envio.status !== 'ENVIADO' && (
                        <Button size="sm" variant="ghost" onClick={() => acao(d.id, () => api.post(`/regulacao/rnds/documentos/${d.id}/reenviar`), 'Documento recolocado na fila')} loading={busy === d.id}>
                          <RotateCcw className="h-4 w-4" /> Reenviar
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
      <Dialog
        open={!!previa}
        onOpenChange={(o) => !o && setPrevia(null)}
        title={previa ? `Documento FHIR · ${previa.doc.solicitacao?.protocol ?? ''} · ${STATUS_MIRA[previa.doc.statusMira]}` : 'Documento FHIR'}
        description="Registro de Regulação Assistencial como será enviado à RNDS (perfil BRRegulacaoAssistencial)."
        size="xl"
      >
        {previa && !previa.data && <Spinner />}
        {previa?.data && (
          <div className="flex flex-col gap-3">
            {!previa.data.ok && (
              <Alert tone="error" title="Não foi possível montar o documento">
                {previa.data.erro}
              </Alert>
            )}
            {previa.data.validacao && (
              <Alert tone={previa.data.validacao.valid ? 'success' : 'error'} title={previa.data.validacao.valid ? 'Validação estrutural: sem erros' : 'Validação estrutural: com erros'}>
                {previa.data.validacao.issues.length > 0 ? (
                  <ul className="list-disc pl-4">
                    {previa.data.validacao.issues.map((i, idx) => (
                      <li key={idx}>
                        {i.severity === 'error' ? 'Erro' : 'Aviso'} · {i.path}: {i.message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  'Perfis, identificadores, datas e referências conferidos.'
                )}
              </Alert>
            )}
            {previa.data.bundle ? <pre className="max-h-[60vh] overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{JSON.stringify(previa.data.bundle, null, 2)}</pre> : null}
          </div>
        )}
      </Dialog>
    </div>
  );
}
