'use client';

import { useMemo, useState } from 'react';
import { PatientSearch } from '@/components/patients/patient-search';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import type { NotificacaoDetalhe, RetratoCatalogo } from './types';

/**
 * Notificação aberta à mão: agravo que o código do registro não cobre, suspeita sem CID, ESAVI a partir da dose
 * aplicada. O agravo vem da lista vigente na data (nacional mais complementos estadual e municipal).
 */
export function NovaNotificacaoDialog({
  open,
  onOpenChange,
  paciente,
  vaccinationId,
  conditionKey,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  paciente?: { id: string; name: string } | null;
  vaccinationId?: string | null;
  conditionKey?: string;
  onCreated: (id: string) => void;
}) {
  const [pessoa, setPessoa] = useState<{ id: string; name: string } | null>(paciente ?? null);
  const [agravo, setAgravo] = useState(conditionKey ?? '');
  const [filtro, setFiltro] = useState('');
  const [sintomas, setSintomas] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const catalogo = useApi<RetratoCatalogo>(open ? `/vigilancia/catalogo/vigente?data=${todayIso()}` : null, [open]);
  const opcoes = useMemo(() => {
    const f = filtro.trim().toLowerCase();
    return (catalogo.data?.condicoes ?? []).filter((c) => !f || c.name.toLowerCase().includes(f) || String(c.item) === f);
  }, [catalogo.data, filtro]);
  const escolhida = catalogo.data?.condicoes.find((c) => c.key === agravo);
  const alvo = paciente ?? pessoa;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={vaccinationId ? 'Notificar ESAVI' : 'Notificar agravo'}
      description="Abre o rascunho da ficha de notificação compulsória. Depois de conferir os campos, confirme a notificação."
      footer={
        <Button
          loading={busy}
          disabled={!alvo || !agravo}
          id="vig-nova-salvar"
          onClick={async () => {
            if (!alvo) return;
            setBusy(true);
            setErro(null);
            try {
              const d = await api.post<NotificacaoDetalhe>('/vigilancia/notificacoes', { patientId: alvo.id, conditionKey: agravo, vaccinationId: vaccinationId ?? null, symptomsOnset: sintomas || null });
              onOpenChange(false);
              onCreated(d.id);
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Abrir notificação
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {erro && <Alert tone="error">{erro}</Alert>}
        {paciente ? (
          <p className="text-sm">
            <span className="text-slate-500">Paciente: </span>
            {paciente.name}
          </p>
        ) : (
          <Field label="Paciente" htmlFor="vig-nova-paciente">
            {pessoa ? (
              <div className="flex items-center justify-between rounded border border-slate-200 px-3 py-2 text-sm">
                {pessoa.name}
                <Button size="sm" variant="ghost" onClick={() => setPessoa(null)}>
                  Trocar
                </Button>
              </div>
            ) : (
              <PatientSearch onSelect={(p) => setPessoa({ id: p.id, name: p.name })} placeholder="Nome, CPF ou CNS" />
            )}
          </Field>
        )}
        {!conditionKey && (
          <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
            <Field label="Filtrar a lista" htmlFor="vig-nova-filtro">
              <Input id="vig-nova-filtro" value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Nome ou nº do item" />
            </Field>
            <Field label="Agravo (lista vigente)" htmlFor="vig-nova-agravo">
              <Select id="vig-nova-agravo" value={agravo} onChange={(e) => setAgravo(e.target.value)}>
                <option value="">Escolha…</option>
                {opcoes.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.item}
                    {c.subitem ?? ''}. {c.name}
                    {c.weekly ? ' · semanal' : ' · imediata'}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {escolhida && (
          <p className="text-xs text-slate-600">
            {escolhida.weekly
              ? 'Notificação semanal: até 7 dias do conhecimento.'
              : `Notificação imediata (até 24 h) para ${[escolhida.immediateMs && 'MS', escolhida.immediateSes && 'SES', escolhida.immediateSms && 'SMS'].filter(Boolean).join(', ')}.`}
            {escolhida.notifyOn === 'CONFIRMACAO' ? ' Notifica-se o caso confirmado: informe a data de confirmação na ficha.' : ''}
            {escolhida.sensitive ? ' Agravo sigiloso: só você e a vigilância verão os detalhes.' : ''}
          </p>
        )}
        <Field label="Data dos primeiros sintomas (se souber)" htmlFor="vig-nova-sintomas">
          <Input id="vig-nova-sintomas" type="date" max={todayIso()} value={sintomas} onChange={(e) => setSintomas(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
