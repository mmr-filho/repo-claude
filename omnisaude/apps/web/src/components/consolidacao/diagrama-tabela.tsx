'use client';

import { ROTULO_STATUS_SEMANA } from '@omnisaude/shared';
import { Badge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { fmtCasos, fmtValor, rotulosDoCanal, TOM_STATUS, type LinhaDiagrama, type MetodoCanal, type UnidadeCanal } from './diagrama-dados';

/** Tabela por semana com os mesmos números do gráfico (o caminho até o valor sem depender da dica nem da cor). */
export function DiagramaTabelaSemanas({ linhas, unidade, metodo, k }: { linhas: LinhaDiagrama[]; unidade: UnidadeCanal; metodo: MetodoCanal; k: number }) {
  const rot = rotulosDoCanal(metodo, k);
  const quartis = metodo === 'QUARTIS';
  const num = 'text-right tabular-nums';
  return (
    <div className="max-h-[32rem] overflow-y-auto">
      <Table>
        <caption className="sr-only">Valores por semana epidemiológica: casos, {unidade === 'INCIDENCIA' ? 'incidência, ' : ''}limites do canal e situação</caption>
        <THead>
          <tr>
            <TH>SE</TH>
            <TH className="text-right">Casos</TH>
            {unidade === 'INCIDENCIA' && <TH className="text-right">Incidência</TH>}
            {quartis && <TH className="text-right">{rot.liCurto}</TH>}
            <TH className="text-right">{rot.centroCurto}</TH>
            <TH className="text-right">{rot.lsCurto}</TH>
            <TH>Situação</TH>
          </tr>
        </THead>
        <TBody>
          {linhas.map((l) => (
            <TR key={l.chave} className={l.incompleta ? 'bg-slate-50' : undefined}>
              <TD className="whitespace-nowrap tabular-nums">
                {l.rotulo}
                {l.incompleta && <span className="ml-1.5 text-xs text-slate-500">(incompleta)</span>}
              </TD>
              <TD className={num}>{fmtCasos(l.casos)}</TD>
              {unidade === 'INCIDENCIA' && <TD className={num}>{fmtValor(l.valor, unidade)}</TD>}
              {quartis && <TD className={num}>{fmtValor(l.li, unidade)}</TD>}
              <TD className={num}>{fmtValor(l.centro, unidade)}</TD>
              <TD className={num}>{fmtValor(l.ls, unidade)}</TD>
              <TD>{l.valor === null && l.status === 'SEM_CANAL' ? <span className="text-xs text-slate-400">—</span> : <Badge tone={TOM_STATUS[l.status]}>{ROTULO_STATUS_SEMANA[l.status]}</Badge>}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
