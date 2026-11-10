'use client';

import { ROTULO_STATUS_SEMANA, type CoberturaAno, type PopulacaoUsada } from '@omnisaude/shared';
import { Badge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { fmtCasos, fmtValor, ROTULO_ORIGEM_POPULACAO, rotulosDoCanal, textoFonte, TOM_STATUS, type LinhaDiagrama, type MetodoCanal, type UnidadeCanal } from './diagrama-dados';

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

/** População usada em cada ano do canal e cobertura de cada ano da série. */
export function DiagramaPopulacaoUsada({ populacao, cobertura, unidade }: { populacao: PopulacaoUsada[]; cobertura: CoberturaAno[]; unidade: UnidadeCanal }) {
  const anos = [...new Set([...populacao.map((p) => p.ano), ...cobertura.map((c) => c.ano)])].sort((a, b) => a - b);
  if (!anos.length) return <p className="text-sm text-slate-500">Sem anos na série.</p>;
  return (
    <Table>
      <caption className="sr-only">População e cobertura de cada ano da série</caption>
      <THead>
        <tr>
          <TH>Ano</TH>
          <TH>Cobertura</TH>
          {unidade === 'INCIDENCIA' && (
            <>
              <TH className="text-right">População</TH>
              <TH>Fonte</TH>
              <TH>Origem</TH>
            </>
          )}
        </tr>
      </THead>
      <TBody>
        {anos.map((ano) => {
          const p = populacao.find((x) => x.ano === ano);
          const c = cobertura.find((x) => x.ano === ano);
          return (
            <TR key={ano}>
              <TD className="tabular-nums">{ano}</TD>
              <TD className="text-xs">{c ? <Badge tone={c.coberto ? 'green' : 'slate'}>{c.coberto ? 'Coberto' : 'Sem cobertura'}</Badge> : '—'}</TD>
              {unidade === 'INCIDENCIA' && (
                <>
                  <TD className="text-right tabular-nums">{p?.populacao != null ? p.populacao.toLocaleString('pt-BR') : '—'}</TD>
                  <TD className="text-xs">{p ? textoFonte(p.fonte, p.versao) : '—'}</TD>
                  <TD className="text-xs">{p ? <Badge tone={p.origem === 'OFICIAL' ? 'green' : p.origem === 'AUSENTE' ? 'red' : 'amber'}>{ROTULO_ORIGEM_POPULACAO[p.origem]}</Badge> : '—'}</TD>
                </>
              )}
            </TR>
          );
        })}
      </TBody>
      {cobertura.some((c) => c.motivo) && (
        <tfoot>
          <tr>
            <td colSpan={unidade === 'INCIDENCIA' ? 5 : 2} className="px-3 pt-2 text-xs text-slate-500">
              {cobertura
                .filter((c) => c.motivo)
                .map((c) => `${c.ano}: ${c.motivo}`)
                .join(' · ')}
            </td>
          </tr>
        </tfoot>
      )}
    </Table>
  );
}
