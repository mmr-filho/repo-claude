import { RISK_INFO, type RiskColor } from '@omnisaude/shared';
import { cn } from '@/lib/cn';

const tones = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  blue: 'bg-brand-50 text-brand-800 ring-brand-200',
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-800 ring-red-200',
  violet: 'bg-violet-50 text-violet-800 ring-violet-200',
} as const;

export function Badge({ tone = 'slate', className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', tones[tone], className)} {...props} />;
}

const riskClass: Record<RiskColor, string> = {
  VERMELHO: 'bg-risk-vermelho text-white',
  LARANJA: 'bg-risk-laranja text-white',
  AMARELO: 'bg-risk-amarelo text-slate-900',
  VERDE: 'bg-risk-verde text-white',
  AZUL: 'bg-risk-azul text-white',
};

/** Cor da classificação de risco com o rótulo por extenso (não depender só da cor: acessibilidade). */
export function RiskBadge({ color, className, compact }: { color: RiskColor; className?: string; compact?: boolean }) {
  return (
    <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold uppercase tracking-wide', riskClass[color], className)} title={RISK_INFO[color].label}>
      {compact ? color : `${color} · ${RISK_INFO[color].label}`}
    </span>
  );
}

export const severityTone = { LEVE: 'blue', MODERADO: 'amber', GRAVE: 'red' } as const;
