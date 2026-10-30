'use client';

import { RISK_COLORS, RISK_FLAGS, RISK_INFO, type RiskColor, type RiskFlag } from '@omnisaude/shared';
import { Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { RiskBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtMinutes } from '@/lib/format';
import { BodyMap, type PainMark } from './body-map';

export const FLAG_LABELS: Record<RiskFlag, string> = {
  parada_cardiorrespiratoria: 'Parada cardiorrespiratória',
  via_aerea_comprometida: 'Via aérea comprometida',
  choque: 'Sinais de choque',
  convulsao_ativa: 'Convulsão ativa',
  dor_toracica: 'Dor torácica',
  deficit_neurologico_agudo: 'Déficit neurológico agudo',
  alteracao_aguda_consciencia: 'Alteração aguda de consciência',
  hemorragia_nao_controlada: 'Hemorragia não controlada',
  gestante_sangramento: 'Gestante com sangramento',
  vomitos_persistentes: 'Vômitos persistentes',
  historia_trauma_moderado: 'Trauma moderado',
  vulnerabilidade_social: 'Vulnerabilidade social',
};

const VITALS = [
  { key: 'systolic', label: 'PA sistólica', unit: 'mmHg' },
  { key: 'diastolic', label: 'PA diastólica', unit: 'mmHg' },
  { key: 'heartRate', label: 'Freq. cardíaca', unit: 'bpm' },
  { key: 'respiratoryRate', label: 'Freq. respiratória', unit: 'irpm' },
  { key: 'temperature', label: 'Temperatura', unit: '°C', step: '0.1' },
  { key: 'spo2', label: 'SpO₂', unit: '%' },
  { key: 'glucose', label: 'Glicemia capilar', unit: 'mg/dL' },
  { key: 'weightKg', label: 'Peso', unit: 'kg', step: '0.1' },
  { key: 'heightCm', label: 'Altura', unit: 'cm' },
] as const;
type VitalKey = (typeof VITALS)[number]['key'];

const RISK_BG: Record<RiskColor, string> = {
  VERMELHO: 'bg-risk-vermelho text-white',
  LARANJA: 'bg-risk-laranja text-white',
  AMARELO: 'bg-risk-amarelo text-slate-900',
  VERDE: 'bg-risk-verde text-white',
  AZUL: 'bg-risk-azul text-white',
};

const INTEGER: VitalKey[] = ['systolic', 'diastolic', 'heartRate', 'respiratoryRate', 'spo2', 'glucose', 'heightCm'];

function num(v: string, key: VitalKey): number | undefined {
  if (!v.trim()) return undefined;
  const n = Number(v.replace(',', '.'));
  if (!Number.isFinite(n)) return undefined;
  return INTEGER.includes(key) ? Math.round(n) : n;
}

/** Acolhimento com Classificação de Risco: sinais vitais, mapa da dor, discriminadores e cor. */
export function TriageForm({ encounterId, patientName, onDone }: { encounterId: string; patientName: string; onDone: () => void }) {
  const toast = useToast();
  const [complaint, setComplaint] = useState('');
  const [vitals, setVitals] = useState<Record<VitalKey, string>>(() => Object.fromEntries(VITALS.map((v) => [v.key, ''])) as Record<VitalKey, string>);
  const [marks, setMarks] = useState<PainMark[]>([]);
  const [flags, setFlags] = useState<RiskFlag[]>([]);
  const [vulnerability, setVulnerability] = useState('');
  const [chosen, setChosen] = useState<RiskColor | null>(null);
  const [override, setOverride] = useState('');
  const [suggestion, setSuggestion] = useState<{ color: RiskColor; reasons: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const numeric = useMemo(() => {
    const out: Partial<Record<VitalKey, number>> = {};
    for (const v of VITALS) {
      const n = num(vitals[v.key], v.key);
      if (n !== undefined) out[v.key] = n;
    }
    return out;
  }, [vitals]);
  const painScore = marks.length ? Math.max(...marks.map((m) => m.intensity)) : undefined;

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const { weightKg: _w, heightCm: _h, ...v } = numeric;
        setSuggestion(await api.post('/triage/suggest', { ...v, ...(painScore !== undefined ? { painScore } : {}), flags }, { signal: ctrl.signal }));
      } catch {
        // sugestão é apoio: falhas intermediárias não bloqueiam o formulário
      }
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [numeric, flags, painScore]);

  const color = chosen ?? suggestion?.color ?? null;
  const lessSevere = !!(color && suggestion && RISK_COLORS.indexOf(color) > RISK_COLORS.indexOf(suggestion.color));

  async function submit() {
    setError(null);
    if (complaint.trim().length < 3) {
      setError('Descreva a queixa principal.');
      return;
    }
    if (lessSevere && !override.trim()) {
      setError('Justifique a classificação abaixo da sugerida pelos parâmetros.');
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<{ triage: { riskColor: RiskColor }; maxWaitMinutes: number }>(`/triage/encounters/${encounterId}`, {
        complaint: complaint.trim(),
        ...numeric,
        ...(painScore !== undefined ? { painScore } : {}),
        painMap: marks,
        flags,
        ...(vulnerability.trim() ? { vulnerability: vulnerability.trim() } : {}),
        ...(chosen ? { riskColor: chosen } : {}),
        ...(override.trim() ? { overrideReason: override.trim() } : {}),
      });
      toast.success(`${patientName}: ${res.triage.riskColor} — atendimento em até ${res.maxWaitMinutes === 0 ? 'imediato' : fmtMinutes(res.maxWaitMinutes)}.`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'JUSTIFICATIVA_OBRIGATORIA' ? err.message : errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Field label="Queixa principal" htmlFor="tr-complaint">
        <Textarea id="tr-complaint" value={complaint} onChange={(e) => setComplaint(e.target.value)} rows={2} placeholder="Ex.: falta de ar há 2 horas" />
      </Field>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-700">Sinais vitais</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {VITALS.map((v) => (
            <Field key={v.key} label={`${v.label} (${v.unit})`} htmlFor={`tr-${v.key}`}>
              <Input
                id={`tr-${v.key}`}
                inputMode="decimal"
                value={vitals[v.key]}
                onChange={(e) => setVitals((s) => ({ ...s, [v.key]: e.target.value }))}
                className="h-11 text-base tabular-nums"
              />
            </Field>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-700">Mapa da dor</h3>
        <BodyMap marks={marks} onChange={setMarks} />
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-700">Discriminadores</h3>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.keys(RISK_FLAGS) as RiskFlag[]).map((f) => (
            <label key={f} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm">
              <input type="checkbox" className="h-5 w-5" checked={flags.includes(f)} onChange={(e) => setFlags((s) => (e.target.checked ? [...s, f] : s.filter((x) => x !== f)))} />
              <span className="flex-1">{FLAG_LABELS[f]}</span>
              <RiskBadge color={RISK_FLAGS[f]} compact className="opacity-70" />
            </label>
          ))}
        </div>
        <Field label="Vulnerabilidade (opcional)" htmlFor="tr-vuln" className="mt-3">
          <Input id="tr-vuln" value={vulnerability} onChange={(e) => setVulnerability(e.target.value)} placeholder="Situação de rua, idoso desacompanhado, violência…" />
        </Field>
      </section>

      <section className="rounded-xl border border-slate-200 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Sparkles className="h-4 w-4 text-brand-600" />
          <span className="text-sm font-semibold">Sugestão pelos parâmetros:</span>
          {suggestion ? <RiskBadge color={suggestion.color} /> : <span className="text-sm text-slate-500">preencha os sinais vitais</span>}
        </div>
        {suggestion && (
          <ul className="mb-3 list-inside list-disc text-sm text-slate-600">
            {suggestion.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <p className="mb-2 text-sm font-medium text-slate-700">Classificação final (decisão da enfermagem)</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-5" role="radiogroup" aria-label="Cor da classificação de risco">
          {RISK_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              onClick={() => setChosen(c)}
              className={cn('flex min-h-14 flex-col items-center justify-center rounded-lg px-2 py-2 text-sm font-semibold ring-offset-2', RISK_BG[c], color === c ? 'ring-4 ring-slate-900' : 'opacity-60 hover:opacity-90')}
            >
              {c}
              <span className="text-xs font-normal">
                {RISK_INFO[c].label} · {RISK_INFO[c].maxWaitMinutes === 0 ? 'imediato' : `até ${fmtMinutes(RISK_INFO[c].maxWaitMinutes)}`}
              </span>
            </button>
          ))}
        </div>
        {lessSevere && (
          <Field label="Justificativa (classificação abaixo da sugerida)" htmlFor="tr-override" className="mt-3">
            <Textarea id="tr-override" value={override} onChange={(e) => setOverride(e.target.value)} rows={2} />
          </Field>
        )}
      </section>

      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end">
        <Button size="lg" onClick={submit} loading={saving} disabled={!color}>
          Registrar classificação
        </Button>
      </div>
    </div>
  );
}
