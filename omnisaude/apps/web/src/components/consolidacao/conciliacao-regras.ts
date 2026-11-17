import {
  arredondar,
  EVOLUCAO_CASO,
  ROTULO_GRAVIDADE,
  ROTULO_METODO_VINCULO,
  ROTULO_SITUACAO_CASO,
  SISTEMA_INFO,
  type DivergenciaPar,
  type FiltroConciliacao,
  type MetodoVinculo,
  type NotificacaoParaConciliar,
  type PacienteConciliacao,
  type RegistroOficialResumo,
  type ResumoConciliacao,
  type SistemaOficial,
  type SituacaoCaso,
} from '@omnisaude/shared';

/*
 * Regras da aba Conciliação (listas, vínculo, desvínculo, rejeição e apelido de bairro), sem React (testadas em
 * apps/web/test/conciliacao-regras.test.ts). Os limites são os da API.
 */

/** Linhas por página quando a resposta não diz (a API manda `porPagina` em todas as listas). */
export const POR_PAGINA_CONCILIACAO = 50;
/** Motivo do desvínculo e da rejeição: de 10 a 1.000 caracteres. */
export const MOTIVO_MINIMO = 10;
export const MOTIVO_MAXIMO = 1000;

export const motivoValido = (m: string) => m.trim().length >= MOTIVO_MINIMO && m.trim().length <= MOTIVO_MAXIMO;

/**
 * Consulta das listas (só o que foi preenchido; página 1 fica de fora). O método do vínculo só vale na lista de
 * vinculados: as outras listas chamam com `{ ...filtro, metodo: undefined }`.
 */
export function consultaConciliacao(f: FiltroConciliacao): string {
  const q = new URLSearchParams();
  if (f.sistema) q.set('sistema', f.sistema);
  if (f.grupo) q.set('grupo', f.grupo);
  if (f.de) q.set('de', f.de);
  if (f.ate) q.set('ate', f.ate);
  const busca = f.busca?.trim();
  if (busca) q.set('busca', busca.slice(0, 60));
  if (f.metodo) q.set('metodo', f.metodo);
  if (f.pagina && f.pagina > 1) q.set('pagina', String(f.pagina));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Linhas por página da resposta (`porPagina` da API); sem ele, 50. */
const porPaginaDe = (p: { porPagina?: number }) => (p.porPagina && p.porPagina > 0 ? p.porPagina : POR_PAGINA_CONCILIACAO);

/** "51 a 100 de 120"; "Nenhum registro" com a lista vazia. As linhas por página vêm da API. */
export function textoDaPagina(p: { total: number; pagina: number; porPagina?: number; itens: unknown[] }): string {
  if (!p.total || !p.itens.length) return p.total ? `Página ${p.pagina} vazia (${p.total.toLocaleString('pt-BR')} no total)` : 'Nenhum registro';
  const de = (p.pagina - 1) * porPaginaDe(p) + 1;
  return `${de.toLocaleString('pt-BR')} a ${(de + p.itens.length - 1).toLocaleString('pt-BR')} de ${p.total.toLocaleString('pt-BR')}`;
}

export const temPaginaSeguinte = (p: { total: number; pagina: number; porPagina?: number }) => p.pagina * porPaginaDe(p) < p.total;

/** Métodos do vínculo para o filtro da lista de vinculados (na ordem dos degraus). */
export const METODOS_VINCULO = Object.keys(ROTULO_METODO_VINCULO) as MetodoVinculo[];

/** Vínculo do par em texto: "CNS ou CPF, em 05/03/2026"; sem data, só o método. */
export function textoDoVinculo(v: RegistroOficialResumo['vinculo'], data: (iso: string) => string): string {
  if (!v) return 'Sem vínculo';
  return `${ROTULO_METODO_VINCULO[v.metodo] ?? v.metodo}${v.em ? `, em ${data(v.em)}` : ''}`;
}

/** Rótulo do sistema oficial. */
export const rotuloSistema = (s: SistemaOficial | null | undefined) => (s ? SISTEMA_INFO[s].label : '—');

const dataBr = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');

const ROTULO_CAMPO: Record<DivergenciaPar['campo'], string> = { situacao: 'Situação', evolucao: 'Evolução', encerramento: 'Encerramento' };

/** Divergência do par em texto: os códigos viram rótulos e as datas, dd/mm/aaaa. */
export function textoDivergencia(d: DivergenciaPar): { campo: string; oficial: string; omnisaude: string } {
  const valor = (v: string | null) => {
    if (v === null || v === '') return 'sem informação';
    if (d.campo === 'situacao') return ROTULO_SITUACAO_CASO[v as SituacaoCaso] ?? v;
    if (d.campo === 'evolucao') return EVOLUCAO_CASO[v] ? `${EVOLUCAO_CASO[v]} (${v})` : `código ${v}`;
    return dataBr(v);
  };
  return { campo: ROTULO_CAMPO[d.campo], oficial: valor(d.oficial), omnisaude: valor(d.omnisaude) };
}

const SEXO: Record<string, string> = { M: 'masculino', F: 'feminino', I: 'ignorado' };

export type TomSelo = 'slate' | 'blue' | 'green' | 'amber' | 'red' | 'violet';

/**
 * Selos do registro oficial nas listas, com o texto sempre escrito: situação, gravidade, sigilo, ausência na última
 * exportação (instante formatado por `data`, no fuso da instituição) e exclusão no sistema oficial (o par vinculado
 * continua na lista de vinculados para poder desvincular).
 */
export function selosDoRegistro(r: Pick<RegistroOficialResumo, 'situacao' | 'gravidade' | 'sigiloso' | 'ausenteDesde' | 'excluido'>, data: (iso: string) => string): { texto: string; tom: TomSelo }[] {
  const selos: { texto: string; tom: TomSelo }[] = [{ texto: ROTULO_SITUACAO_CASO[r.situacao] ?? r.situacao, tom: 'slate' }];
  if (r.gravidade) selos.push({ texto: ROTULO_GRAVIDADE[r.gravidade] ?? r.gravidade, tom: 'amber' });
  if (r.sigiloso) selos.push({ texto: 'Sigiloso', tom: 'violet' });
  if (r.excluido) selos.push({ texto: 'Excluído no sistema oficial', tom: 'red' });
  if (r.ausenteDesde) selos.push({ texto: `Não veio na última exportação (${data(r.ausenteDesde)})`, tom: 'amber' });
  return selos;
}

/** Paciente nas listas: nome, nascimento e sexo; "Sigiloso" sem a permissão; "Sem identificação" quando o arquivo não trouxe. */
export function textoPaciente(p: PacienteConciliacao | null, sigiloso: boolean): string {
  if (!p) return sigiloso ? 'Sigiloso (sem permissão para ver a identificação)' : 'Sem identificação';
  const partes = [p.nome ?? 'Sem nome', p.nascimento ? `nasc. ${dataBr(p.nascimento)}` : null, p.sexo ? (SEXO[p.sexo] ?? p.sexo) : null].filter(Boolean);
  return partes.join(' · ');
}

/**
 * Oferecer preencher o número oficial da notificação ao vincular: a notificação ainda não tem número, vai para o
 * mesmo sistema do registro e quem vincula pode digitar (a API exige `vigilancia.digitar` e recusa o vínculo inteiro
 * sem ela).
 */
export function podePreencherNumero(n: Pick<NotificacaoParaConciliar, 'numeroOficial' | 'sistemaOficial'>, r: Pick<RegistroOficialResumo, 'sistema'>, podeDigitar: boolean): boolean {
  return podeDigitar && !n.numeroOficial && n.sistemaOficial === r.sistema;
}

/** Parte vinculada do total de registros oficiais individuais (0 a 100, uma casa, com o ARRED do Excel); null sem registros. */
export function percentualVinculado(r: Pick<ResumoConciliacao, 'registros' | 'vinculados'>): number | null {
  return r.registros ? arredondar((r.vinculados * 100) / r.registros, 1) : null;
}

/**
 * Cobertura de uma importação aplicada em texto: "Sinan Online · dengue, chikungunya · 01/01/2025 a 31/12/2025"; o
 * arquivo de um estabelecimento só leva o CNES ("e-SUS Notifica · covid · só o CNES 9000036 · ...").
 */
export function textoCobertura(c: Pick<ResumoConciliacao['cobertura'][number], 'sistema' | 'grupos' | 'de' | 'ate'> & { cnes?: string | null }): string {
  return [rotuloSistema(c.sistema), c.grupos?.length ? c.grupos.join(', ') : null, c.cnes ? `só o CNES ${c.cnes}` : null, `${dataBr(c.de)} a ${dataBr(c.ate)}`].filter(Boolean).join(' · ');
}

/**
 * Nome acessível dos botões que se repetem em cada linha das listas: começa pelo texto do botão e diz de qual registro
 * ou notificação é (o leitor de tela lista os botões sem a linha).
 */
export const rotuloAcao = {
  vincularRegistro: (numero: string) => `Vincular o registro ${numero}`,
  vincularNotificacao: (numero: string) => `Vincular a notificação ${numero}`,
  desvincularRegistro: (numero: string) => `Desvincular o registro ${numero}`,
  vincularPar: (registro: string, notificacao: string) => `Vincular o registro ${registro} à notificação ${notificacao}`,
  rejeitarPar: (registro: string, notificacao: string) => `Não é o mesmo caso: registro ${registro} e notificação ${notificacao}`,
  apelido: (nome: string) => `Adicionar apelido: ${nome}`,
};

/** O período do filtro: o início não pode vir depois do fim (a API responde 400). Devolve o problema ou null. */
export function erroDoPeriodo(f: Pick<FiltroConciliacao, 'de' | 'ate'>): string | null {
  return f.de && f.ate && f.de > f.ate ? 'O início do período vem depois do fim.' : null;
}

/** Filtro das listas sem a página (trocar o filtro volta para a página 1). */
export const semPagina = (f: FiltroConciliacao): FiltroConciliacao => ({ ...f, pagina: undefined });
