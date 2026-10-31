/**
 * TFD (Tratamento Fora do Domicílio, Portaria SAS/MS 55/1999) e transporte sanitário: situações do processo,
 * ajuda de custo, frota e viagens, em código compartilhado entre API e telas.
 */

export type StatusTfd = 'ABERTO' | 'ENVIADO' | 'DEFERIDO' | 'INDEFERIDO' | 'AGENDADO' | 'CONCLUIDO' | 'CANCELADO';
export const STATUS_TFD: Record<StatusTfd, string> = {
  ABERTO: 'Laudo em elaboração',
  ENVIADO: 'Enviado à regional / estado',
  DEFERIDO: 'Deferido',
  INDEFERIDO: 'Indeferido',
  AGENDADO: 'Agendado no destino',
  CONCLUIDO: 'Concluído',
  CANCELADO: 'Cancelado',
};
export const STATUS_TFD_ABERTOS: StatusTfd[] = ['ABERTO', 'ENVIADO', 'DEFERIDO', 'AGENDADO'];

export type TransporteTfd = 'RODOVIARIO' | 'AEREO' | 'AMBULANCIA' | 'VEICULO_SANITARIO' | 'PROPRIO';
export const TRANSPORTE_TFD: Record<TransporteTfd, string> = {
  RODOVIARIO: 'Rodoviário (passagem)',
  AEREO: 'Aéreo (passagem)',
  AMBULANCIA: 'Ambulância',
  VEICULO_SANITARIO: 'Veículo do transporte sanitário',
  PROPRIO: 'Meios próprios',
};

export type TipoAjudaCusto = 'PASSAGEM' | 'DIARIA' | 'ALIMENTACAO' | 'HOSPEDAGEM' | 'OUTRO';
export const TIPO_AJUDA_CUSTO: Record<TipoAjudaCusto, string> = { PASSAGEM: 'Passagem', DIARIA: 'Diária', ALIMENTACAO: 'Alimentação', HOSPEDAGEM: 'Hospedagem', OUTRO: 'Outro' };
export type Beneficiario = 'PACIENTE' | 'ACOMPANHANTE';

export interface AjudaCustoItem {
  tipo: TipoAjudaCusto;
  beneficiario: Beneficiario;
  quantidade: number;
  valorUnitario: number;
  descricao?: string | null;
}

/** Total da ajuda de custo (2 casas) e a parte de cada beneficiário. */
export function totalAjudaCusto(itens: AjudaCustoItem[]): { total: number; porBeneficiario: Record<Beneficiario, number> } {
  const r = { total: 0, porBeneficiario: { PACIENTE: 0, ACOMPANHANTE: 0 } as Record<Beneficiario, number> };
  for (const i of itens) {
    const v = Math.round(i.quantidade * i.valorUnitario * 100) / 100;
    r.total = Math.round((r.total + v) * 100) / 100;
    r.porBeneficiario[i.beneficiario] = Math.round((r.porBeneficiario[i.beneficiario] + v) * 100) / 100;
  }
  return r;
}

export function numeroProcessoTfd(ano: number, sequencia: number): string {
  return `TFD-${ano}-${String(sequencia).padStart(6, '0')}`;
}

// ─── Transporte sanitário ─────────────────────────────────────────────────────

export type TipoVeiculo = 'AMBULANCIA_BASICA' | 'AMBULANCIA_UTI' | 'VAN' | 'MICRO_ONIBUS' | 'ONIBUS' | 'CARRO';
export const TIPO_VEICULO: Record<TipoVeiculo, { label: string; assentos: number }> = {
  AMBULANCIA_BASICA: { label: 'Ambulância de suporte básico', assentos: 2 },
  AMBULANCIA_UTI: { label: 'Ambulância UTI (suporte avançado)', assentos: 1 },
  VAN: { label: 'Van', assentos: 12 },
  MICRO_ONIBUS: { label: 'Micro-ônibus', assentos: 20 },
  ONIBUS: { label: 'Ônibus', assentos: 44 },
  CARRO: { label: 'Carro', assentos: 4 },
};

export type StatusViagem = 'PLANEJADA' | 'EM_ANDAMENTO' | 'CONCLUIDA' | 'CANCELADA';
export const STATUS_VIAGEM: Record<StatusViagem, string> = { PLANEJADA: 'Planejada', EM_ANDAMENTO: 'Em andamento', CONCLUIDA: 'Concluída', CANCELADA: 'Cancelada' };

export type StatusPassageiro = 'AGENDADO' | 'EMBARCOU' | 'FALTOU' | 'CANCELADO';
export const STATUS_PASSAGEIRO: Record<StatusPassageiro, string> = { AGENDADO: 'Agendado', EMBARCOU: 'Embarcou', FALTOU: 'Faltou', CANCELADO: 'Cancelado' };

export type TipoRegistroVeiculo = 'MANUTENCAO' | 'ABASTECIMENTO';
export const TIPO_REGISTRO_VEICULO: Record<TipoRegistroVeiculo, string> = { MANUTENCAO: 'Manutenção', ABASTECIMENTO: 'Abastecimento' };

export const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/** Lugares da viagem: cada passageiro ocupa 1 e o acompanhante mais 1; faltas e cancelamentos liberam. */
export function ocupacaoViagem(assentos: number, passageiros: { status: StatusPassageiro; acompanhante: boolean; cadeirante?: boolean }[]) {
  const ativos = passageiros.filter((p) => p.status === 'AGENDADO' || p.status === 'EMBARCOU');
  const usados = ativos.reduce((s, p) => s + 1 + (p.acompanhante ? 1 : 0), 0);
  return { assentos, usados, livres: Math.max(0, assentos - usados), cadeirantes: ativos.filter((p) => p.cadeirante).length, lotada: usados >= assentos };
}

/** Consumo médio (km/l) entre abastecimentos consecutivos com litros informados; null com menos de dois. */
export function consumoMedio(abastecimentos: { odometerKm: number; liters: number | null }[]): number | null {
  const ordenados = [...abastecimentos].filter((a) => a.liters && a.liters > 0).sort((a, b) => a.odometerKm - b.odometerKm);
  if (ordenados.length < 2) return null;
  const km = ordenados[ordenados.length - 1]!.odometerKm - ordenados[0]!.odometerKm;
  const litros = ordenados.slice(1).reduce((s, a) => s + (a.liters as number), 0);
  return km > 0 && litros > 0 ? Math.round((km / litros) * 10) / 10 : null;
}

/** Alertas da frota: CNH vencida/vencendo, manutenção por km ou por data. */
export function alertasFrota(
  veiculos: { plate: string; odometerKm: number; nextMaintenanceKm: number | null; nextMaintenanceAt: Date | null }[],
  motoristas: { name: string; cnhExpiry: Date }[],
  hoje = new Date(),
): string[] {
  const out: string[] = [];
  const em30 = hoje.getTime() + 30 * 86_400_000;
  for (const v of veiculos) {
    if (v.nextMaintenanceKm !== null && v.odometerKm >= v.nextMaintenanceKm) out.push(`${v.plate}: manutenção vencida por km (${v.odometerKm} km, prevista aos ${v.nextMaintenanceKm} km)`);
    else if (v.nextMaintenanceKm !== null && v.nextMaintenanceKm - v.odometerKm <= 500) out.push(`${v.plate}: manutenção em até ${v.nextMaintenanceKm - v.odometerKm} km`);
    if (v.nextMaintenanceAt && v.nextMaintenanceAt.getTime() < hoje.getTime()) out.push(`${v.plate}: manutenção vencida por data`);
    else if (v.nextMaintenanceAt && v.nextMaintenanceAt.getTime() <= em30) out.push(`${v.plate}: manutenção prevista em até 30 dias`);
  }
  for (const m of motoristas) {
    if (m.cnhExpiry.getTime() < hoje.getTime()) out.push(`${m.name}: CNH vencida`);
    else if (m.cnhExpiry.getTime() <= em30) out.push(`${m.name}: CNH vence em até 30 dias`);
  }
  return out;
}
