'use client';

import { RefreshCw, ShieldCheck, ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, PageHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Verification {
  ok: boolean;
  checked: number;
  brokenAt: string | null;
  reason?: string;
}

interface Entry {
  seq: string;
  at: string;
  userName: string | null;
  role: string | null;
  ip: string | null;
  mfa: boolean;
  action: string;
  entityType: string;
  entityId: string | null;
  payloadHash: string;
  prevHash: string;
  hash: string;
}

export default function AuditPage() {
  const verify = useApi<Verification>('/audit/verify');
  const entries = useApi<Entry[]>('/audit/entries');

  return (
    <>
      <PageHeader
        title="Trilha de auditoria"
        description="Cada registro clínico e operacional relevante gera um hash SHA-256 que combina o conteúdo, o instante (UTC), o IP, o operador e o 2FA, encadeado ao hash anterior. Qualquer alteração quebra a cadeia."
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              void verify.reload();
              void entries.reload();
            }}
          >
            <RefreshCw className="h-4 w-4" /> Verificar de novo
          </Button>
        }
      />
      <Card className="mb-4">
        <CardBody>
          {verify.loading ? (
            <Spinner label="Recalculando a cadeia de hashes…" />
          ) : verify.error ? (
            <Alert tone="error">{verify.error}</Alert>
          ) : verify.data?.ok ? (
            <div className="flex items-center gap-3 text-emerald-800">
              <ShieldCheck className="h-8 w-8" />
              <div>
                <p className="font-semibold">Cadeia íntegra</p>
                <p className="text-sm">{verify.data.checked.toLocaleString('pt-BR')} entradas conferidas, do início da trilha até a mais recente.</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 text-red-800">
              <ShieldX className="h-8 w-8" />
              <div>
                <p className="font-semibold">Cadeia interrompida na entrada #{verify.data?.brokenAt}</p>
                <p className="text-sm">
                  {verify.data?.reason}. {verify.data?.checked} entradas anteriores conferem. Acione a segurança da informação.
                </p>
              </div>
            </div>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Entradas recentes" description="O conteúdo clínico não fica na trilha: só o hash dele." />
        {entries.loading ? (
          <Spinner />
        ) : entries.error ? (
          <CardBody>
            <Alert tone="error">{entries.error}</Alert>
          </CardBody>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>#</TH>
                <TH>Quando</TH>
                <TH>Quem</TH>
                <TH>Ação</TH>
                <TH>Entidade</TH>
                <TH>IP</TH>
                <TH>2FA</TH>
                <TH>Hash / anterior</TH>
              </tr>
            </THead>
            <TBody>
              {(entries.data ?? []).map((e) => (
                <TR key={e.seq}>
                  <TD className="tabular-nums">{e.seq}</TD>
                  <TD className="whitespace-nowrap">{fmtDateTime(e.at)}</TD>
                  <TD>
                    {e.userName ?? '—'}
                    {e.role && <span className="block text-xs text-slate-500">{e.role}</span>}
                  </TD>
                  <TD className="font-mono text-xs">{e.action}</TD>
                  <TD className="text-xs">
                    {e.entityType}
                    {e.entityId && <span className="block font-mono text-slate-500">{e.entityId.slice(0, 8)}…</span>}
                  </TD>
                  <TD className="font-mono text-xs">{e.ip ?? '—'}</TD>
                  <TD>{e.mfa ? <Badge tone="green">sim</Badge> : <Badge>não</Badge>}</TD>
                  <TD className="font-mono text-xs" title={`${e.hash}\n← ${e.prevHash}`}>
                    {e.hash.slice(0, 12)}…<span className="block text-slate-400">← {e.prevHash.slice(0, 12)}…</span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
