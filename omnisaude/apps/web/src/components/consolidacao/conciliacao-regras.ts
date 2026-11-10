import {
  EVOLUCAO_CASO,
  ROTULO_SITUACAO_CASO,
  SISTEMA_INFO,
  type DivergenciaPar,
  type FiltroConciliacao,
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

/** Linhas por página nas listas da conciliação (o mesmo da API). */
export const POR_PAGINA_CONCILIACAO = 50;
/** Motivo do desvínculo e da rejeição: de 10 a 1.000 caracteres. */
export const MOTIVO_MINIMO = 10;
export const MOTIVO_MAXIMO = 1000;

export const motivoValido = (m: string) => m.trim().length >= MOTIVO_MINIMO && m.trim().length <= MOTIVO_MAXIMO;

/** Consulta das listas (só o que foi preenchido; página 1 fica de fora). */
export function consultaConciliacao(f: FiltroConciliacao): string {
  const q = new URLSearchParams();
  if (f.sistema) q.set('sistema', f.sistema);
  if (f.grupo) q.set('grupo', f.grupo);
  if (f.de) q.set('de', f.de);
  if (f.ate) q.set('ate', f.ate);
  const busca = f.busca?.trim();
  if (busca) q.set('busca', busca.slice(0, 60));
  if (f.pagina && f.pagina > 1) q.set('pagina', String(f.pagina));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** "51 a 100 de 120"; "Nenhum registro" com a lista vazia. */
export function textoDaPagina(p: { total: number; pagina: number; itens: unknown[] }): string {
  if (!p.total || !p.itens.length) return p.total ? `Página ${p.pagina} vazia (${p.total.toLocaleString('pt-BR')} no total)` : 'Nenhum registro';
  const de = (p.pagina - 1) * POR_PAGINA_CONCILIACAO + 1;
  return `${de.toLocaleString('pt-BR')} a ${(de + p.itens.length - 1).toLocaleString('pt-BR')} de ${p.total.toLocaleString('pt-BR')}`;
}

export const temPaginaSeguinte = (p: { total: number; pagina: number }) => p.pagina * POR_PAGINA_CONCILIACAO < p.total;

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

/** Parte vinculada do total de registros oficiais individuais (0 a 100); null sem registros. */
export function percentualVinculado(r: Pick<ResumoConciliacao, 'registros' | 'vinculados'>): number | null {
  return r.registros ? Math.round((r.vinculados / r.registros) * 1000) / 10 : null;
}

/** Cobertura de uma importação aplicada em texto: "Sinan Online · dengue, chikungunya · 01/01/2025 a 31/12/2025". */
export function textoCobertura(c: ResumoConciliacao['cobertura'][number]): string {
  return [rotuloSistema(c.sistema), c.grupos?.length ? c.grupos.join(', ') : null, `${dataBr(c.de)} a ${dataBr(c.ate)}`].filter(Boolean).join(' · ');
}

/** Filtro das listas sem a página (trocar o filtro volta para a página 1). */
export const semPagina = (f: FiltroConciliacao): FiltroConciliacao => ({ ...f, pagina: undefined });
