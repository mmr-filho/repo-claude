/**
 * Regras da ficha de visita domiciliar e territorial do e-SUS (LEDI 8.7.0) conferidas no aparelho, antes da fila: as
 * mesmas de `conferirEntradaVisita` (packages/esus), que a API aplica na sincronização. Um teste do pacote compara as
 * duas para não divergirem.
 */

/** Comércio, terreno baldio, ponto estratégico, escola, creche, estabelecimento religioso e CASAI. */
export const TIPOS_IMOVEL_NAO_DOMICILIO: ReadonlySet<string> = new Set(['02', '03', '04', '05', '06', '12', '13']);

/** Únicos motivos aceitos fora do domicílio: cadastramento, convite, outros, orientação e controle ambiental e vetorial. */
export const MOTIVOS_FORA_DO_DOMICILIO: ReadonlySet<string> = new Set(['1', '27', '28', '31', '34', '35', '36', '37']);

/** Busca ativa (2, 3, 4, 30), acompanhamento (5 a 24, 32, 33, 38), egresso de internação (25) e orientação/prevenção (31). */
export const MOTIVOS_EXIGEM_PESSOA: ReadonlySet<string> = new Set(['2', '3', '4', '30', ...Array.from({ length: 20 }, (_, i) => String(i + 5)), '32', '33', '38', '25', '31']);

/** Abrigo, ILPI, unidade prisional, socioeducativa, delegacia e outros: a pessoa só é obrigatória pelo motivo ou pela medição. */
const TIPOS_PESSOA_PELO_MOTIVO: ReadonlySet<string> = new Set(['07', '08', '09', '10', '11', '99']);

export interface VisitaNaEntrada {
  tipoImovel: string;
  desfecho: string;
  motivos: string[];
  pessoa: boolean;
  medicao: boolean;
  pesoOuAltura: boolean;
}

/** Primeiro problema da visita (código e mensagem), ou null. */
export function conferirEntradaVisita(v: VisitaNaEntrada): { codigo: string; mensagem: string } | null {
  // Código fora da tabela vai como domicílio, como na ficha.
  const tipo = /^(0[1-9]|1[0-3]|99)$/.test(v.tipoImovel) ? v.tipoImovel : '01';
  const realizada = v.desfecho === '1';
  const motivos = v.motivos.map((m) => String(Number(m)));
  if (TIPOS_IMOVEL_NAO_DOMICILIO.has(tipo)) {
    if (v.pessoa)
      return {
        codigo: 'PESSOA_FORA_DO_DOMICILIO',
        mensagem: 'Em imóvel que não é domicílio (comércio, terreno baldio, ponto estratégico, escola, creche, igreja ou CASAI) a visita não identifica pessoa: registre a visita ao imóvel',
      };
    if (v.medicao) return { codigo: 'MEDICAO_FORA_DO_DOMICILIO', mensagem: 'Em imóvel que não é domicílio a visita não leva medições (peso, altura, pressão, temperatura ou glicemia)' };
    if (realizada && motivos.some((m) => !MOTIVOS_FORA_DO_DOMICILIO.has(m)))
      return {
        codigo: 'MOTIVO_FORA_DO_DOMICILIO',
        mensagem:
          'Em imóvel que não é domicílio a visita só aceita os motivos cadastramento, convite para atividades coletivas, orientação/prevenção, controle ambiental e vetorial (ação educativa, imóvel com foco, ação mecânica, tratamento focal) e outros',
      };
    return null;
  }
  if (!realizada || v.pessoa) return null;
  if (tipo === '01') return { codigo: 'PESSOA_OBRIGATORIA', mensagem: 'Visita realizada a um domicílio precisa informar a pessoa visitada' };
  if (TIPOS_PESSOA_PELO_MOTIVO.has(tipo) && (v.pesoOuAltura || motivos.some((m) => MOTIVOS_EXIGEM_PESSOA.has(m))))
    return { codigo: 'PESSOA_OBRIGATORIA', mensagem: 'Visita com motivo de busca ativa, acompanhamento, egresso de internação ou orientação (ou com peso e altura) precisa informar a pessoa visitada' };
  return null;
}
