import { demoFixtures } from '@omnisaude/database';
import { nextAllowedTime } from '@omnisaude/messaging';
import { fromZonedParts, localDateString } from '@omnisaude/shared';
import { vi } from 'vitest';

/**
 * Datas e relógio dos testes da API. A API trabalha no fuso da instituição (tenant.timeZone), não em UTC:
 * das 21h à meia-noite (UTC-3) a data UTC já é a de amanhã. "Hoje" e o dia da semana dos testes saem daqui,
 * para que os testes passem a qualquer hora do dia.
 */

/** Fuso da instituição de teste: o harness cria o tenant a partir da carga de demonstração. */
export const FUSO = demoFixtures.DEMO_TENANT.timeZone;

/** Data (AAAA-MM-DD) no fuso da instituição. */
export function hoje(agora: Date = new Date()): string {
  return localDateString(agora, FUSO);
}

function partes(data: string) {
  const [year, month, day] = data.split('-').map(Number);
  return { year: year!, month: month!, day: day! };
}

/** Soma dias a uma data AAAA-MM-DD (aritmética de calendário, sem hora nem fuso). */
export function somarDias(data: string, dias: number): string {
  const { year, month, day } = partes(data);
  return new Date(Date.UTC(year, month - 1, day + dias)).toISOString().slice(0, 10);
}

/** Dia da semana (0 = domingo, 6 = sábado) de uma data AAAA-MM-DD. */
export function diaDaSemana(data: string): number {
  const { year, month, day } = partes(data);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Instante de uma data AAAA-MM-DD e hora "HH:MM" no fuso da instituição. */
export function instanteLocal(data: string, hora: string): Date {
  const [hour, minute] = hora.split(':').map(Number);
  return fromZonedParts({ ...partes(data), hour: hour!, minute: minute!, second: 0 }, FUSO);
}

/**
 * Primeiro instante em que uma mensagem de rotina do WhatsApp pode sair: o próprio `agora` fora da janela de
 * silêncio (22h às 6h no horário local) ou o fim dela. Usa a regra da produção; o teste só escolhe o relógio.
 */
export function foraDaJanelaDeSilencio(agora: Date = new Date()): Date {
  return nextAllowedTime(agora, { timeZone: FUSO });
}

/**
 * Executa `fn` com o relógio do processo parado em `instante`. A API sobe no mesmo processo do teste, então
 * ela também passa a ver esse horário. Só `Date` é simulado (os temporizadores seguem reais) e o Postgres
 * continua no relógio real: não use quando o resultado depende do now() do banco.
 */
export async function comRelogio<T>(instante: Date, fn: () => PromiseLike<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'], now: instante });
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}
