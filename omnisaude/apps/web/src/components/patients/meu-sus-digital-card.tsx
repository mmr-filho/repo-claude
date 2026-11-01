'use client';

import { CloudUpload, ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Spinner } from '@/components/ui/misc';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Resumo {
  prontidao: { cpf: boolean; cns: boolean; rndsAtiva: boolean; pronto: boolean; pendencias: string[] };
  enviados: { atendimentos: number; vacinas: number; dispensacoes: number; altas: number; regulacao: number; total: number };
  pendentes: number;
  falhas: number;
  descartados: number;
  ultimoEnvio: string | null;
  link: string;
}

/** O que deste paciente já está (ou falta para estar) no Meu SUS Digital, via RNDS (CID-4). */
export function MeuSusDigitalCard({ patientId }: { patientId: string }) {
  const { data, loading } = useApi<Resumo>(`/patients/${patientId}/meu-sus-digital`, [patientId]);
  return (
    <Card>
      <CardHeader
        title="Meu SUS Digital"
        description="Registros enviados à RNDS aparecem para o cidadão no app do Ministério da Saúde, pelo CPF."
        actions={data ? <Badge tone={data.prontidao.pronto ? 'green' : 'amber'}>{data.prontidao.pronto ? 'Pronto' : 'Com pendência'}</Badge> : undefined}
      />
      <CardBody className="text-sm">
        {loading && !data && <Spinner />}
        {data && (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              {[
                ['Atendimentos', data.enviados.atendimentos],
                ['Vacinas', data.enviados.vacinas],
                ['Dispensações', data.enviados.dispensacoes],
                ['Internações', data.enviados.altas],
                ['Regulação', data.enviados.regulacao],
              ].map(([label, n]) => (
                <div key={String(label)} className="rounded-lg bg-slate-50 p-2 text-center">
                  <p className="text-lg font-semibold">{n}</p>
                  <p className="text-xs text-slate-500">{label}</p>
                </div>
              ))}
            </div>
            <p className="mt-2 flex items-center gap-1 text-xs text-slate-500">
              <CloudUpload className="h-3.5 w-3.5" /> {data.enviados.total} enviados · {data.pendentes} na fila · {data.falhas} com erro temporário · {data.descartados} recusados
              {data.ultimoEnvio ? ` · último envio ${fmtDateTime(data.ultimoEnvio)}` : ''}
            </p>
            {data.descartados > 0 && (
              <p className="mt-1 text-xs text-red-700">Há registros recusados de vez (dado faltando ou rejeição da RNDS): confira em Administração &gt; Integrações e corrija o cadastro ou o registro.</p>
            )}
            {data.prontidao.pendencias.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs text-amber-800">
                {data.prontidao.pendencias.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <a href={data.link} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-brand-700 underline">
              <ExternalLink className="h-3.5 w-3.5" /> meususdigital.saude.gov.br
            </a>
          </>
        )}
      </CardBody>
    </Card>
  );
}
