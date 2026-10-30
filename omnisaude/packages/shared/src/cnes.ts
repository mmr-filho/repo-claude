import type { Role } from './roles';
import type { UnitType } from './clinical';

/** Tipos de estabelecimento do CNES (tabela tipounidades do DATASUS). */
export const CNES_UNIT_TYPES: Record<string, string> = {
  '01': 'Posto de saúde',
  '02': 'Centro de saúde / Unidade Básica',
  '04': 'Policlínica',
  '05': 'Hospital geral',
  '07': 'Hospital especializado',
  '15': 'Unidade mista',
  '20': 'Pronto-socorro geral',
  '21': 'Pronto-socorro especializado',
  '22': 'Consultório isolado',
  '32': 'Unidade móvel fluvial',
  '36': 'Clínica / Centro de especialidade',
  '39': 'Unidade de apoio diagnose e terapia (SADT isolado)',
  '40': 'Unidade móvel terrestre',
  '42': 'Unidade móvel pré-hospitalar de urgência',
  '43': 'Farmácia',
  '50': 'Unidade de vigilância em saúde',
  '60': 'Cooperativa ou empresa de cessão de trabalhadores na saúde',
  '61': 'Centro de parto normal isolado',
  '62': 'Hospital-dia isolado',
  '64': 'Central de regulação de serviços de saúde',
  '67': 'Laboratório central de saúde pública (LACEN)',
  '68': 'Central de gestão em saúde',
  '69': 'Centro de atenção hemoterápica e/ou hematológica',
  '70': 'Centro de Atenção Psicossocial (CAPS)',
  '71': 'Centro de apoio à saúde da família',
  '72': 'Unidade de atenção à saúde indígena',
  '73': 'Pronto atendimento',
  '74': 'Polo academia da saúde',
  '75': 'Telessaúde',
  '76': 'Central de regulação médica das urgências',
  '77': 'Serviço de atenção domiciliar isolado (home care)',
  '78': 'Unidade de atenção em regime residencial',
  '79': 'Oficina ortopédica',
  '80': 'Laboratório de saúde pública',
  '81': 'Central de regulação do acesso',
  '82': 'Central de notificação, captação e distribuição de órgãos',
  '83': 'Polo de prevenção de doenças e agravos e promoção da saúde',
  '84': 'Central de abastecimento',
  '85': 'Centro de imunização',
};

/**
 * Tipo do OmniSaúde sugerido para um tipo de estabelecimento do CNES. Sem equivalente direto (vigilância,
 * gestão, hemocentro...), devolve null e a gestão escolhe na importação.
 */
export function unitTypeFromCnes(typeCode: string | number | null | undefined): UnitType | null {
  const code = String(typeCode ?? '').padStart(2, '0');
  switch (code) {
    case '01':
    case '02':
    case '15':
    case '71':
    case '74':
    case '83':
      return 'UBS';
    case '04':
    case '22':
    case '36':
    case '61':
    case '62':
    case '77':
    case '78':
    case '79':
    case '85':
      return 'POLICLINICA';
    case '05':
    case '07':
      return 'HOSPITAL';
    case '20':
    case '21':
    case '73':
      return 'UPA';
    case '32':
    case '40':
    case '42':
    case '76':
      return 'SAMU';
    case '70':
      return 'CAPS';
    case '43':
      return 'FARMACIA_CENTRAL';
    case '84':
      return 'ALMOXARIFADO';
    case '39':
    case '67':
    case '80':
      return 'LABORATORIO';
    default:
      return null;
  }
}

/** Tipos de equipe do CNES (campo TP_EQUIPE). */
export const TEAM_TYPES: Record<string, { sigla: string; label: string }> = {
  '70': { sigla: 'eSF', label: 'Equipe de Saúde da Família' },
  '71': { sigla: 'eSB', label: 'Equipe de Saúde Bucal' },
  '72': { sigla: 'eMulti', label: 'Equipe Multiprofissional' },
  '73': { sigla: 'eCR', label: 'Equipe de Consultório na Rua' },
  '74': { sigla: 'eAPP', label: 'Equipe de Atenção Primária Prisional' },
  '75': { sigla: 'eMAESM', label: 'Equipe Multiprofissional de Atenção Especializada em Saúde Mental' },
  '76': { sigla: 'eAP', label: 'Equipe de Atenção Primária' },
};

export function teamTypeLabel(code: string | null | undefined): string {
  const t = TEAM_TYPES[String(code ?? '').padStart(2, '0')];
  return t ? `${t.sigla} · ${t.label}` : `Tipo ${code ?? '?'}`;
}

/** Papel sugerido a partir da ocupação (CBO 2002); a gestão pode trocar antes de salvar. */
export function roleFromCbo(cbo: string): Role {
  const p4 = cbo.slice(0, 4);
  if (['2251', '2252', '2253', '2231'].includes(p4)) return 'MEDICO';
  if (p4 === '2235' || p4 === '3222') return 'ENFERMAGEM';
  if (p4 === '2234' || p4 === '3251') return 'FARMACIA';
  if (p4 === '2516') return 'SERVICO_SOCIAL';
  if (p4 === '1312') return 'GESTOR';
  if (p4 === '4221') return 'RECEPCAO';
  if (p4 === '4110') return 'FATURAMENTO';
  return 'MULTIPROFISSIONAL';
}

/** Código IBGE com 6 dígitos (sem o dígito verificador), como o CNES usa. */
export function ibge6(code: string): string {
  const digits = code.replace(/\D/g, '');
  return digits.length === 7 ? digits.slice(0, 6) : digits;
}

/** Código IBGE com 7 dígitos: calcula o dígito verificador quando vêm só 6. */
export function ibge7(code: string): string {
  const digits = code.replace(/\D/g, '');
  if (digits.length !== 6) return digits;
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    const n = Number(digits[i]) * (i % 2 === 0 ? 1 : 2);
    sum += n >= 10 ? n - 9 : n;
  }
  return digits + String((10 - (sum % 10)) % 10);
}
