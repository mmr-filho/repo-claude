/** App do cidadão (CID-1): rótulos, regras e utilitários compartilhados entre API e telas. */

export const STATUS_AGENDAMENTO_CIDADAO: Record<string, string> = {
  AGENDADO: 'Agendada',
  CONFIRMADO: 'Confirmada',
  CANCELADO: 'Cancelada',
  FALTOU: 'Não compareceu',
  ATENDIDO: 'Realizada',
  REMARCADO: 'Remarcada',
};

export const STATUS_EXAME_CIDADAO: Record<string, string> = {
  SOLICITADO: 'Solicitado',
  COLETADO: 'Coletado, aguardando resultado',
  RESULTADO: 'Resultado disponível',
  CANCELADO: 'Cancelado',
};

export const STATUS_SENHA_CIDADAO: Record<string, string> = {
  AGUARDANDO: 'Aguardando chamada',
  CHAMADA: 'Chamada: dirija-se ao guichê',
  EM_ATENDIMENTO: 'Em atendimento',
  FINALIZADA: 'Atendimento concluído',
  AUSENTE: 'Não compareceu à chamada',
};

/** Telefone com os dígitos do meio ocultos: "(63) 99999-0001" → "(63) *****-0001". */
export function mascararTelefone(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length < 8) return null;
  const ddd = d.length >= 10 ? d.slice(0, 2) : '';
  const local = d.slice(ddd ? 2 : 0);
  const fim = local.slice(-4);
  return `${ddd ? `(${ddd}) ` : ''}${'*'.repeat(Math.max(0, local.length - 4))}-${fim}`;
}

/** O cidadão cancela até o horário de início; o que já passou ou foi atendido fica no histórico. */
export function podeCancelarAgendamento(status: string, startsAt: Date | string, agora: Date = new Date()): boolean {
  return (status === 'AGENDADO' || status === 'CONFIRMADO') && new Date(startsAt).getTime() > agora.getTime();
}

export function podeConfirmarAgendamento(status: string, startsAt: Date | string, agora: Date = new Date()): boolean {
  return status === 'AGENDADO' && new Date(startsAt).getTime() > agora.getTime();
}

/** Medicamento de uso contínuo: sem prazo definido ou com 60 dias ou mais. */
export function usoContinuo(item: { durationDays?: number | null; frequencyHours?: number | null }): boolean {
  return item.durationDays == null || item.durationDays >= 60;
}

/** Descrição da posologia em linguagem simples ("1 comprimido a cada 12 h por 30 dias"). */
export function posologia(item: { dose?: number | string | null; doseUnit?: string | null; frequencyHours?: number | null; durationDays?: number | null; instructions?: string | null }): string {
  const partes: string[] = [];
  if (item.dose != null) partes.push(`${Number(item.dose)} ${item.doseUnit ?? ''}`.trim());
  if (item.frequencyHours) partes.push(item.frequencyHours === 24 ? '1 vez ao dia' : item.frequencyHours % 24 === 0 ? `a cada ${item.frequencyHours / 24} dias` : `a cada ${item.frequencyHours} h`);
  if (item.durationDays) partes.push(`por ${item.durationDays} dia${item.durationDays > 1 ? 's' : ''}`);
  else partes.push('uso contínuo');
  if (item.instructions) partes.push(item.instructions);
  return partes.join(' · ');
}

/** Código de acesso de 6 dígitos a partir de bytes aleatórios (sem viés de módulo relevante para 6 dígitos). */
export function codigoAcessoDe(bytes: Uint8Array): string {
  let n = 0;
  for (const b of bytes.slice(0, 4)) n = (n * 256 + b) % 1_000_000;
  return String(n).padStart(6, '0');
}

/** Arquivo .ics de um compromisso (adicionar à agenda do telefone). */
export function eventoIcs(e: { uid: string; inicio: Date | string; fim: Date | string; titulo: string; local?: string | null; descricao?: string | null }): string {
  const fmt = (d: Date | string) =>
    new Date(d)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OmniSaude//Cidadao//PT',
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(e.inicio)}`,
    `DTEND:${fmt(e.fim)}`,
    `SUMMARY:${esc(e.titulo)}`,
    ...(e.local ? [`LOCATION:${esc(e.local)}`] : []),
    ...(e.descricao ? [`DESCRIPTION:${esc(e.descricao)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}
