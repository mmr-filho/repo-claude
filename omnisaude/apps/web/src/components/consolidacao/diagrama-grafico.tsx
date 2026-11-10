'use client';

import { ROTULO_STATUS_SEMANA } from '@omnisaude/shared';
import { useMemo } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type DotItemDotProps } from 'recharts';
import { Badge } from '@/components/ui/badge';
import {
  fmtCasos,
  fmtMarcaY,
  fmtValor,
  marcasDoEixo,
  rotulosDoCanal,
  ROTULO_MEDIDA,
  semanasIncompletasDoEixo,
  textoSemanas,
  TOM_STATUS,
  viradaDoAno,
  type LinhaDiagrama,
  type MetodoCanal,
  type UnidadeCanal,
} from './diagrama-dados';

/**
 * Cores das séries (passos do tema escuro da paleta de referência do dataviz): conferidas com o validador contra o
 * fundo claro (#ffffff) e o escuro (#1a1a19). As três passam no contraste de 3:1 com os dois fundos e se distinguem
 * para daltonismo (ΔE ≥ 9,4). A cor nunca é o único sinal: legenda em texto, tracejado e a tabela abaixo.
 */
export const COR_DIAGRAMA = { observado: '#3987e5', ls: '#d95926', canal: '#199e70' } as const;
const OPACIDADE_FAIXA = 0.14;
const TRACEJADO = '6 4';

/** Chave de linha da legenda e da dica (curta, no traço da série). */
function ChaveLinha({ cor, tracejada, espessura = 2 }: { cor: string; tracejada?: boolean; espessura?: number }) {
  return (
    <svg width="24" height="10" aria-hidden className="shrink-0">
      <line x1="2" y1="5" x2="22" y2="5" stroke={cor} strokeWidth={espessura} strokeDasharray={tracejada ? TRACEJADO : undefined} strokeLinecap="round" />
    </svg>
  );
}

function ChaveFaixa({ cor }: { cor: string }) {
  return (
    <svg width="24" height="12" aria-hidden className="shrink-0">
      <rect x="1" y="1" width="22" height="10" rx="2" fill={cor} fillOpacity={OPACIDADE_FAIXA * 1.6} stroke={cor} strokeOpacity={0.6} />
    </svg>
  );
}

/** Legenda em texto (a cor nunca é o único sinal). O tracejado só aparece quando há semana incompleta no eixo. */
function Legenda({ metodo, k, incompletas }: { metodo: MetodoCanal; k: number; incompletas: string[] }) {
  const rot = rotulosDoCanal(metodo, k);
  const item = 'flex items-center gap-1.5';
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-slate-700" aria-label="Legenda do gráfico">
      <li className={item}>
        <ChaveLinha cor={COR_DIAGRAMA.observado} espessura={2.5} /> Observado
      </li>
      {incompletas.length > 0 && (
        <li className={item}>
          <ChaveLinha cor={COR_DIAGRAMA.observado} espessura={2.5} tracejada /> Semanas incompletas ({textoSemanas(incompletas)})
        </li>
      )}
      <li className={item}>
        <ChaveLinha cor={COR_DIAGRAMA.ls} /> {rot.ls}
      </li>
      <li className={item}>
        <ChaveLinha cor={COR_DIAGRAMA.canal} /> {rot.centro}
      </li>
      <li className={item}>
        <ChaveFaixa cor={COR_DIAGRAMA.canal} /> {rot.faixa}
      </li>
    </ul>
  );
}

/** Dica de uma semana: casos, valor, limites e a situação (valor primeiro, rótulo depois). */
function Dica({ linha, unidade, metodo, k }: { linha: LinhaDiagrama | null; unidade: UnidadeCanal; metodo: MetodoCanal; k: number }) {
  if (!linha) return null;
  const rot = rotulosDoCanal(linha.metodo ?? metodo, k);
  const valor = 'text-right font-semibold tabular-nums text-slate-900';
  const rotulo = 'flex items-center gap-1.5 text-slate-600';
  return (
    <div className="min-w-48 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="font-semibold text-slate-900">
        SE {linha.rotulo}
        {linha.incompleta ? ' · incompleta' : ''}
      </p>
      <dl className="mt-1.5 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        <dt className={rotulo}>
          <ChaveLinha cor={COR_DIAGRAMA.observado} tracejada={linha.incompleta} /> Casos
        </dt>
        <dd className={valor}>{fmtCasos(linha.casos)}</dd>
        {unidade === 'INCIDENCIA' && (
          <>
            <dt className={`${rotulo} pl-[30px]`}>Incidência</dt>
            <dd className={valor}>{fmtValor(linha.valor, unidade)}</dd>
          </>
        )}
        <dt className={rotulo}>
          <ChaveLinha cor={COR_DIAGRAMA.ls} /> {rot.lsCurto}
        </dt>
        <dd className={valor}>{fmtValor(linha.ls, unidade)}</dd>
        <dt className={rotulo}>
          <ChaveLinha cor={COR_DIAGRAMA.canal} /> {rot.centroCurto}
        </dt>
        <dd className={valor}>{fmtValor(linha.centro, unidade)}</dd>
        {(linha.metodo ?? metodo) === 'QUARTIS' && (
          <>
            <dt className={`${rotulo} pl-[30px]`}>{rot.liCurto}</dt>
            <dd className={valor}>{fmtValor(linha.li, unidade)}</dd>
          </>
        )}
      </dl>
      <p className="mt-2">
        <Badge tone={TOM_STATUS[linha.status]}>{ROTULO_STATUS_SEMANA[linha.status]}</Badge>
      </p>
    </div>
  );
}

/** Marcador só no ponto isolado da série (sem vizinho, a linha não aparece). */
function marcadorIsolado(campo: 'isoladoObservado' | 'isoladoIncompleto') {
  function Marcador(p: DotItemDotProps) {
    const linha = p.payload as LinhaDiagrama | undefined;
    if (!linha?.[campo] || p.cx == null || p.cy == null) return <g key={`v-${p.index}`} />;
    return <circle key={`m-${p.index}`} cx={p.cx} cy={p.cy} r={4} fill={COR_DIAGRAMA.observado} stroke="#ffffff" strokeWidth={2} />;
  }
  return Marcador;
}

/**
 * Gráfico do diagrama de controle (Recharts): faixa do canal, centro, limite superior e a curva observada; as semanas
 * incompletas ficam tracejadas. No eixo sazonal, uma linha marca a virada do ano. A tabela abaixo traz os mesmos
 * números (a dica nunca é o único caminho até o valor).
 */
export function DiagramaGrafico({ linhas, unidade, metodo, k, descricao }: { linhas: LinhaDiagrama[]; unidade: UnidadeCanal; metodo: MetodoCanal; k: number; descricao: string }) {
  const marcas = useMemo(() => marcasDoEixo(linhas), [linhas]);
  const virada = useMemo(() => viradaDoAno(linhas), [linhas]);
  const semana = useMemo(() => new Map(linhas.map((l) => [l.chave, l.semana])), [linhas]);
  const incompletas = useMemo(() => semanasIncompletasDoEixo(linhas), [linhas]);
  const rot = rotulosDoCanal(metodo, k);
  const eixo = { fontSize: 11, fill: 'currentColor' };
  return (
    <div className="space-y-2 text-slate-600">
      <Legenda metodo={metodo} k={k} incompletas={incompletas} />
      <p className="text-xs font-medium text-slate-700">{ROTULO_MEDIDA[unidade]}</p>
      <div className="h-80" role="img" aria-label={descricao}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={linhas} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.15} />
            <XAxis dataKey="chave" ticks={marcas} interval={0} tickFormatter={(c: string) => String(semana.get(c) ?? '')} tick={eixo} tickLine={false} stroke="currentColor" strokeOpacity={0.4} />
            <YAxis tickFormatter={fmtMarcaY} tick={eixo} tickLine={false} width={64} stroke="currentColor" strokeOpacity={0.4} />
            <Tooltip cursor={{ stroke: 'currentColor', strokeOpacity: 0.35 }} content={(p) => <Dica linha={(p.payload?.[0]?.payload as LinhaDiagrama | undefined) ?? null} unidade={unidade} metodo={metodo} k={k} />} />
            <Area dataKey="faixa" name={rot.faixa} type="linear" fill={COR_DIAGRAMA.canal} fillOpacity={OPACIDADE_FAIXA} stroke="none" activeDot={false} isAnimationActive={false} />
            <Line dataKey="centro" name={rot.centro} type="linear" stroke={COR_DIAGRAMA.canal} strokeWidth={2} dot={false} activeDot={false} isAnimationActive={false} />
            <Line dataKey="ls" name={rot.ls} type="linear" stroke={COR_DIAGRAMA.ls} strokeWidth={2} dot={false} activeDot={false} isAnimationActive={false} />
            <Line
              dataKey="observado"
              name="Observado"
              type="linear"
              stroke={COR_DIAGRAMA.observado}
              strokeWidth={2.5}
              strokeLinecap="round"
              dot={marcadorIsolado('isoladoObservado')}
              activeDot={{ r: 5, stroke: '#ffffff', strokeWidth: 2 }}
              isAnimationActive={false}
            />
            <Line
              dataKey="incompleto"
              name="Semanas incompletas"
              type="linear"
              stroke={COR_DIAGRAMA.observado}
              strokeWidth={2.5}
              strokeDasharray={TRACEJADO}
              dot={marcadorIsolado('isoladoIncompleto')}
              activeDot={{ r: 5, stroke: '#ffffff', strokeWidth: 2 }}
              isAnimationActive={false}
            />
            {virada && <ReferenceLine x={virada.chave} stroke="currentColor" strokeOpacity={0.45} label={{ value: String(virada.ano), position: 'insideTopLeft', fill: 'currentColor', fontSize: 11 }} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="text-center text-xs">Semana epidemiológica{virada ? ` (SE 27 a SE 26 do ano seguinte; a linha vertical marca a SE 1 de ${virada.ano})` : ''}</p>
    </div>
  );
}
