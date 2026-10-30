'use client';

import { Mic, MicOff } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import type { VoiceCommand } from './types';
import { useDictation } from './use-dictation';

const INTENT_LABEL: Record<VoiceCommand['intent'], string> = {
  CHAMAR_PACIENTE: 'Chamar paciente',
  CHAMAR_PROXIMO: 'Chamar próximo',
  PRESCREVER: 'Prescrever',
  EMITIR_ATESTADO: 'Emitir atestado',
  SOLICITAR_EXAME: 'Solicitar exame',
  ABRIR_PRONTUARIO: 'Abrir prontuário',
  ENCERRAR_ATENDIMENTO: 'Encerrar atendimento',
  DESCONHECIDO: 'Não entendi',
};

/** Comando de voz curto ("prescrever dipirona 500 mg de 6 em 6 horas", "emitir atestado de 2 dias"). */
export function VoiceCommandButton({ onCommand }: { onCommand: (c: VoiceCommand) => void }) {
  const toast = useToast();
  const dictation = useDictation((m) => toast.error(m));
  const [last, setLast] = useState<VoiceCommand | null>(null);
  const [busy, setBusy] = useState(false);
  if (!dictation.available) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant={dictation.active ? 'danger' : 'ghost'}
        loading={busy}
        aria-pressed={dictation.active}
        onClick={async () => {
          if (!dictation.active) return dictation.start();
          const text = await dictation.stop();
          if (!text.trim()) return;
          setBusy(true);
          try {
            const c = await api.post<VoiceCommand>('/clinical/voice-command', { text });
            setLast(c);
            if (c.intent === 'DESCONHECIDO') toast.info(`Comando não reconhecido: “${text}”`);
            else onCommand(c);
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
        title="Comando de voz"
      >
        {dictation.active ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        {dictation.active ? 'Concluir comando' : 'Comando de voz'}
      </Button>
      {dictation.active && <span className="text-sm text-slate-600">{dictation.text} {dictation.partial}</span>}
      {last && !dictation.active && (
        <Badge tone={last.intent === 'DESCONHECIDO' ? 'amber' : 'violet'}>
          {INTENT_LABEL[last.intent]}: “{last.raw}”
        </Badge>
      )}
    </div>
  );
}
