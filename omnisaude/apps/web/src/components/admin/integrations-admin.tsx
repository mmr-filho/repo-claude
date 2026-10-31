'use client';

import { ExternalLink, PlugZap, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface RndsStatus {
  enabled: boolean;
  configured: boolean;
  environment: 'homologacao' | 'producao' | 'simulado' | 'personalizado' | null;
  uf: string | null;
  authUrl: string | null;
  ehrUrl: string | null;
  requester: { kind: string; value: string } | null;
  requesterId: string | null;
  certificate: boolean;
  outbox: Record<string, number>;
}
interface TestResult {
  ok: boolean;
  environment: string;
  cnes: string;
  unit: string;
  organization?: string | null;
  status?: number | null;
  message?: string;
  elapsedMs: number;
}

const ENV_LABEL: Record<string, string> = { homologacao: 'homologação', producao: 'produção', simulado: 'simulador local', personalizado: 'endereços informados manualmente' };
const OUTBOX_LABEL: Record<string, string> = { PENDENTE: 'pendentes', ERRO: 'com erro', ENVIADO: 'enviados', DESCARTADO: 'descartados' };

/** Situação das integrações externas da instituição: por enquanto, a RNDS. */
export function IntegrationsAdmin() {
  const toast = useToast();
  const session = useSession();
  const status = useApi<RndsStatus>('/integrations/rnds/status');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const s = status.data;

  async function test() {
    setTesting(true);
    try {
      const r = await api.post<TestResult>('/integrations/rnds/test');
      setResult(r);
      if (r.ok) toast.success(`RNDS respondeu em ${r.elapsedMs} ms`);
      else toast.error(r.message ?? 'A RNDS não respondeu');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader
          title="RNDS (Rede Nacional de Dados em Saúde)"
          description="Envio dos registros clínicos, imunizações, dispensações e sumários de alta ao Ministério da Saúde (FHIR com certificado digital do estabelecimento)."
          actions={
            <Button variant="secondary" onClick={() => void status.reload()} loading={status.loading}>
              <RefreshCw className="h-4 w-4" /> Atualizar
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-3 text-sm">
          {status.error && <Alert tone="error">{status.error}</Alert>}
          {status.loading && !s ? (
            <Spinner className="py-4" />
          ) : s ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge tone={s.enabled ? 'green' : 'slate'}>{s.enabled ? 'envio ligado' : 'envio desligado'}</Badge>
                <Badge tone={s.configured ? 'green' : 'amber'}>{s.configured ? 'configurada' : 'não configurada'}</Badge>
                {s.environment && <Badge tone={s.environment === 'producao' ? 'blue' : 'amber'}>{ENV_LABEL[s.environment] ?? s.environment}</Badge>}
                <Badge tone={s.certificate ? 'green' : 'amber'}>{s.certificate ? 'certificado carregado' : 'sem certificado'}</Badge>
              </div>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
                <div>
                  <dt className="font-medium text-slate-500">Autenticação</dt>
                  <dd className="break-all">{s.authUrl ?? '—'}</dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-500">Serviços EHR{s.uf ? ` (${s.uf})` : ''}</dt>
                  <dd className="break-all">{s.ehrUrl ?? '—'}</dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-500">Solicitante (cabeçalho Authorization)</dt>
                  <dd>{s.requester ? `${s.requester.kind} ${s.requester.value}` : '—'}</dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-500">Identificador do solicitante (credenciamento)</dt>
                  <dd>{s.requesterId ?? '—'}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="font-medium text-slate-500">Fila de envio</dt>
                  <dd>
                    {Object.keys(s.outbox).length
                      ? Object.entries(s.outbox)
                          .map(([k, n]) => `${n} ${OUTBOX_LABEL[k] ?? k.toLowerCase()}`)
                          .join(' · ')
                      : 'nenhum documento na fila'}
                  </dd>
                </div>
              </dl>
              {!s.enabled && <Alert tone="info">O envio é ligado pela plataforma (preferência da instituição) depois do credenciamento em homologação.</Alert>}
              {session.can('parametros.gerir') && (
                <Button onClick={test} loading={testing} disabled={!s.configured} className="self-start">
                  <PlugZap className="h-4 w-4" /> Testar conexão
                </Button>
              )}
              {result && (
                <Alert tone={result.ok ? 'success' : 'error'} title={result.ok ? 'Conexão com a RNDS confirmada' : 'A RNDS recusou ou não respondeu'}>
                  {result.ok
                    ? `Token obtido e estabelecimento ${result.cnes} (${result.unit}) encontrado como "${result.organization ?? '—'}" no ambiente de ${ENV_LABEL[result.environment] ?? result.environment} em ${result.elapsedMs} ms.`
                    : `${result.message ?? 'erro'}${result.status ? ` (HTTP ${result.status})` : ''} · estabelecimento ${result.cnes} · ambiente ${ENV_LABEL[result.environment] ?? result.environment}.`}
                </Alert>
              )}
            </>
          ) : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Credenciamento na RNDS" description="O que a gestão precisa fazer antes de o envio real começar." />
        <CardBody className="text-sm">
          <ol className="list-inside list-decimal space-y-2">
            <li>Ter o certificado digital do estabelecimento ou do ente (e-CNPJ ICP-Brasil, tipo A1, arquivo .pfx) e uma conta gov.br do gestor.</li>
            <li>
              No{' '}
              <a className="inline-flex items-center gap-1 text-brand-700 underline" href="https://servicos-datasus.saude.gov.br/" target="_blank" rel="noreferrer">
                Portal de Serviços do DATASUS <ExternalLink className="h-3 w-3" />
              </a>
              , solicitar o acesso à RNDS em homologação informando o CNES, o certificado (.cer) e os IPs de saída.
            </li>
            <li>Receber do DATASUS o identificador do solicitante e informá-lo, junto com o certificado e o CNS do profissional responsável, na configuração da instituição.</li>
            <li>Testar a conexão aqui, enviar os documentos de homologação e, aprovados, pedir o acesso à produção (um endereço por UF).</li>
          </ol>
          <p className="mt-3 text-xs text-slate-500">O passo a passo completo, as variáveis de configuração e os perfis FHIR conferidos estão em docs/RNDS.md do projeto.</p>
        </CardBody>
      </Card>
    </div>
  );
}
