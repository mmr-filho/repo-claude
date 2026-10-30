'use client';

import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

export type BodyView = 'FRENTE' | 'COSTAS';

export interface PainMark {
  view: BodyView;
  region: string;
  x: number;
  y: number;
  intensity: number;
}

type Shape = { id: string; kind: 'rect'; x: number; y: number; w: number; h: number; r?: number } | { id: string; kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number };

const W = 200;
const H = 440;

/**
 * Silhueta em convenção anatômica: na vista de frente o lado direito do paciente fica à esquerda da tela;
 * na vista de costas, à direita.
 */
function silhouette(view: BodyView): Shape[] {
  const right = view === 'FRENTE' ? 0 : 1; // 0 = direito à esquerda da tela
  const side = (base: string, left: number, rightX: number) => {
    const [d, e] = right === 0 ? [left, rightX] : [rightX, left];
    return [
      [`${base}_direito`, d],
      [`${base}_esquerdo`, e],
    ] as const;
  };
  const front = view === 'FRENTE';
  const shapes: Shape[] = [
    { id: front ? 'cabeca' : 'cabeca_posterior', kind: 'ellipse', cx: 100, cy: 35, rx: 24, ry: 30 },
    { id: front ? 'pescoco' : 'cervical', kind: 'rect', x: 90, y: 63, w: 20, h: 15, r: 4 },
    { id: front ? 'torax' : 'dorso', kind: 'rect', x: 70, y: 78, w: 60, h: 60, r: 10 },
    { id: front ? 'abdome_superior' : 'lombar_superior', kind: 'rect', x: 72, y: 138, w: 56, h: 32, r: 4 },
    { id: front ? 'abdome_inferior' : 'lombar', kind: 'rect', x: 72, y: 170, w: 56, h: 30, r: 4 },
    { id: front ? 'pelve' : 'gluteo', kind: 'rect', x: 70, y: 200, w: 60, h: 30, r: 10 },
  ];
  for (const [id, cx] of side('ombro', 62, 138)) shapes.push({ id, kind: 'ellipse', cx, cy: 88, rx: 15, ry: 12 });
  for (const [id, x] of side('braco', 45, 137)) shapes.push({ id, kind: 'rect', x, y: 100, w: 18, h: 58, r: 8 });
  for (const [id, x] of side('antebraco', 39, 143)) shapes.push({ id, kind: 'rect', x, y: 158, w: 18, h: 58, r: 8 });
  for (const [id, cx] of side('mao', 47, 153)) shapes.push({ id, kind: 'ellipse', cx, cy: 230, rx: 11, ry: 14 });
  for (const [id, x] of side(front ? 'coxa' : 'coxa_posterior', 72, 102)) shapes.push({ id, kind: 'rect', x, y: 230, w: 26, h: 78, r: 10 });
  for (const [id, cx] of side(front ? 'joelho' : 'fossa_poplitea', 85, 115)) shapes.push({ id, kind: 'ellipse', cx, cy: 318, rx: 13, ry: 11 });
  for (const [id, x] of side(front ? 'perna' : 'panturrilha', 74, 104)) shapes.push({ id, kind: 'rect', x, y: 328, w: 22, h: 70, r: 8 });
  for (const [id, cx] of side(front ? 'pe' : 'calcanhar', 84, 116)) shapes.push({ id, kind: 'ellipse', cx, cy: 410, rx: 14, ry: 9 });
  return shapes;
}

const NAMES: Record<string, string> = {
  cabeca: 'cabeça',
  cabeca_posterior: 'cabeça (região posterior)',
  pescoco: 'pescoço',
  cervical: 'coluna cervical',
  torax: 'tórax',
  dorso: 'dorso',
  abdome_superior: 'abdome superior',
  abdome_inferior: 'abdome inferior',
  lombar_superior: 'região lombar alta',
  lombar: 'região lombar',
  pelve: 'pelve',
  gluteo: 'glúteos',
  ombro: 'ombro',
  braco: 'braço',
  antebraco: 'antebraço',
  mao: 'mão',
  coxa: 'coxa',
  coxa_posterior: 'coxa (posterior)',
  joelho: 'joelho',
  fossa_poplitea: 'fossa poplítea',
  perna: 'perna',
  panturrilha: 'panturrilha',
  pe: 'pé',
  calcanhar: 'calcanhar',
};

export function regionLabel(id: string): string {
  const m = /^(.*)_(direito|esquerdo)$/.exec(id);
  if (m) return `${NAMES[m[1]!] ?? m[1]} ${m[2]}`;
  return NAMES[id] ?? id.replaceAll('_', ' ');
}

/** Escala visual analógica (EVA) 0–10. */
export function painLevel(v: number) {
  if (v === 0) return { label: 'Sem dor', color: '#16a34a', face: '😀' };
  if (v <= 3) return { label: 'Dor leve', color: '#65a30d', face: '🙂' };
  if (v <= 6) return { label: 'Dor moderada', color: '#eab308', face: '😐' };
  if (v <= 9) return { label: 'Dor intensa', color: '#ea580c', face: '😣' };
  return { label: 'Dor insuportável', color: '#dc2626', face: '😫' };
}

export function PainScale({ value, onChange, id }: { value: number; onChange: (v: number) => void; id?: string }) {
  const lvl = painLevel(value);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-3xl" aria-hidden>
          {lvl.face}
        </span>
        <div>
          <p className="text-2xl font-semibold tabular-nums" style={{ color: lvl.color }}>
            {value}/10
          </p>
          <p className="text-sm text-slate-600">{lvl.label}</p>
        </div>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={10}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-11 w-full cursor-pointer accent-current"
        style={{ color: lvl.color }}
        aria-valuetext={`${value} de 10, ${lvl.label}`}
        aria-label="Intensidade da dor"
      />
      <div className="flex justify-between text-xs text-slate-500" aria-hidden>
        {Array.from({ length: 11 }, (_, i) => (
          <span key={i}>{i}</span>
        ))}
      </div>
    </div>
  );
}

/** Mapa topográfico da dor: toque na região (frente/costas) e ajuste a intensidade na escala 0–10. */
export function BodyMap({ marks, onChange }: { marks: PainMark[]; onChange: (m: PainMark[]) => void }) {
  const [view, setView] = useState<BodyView>('FRENTE');
  const [selected, setSelected] = useState<number | null>(null);
  const shapes = silhouette(view);

  function add(region: string, e: React.MouseEvent<SVGElement>) {
    const svg = (e.currentTarget as SVGElement).ownerSVGElement ?? (e.currentTarget as unknown as SVGSVGElement);
    const box = svg.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
    const existing = marks.findIndex((m) => m.view === view && m.region === region);
    if (existing >= 0) {
      setSelected(existing);
      return;
    }
    const next = [...marks, { view, region, x: Number(x.toFixed(3)), y: Number(y.toFixed(3)), intensity: 5 }];
    onChange(next);
    setSelected(next.length - 1);
  }

  function addByKeyboard(s: Shape) {
    const cx = s.kind === 'rect' ? s.x + s.w / 2 : s.cx;
    const cy = s.kind === 'rect' ? s.y + s.h / 2 : s.cy;
    const existing = marks.findIndex((m) => m.view === view && m.region === s.id);
    if (existing >= 0) return setSelected(existing);
    const next = [...marks, { view, region: s.id, x: Number((cx / W).toFixed(3)), y: Number((cy / H).toFixed(3)), intensity: 5 }];
    onChange(next);
    setSelected(next.length - 1);
  }

  const sel = selected !== null ? marks[selected] : null;
  return (
    <div className="grid gap-4 md:grid-cols-[auto_1fr]">
      <div className="flex flex-col items-center gap-2">
        <div className="flex rounded-lg bg-slate-100 p-1" role="group" aria-label="Vista do corpo">
          {(['FRENTE', 'COSTAS'] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} className={cn('min-h-9 rounded-md px-4 text-sm font-medium', view === v ? 'bg-white shadow-sm' : 'text-slate-600')} aria-pressed={view === v}>
              {v === 'FRENTE' ? 'Frente' : 'Costas'}
            </button>
          ))}
        </div>
        <div className="relative">
          <span className="absolute left-0 top-1 text-xs font-semibold text-slate-400">{view === 'FRENTE' ? 'D' : 'E'}</span>
          <span className="absolute right-0 top-1 text-xs font-semibold text-slate-400">{view === 'FRENTE' ? 'E' : 'D'}</span>
          <svg viewBox={`0 0 ${W} ${H}`} className="h-[26rem] w-auto touch-manipulation select-none" role="img" aria-label={`Corpo humano, vista de ${view === 'FRENTE' ? 'frente' : 'costas'}`}>
            {shapes.map((s) => {
              const marked = marks.find((m) => m.view === view && m.region === s.id);
              const common = {
                onClick: (e: React.MouseEvent<SVGElement>) => add(s.id, e),
                onKeyDown: (e: React.KeyboardEvent<SVGElement>) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    addByKeyboard(s);
                  }
                },
                tabIndex: 0,
                role: 'button',
                'aria-label': `Marcar dor: ${regionLabel(s.id)}`,
                className: 'cursor-pointer outline-none transition-colors focus:stroke-brand-600',
                fill: marked ? painLevel(marked.intensity).color : '#e2e8f0',
                fillOpacity: marked ? 0.55 : 1,
                stroke: '#94a3b8',
                strokeWidth: 1.2,
              };
              return s.kind === 'rect' ? <rect key={s.id} {...common} x={s.x} y={s.y} width={s.w} height={s.h} rx={s.r ?? 0} /> : <ellipse key={s.id} {...common} cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} />;
            })}
            {marks
              .map((m, i) => ({ m, i }))
              .filter(({ m }) => m.view === view)
              .map(({ m, i }) => (
                <g key={i} onClick={() => setSelected(i)} className="cursor-pointer">
                  <circle cx={m.x * W} cy={m.y * H} r={selected === i ? 9 : 7} fill={painLevel(m.intensity).color} stroke="white" strokeWidth={2} />
                  <text x={m.x * W} y={m.y * H + 3.5} textAnchor="middle" fontSize="9" fontWeight="700" fill="white">
                    {m.intensity}
                  </text>
                </g>
              ))}
          </svg>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {sel ? (
          <div className="rounded-lg border border-slate-200 p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="font-medium capitalize">
                {regionLabel(sel.region)} <span className="text-xs font-normal text-slate-500">({sel.view === 'FRENTE' ? 'frente' : 'costas'})</span>
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onChange(marks.filter((_, i) => i !== selected));
                  setSelected(null);
                }}
              >
                <Trash2 className="h-4 w-4" /> Remover
              </Button>
            </div>
            <PainScale value={sel.intensity} onChange={(v) => onChange(marks.map((m, i) => (i === selected ? { ...m, intensity: v } : m)))} />
          </div>
        ) : (
          <p className="text-sm text-slate-500">Toque na região do corpo onde o paciente sente dor. Repita para cada local.</p>
        )}
        {marks.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {marks.map((m, i) => (
              <li key={i}>
                <button type="button" onClick={() => { setView(m.view); setSelected(i); }} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-slate-50">
                  <span className="inline-block h-3 w-3 rounded-full" style={{ background: painLevel(m.intensity).color }} />
                  <span className="capitalize">{regionLabel(m.region)}</span>
                  <span className="text-slate-500">({m.view === 'FRENTE' ? 'frente' : 'costas'})</span>
                  <span className="ml-auto font-semibold tabular-nums">{m.intensity}/10</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
