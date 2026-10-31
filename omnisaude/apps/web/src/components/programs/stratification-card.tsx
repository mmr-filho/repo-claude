'use client';

import { ESTRATIFICACAO_LABEL, type TipoEstratificacao } from '@omnisaude/shared';
import { useState } from 'react';
import { RESULT_LABEL, RESULT_TONE, StratificationDialog } from '@/components/programs/stratification-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Row {
  id: string;
  kind: TipoEstratificacao;
  result: string;
  score: number | null;
  notes: string | null;
  nextDueAt: string | null;
  assessedAt: string;
  assessedBy: string | null;
  answers: { orientacao?: string; descricao?: string };
}

const KINDS: TipoEstratificacao[] = ['GESTANTE', 'PE_DIABETICO', 'MCHAT'];

/** Card do paciente com as estratificações de risco aplicadas e os botões para aplicar os instrumentos. */
export function StratificationCard({ patientId, patientName, encounterId }: { patientId: string; patientName: string; encounterId?: string }) {
  const session = useSession();
  const rows = useApi<Row[]>(`/programas/estratificacoes?patientId=${patientId}`, [patientId]);
  const [kind, setKind] = useState<TipoEstratificacao | null>(null);
  const ultimas = KINDS.map((k) => (rows.data ?? []).find((r) => r.kind === k)).filter((r): r is Row => !!r);
  return (
    <Card>
      <CardHeader
        title="Estratificações de risco"
        description="Risco gestacional (CAB 32), risco do pé diabético (MS 2016) e M-CHAT-R (16 a 30 meses)."
        actions={
          session.can('prontuario.evoluir') && (
            <div className="flex flex-wrap gap-1">
              {KINDS.map((k) => (
                <Button key={k} size="sm" variant="ghost" onClick={() => setKind(k)}>
                  {ESTRATIFICACAO_LABEL[k].split(' (')[0]}
                </Button>
              ))}
            </div>
          )
        }
      />
      <CardBody className="flex flex-col gap-2 text-sm">
        {ultimas.length === 0 ? (
          <span className="text-slate-500">Nenhuma estratificação registrada</span>
        ) : (
          ultimas.map((r) => (
            <p key={r.id}>
              <b>{ESTRATIFICACAO_LABEL[r.kind].split(' (')[0]}</b>: <Badge tone={RESULT_TONE[r.result] ?? 'slate'}>{RESULT_LABEL[r.result] ?? r.result}</Badge>
              {r.score !== null && r.kind === 'MCHAT' && <span className="text-slate-600"> {r.score} pontos</span>}
              <span className="block text-xs text-slate-500">
                {fmtDateTime(r.assessedAt)}
                {r.assessedBy ? ` · ${r.assessedBy}` : ''}
                {r.nextDueAt ? ` · reavaliar até ${fmtDate(r.nextDueAt)}` : ''}
                {r.answers?.orientacao ? ` · ${r.answers.orientacao}` : ''}
              </span>
            </p>
          ))
        )}
      </CardBody>
      {kind && (
        <StratificationDialog
          patientId={patientId}
          patientName={patientName}
          kind={kind}
          encounterId={encounterId}
          open
          onOpenChange={(o) => {
            if (!o) setKind(null);
          }}
          onSaved={() => void rows.reload()}
        />
      )}
    </Card>
  );
}
