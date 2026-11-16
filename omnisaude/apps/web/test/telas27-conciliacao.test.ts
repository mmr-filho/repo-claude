import { describe, expect, it } from 'vitest';
import { consultaConciliacao, erroDoPeriodo, METODOS_VINCULO, percentualVinculado, selosDoRegistro, temPaginaSeguinte, textoDaPagina, textoDoVinculo } from '../src/components/consolidacao/conciliacao-regras';
import { fmtDateTz } from '../src/lib/format';

/*
 * Conciliação (web): achado tel-4 (percentual com o ARRED do Excel), ponto K11 (linhas por página vindas da API) e
 * ponto K9 (lista de vinculados com o filtro do método e o registro excluído no sistema oficial).
 */

describe('percentual vinculado (tel-4)', () => {
  it('arredonda o meio para cima, como o ARRED, e não para baixo pelo ponto flutuante', () => {
    // 201/400 = 50,25% (no binário, 0,5024999…): o Math.round sobre o float dava 50,2.
    expect(percentualVinculado({ registros: 400, vinculados: 201 })).toBe(50.3);
    expect(percentualVinculado({ registros: 400, vinculados: 203 })).toBe(50.8);
    expect(percentualVinculado({ registros: 800, vinculados: 402 })).toBe(50.3);
    expect(percentualVinculado({ registros: 3, vinculados: 2 })).toBe(66.7);
    expect(percentualVinculado({ registros: 0, vinculados: 0 })).toBeNull();
  });
});

describe('páginas das listas (K11)', () => {
  it('usa as linhas por página da resposta da API', () => {
    expect(textoDaPagina({ total: 120, pagina: 2, porPagina: 20, itens: new Array(20) })).toBe('21 a 40 de 120');
    expect(temPaginaSeguinte({ total: 45, pagina: 2, porPagina: 20 })).toBe(true);
    expect(temPaginaSeguinte({ total: 40, pagina: 2, porPagina: 20 })).toBe(false);
    // Sem o campo (resposta antiga), 50.
    expect(textoDaPagina({ total: 120, pagina: 2, itens: new Array(50) })).toBe('51 a 100 de 120');
  });
});

describe('filtro das listas', () => {
  it('o período invertido não vai à API (que agora responde 400 VALIDACAO)', () => {
    expect(erroDoPeriodo({ de: '2026-03-01', ate: '2026-02-01' })).toBe('O início do período vem depois do fim.');
    expect(erroDoPeriodo({ de: '2026-02-01', ate: '2026-03-01' })).toBeNull();
    expect(erroDoPeriodo({ de: '2026-02-01' })).toBeNull();
    expect(erroDoPeriodo({})).toBeNull();
  });
});

describe('lista de vinculados (K9)', () => {
  it('a consulta leva o método do vínculo quando escolhido', () => {
    expect(consultaConciliacao({ metodo: 'MANUAL' })).toBe('?metodo=MANUAL');
    expect(consultaConciliacao({ grupo: 'dengue', metodo: 'IDENTIDADE', pagina: 3 })).toBe('?grupo=dengue&metodo=IDENTIDADE&pagina=3');
    expect(consultaConciliacao({ grupo: 'dengue', metodo: undefined })).toBe('?grupo=dengue');
    expect(METODOS_VINCULO).toEqual(['NUMERO_OFICIAL', 'IDENTIDADE', 'MANUAL']);
  });

  it('o registro excluído no sistema oficial ganha o selo (o par continua na lista para desvincular)', () => {
    const data = (iso: string) => fmtDateTz(iso, 'America/Manaus');
    const base = { situacao: 'CONFIRMADO' as const, gravidade: null, sigiloso: false, ausenteDesde: null, excluido: false };
    expect(selosDoRegistro(base, data)).toEqual([{ texto: 'Confirmado', tom: 'slate' }]);
    expect(selosDoRegistro({ ...base, excluido: true, sigiloso: true, gravidade: 'GRAVE' }, data).map((s) => s.texto)).toEqual(['Confirmado', 'Grave', 'Sigiloso', 'Excluído no sistema oficial']);
    // A ausência é um instante: sai a data da instituição (23:30 de 10/11 em Manaus).
    expect(selosDoRegistro({ ...base, ausenteDesde: '2026-11-11T03:30:00.000Z' }, data).map((s) => s.texto)).toContain('Não veio na última exportação (10/11/2026)');
  });

  it('o vínculo do par em texto: método e quando', () => {
    const data = (iso: string) => fmtDateTz(iso, 'America/Sao_Paulo');
    expect(textoDoVinculo({ notificationId: 'n1', numero: '2026/000001', metodo: 'IDENTIDADE', em: '2026-03-05T15:00:00.000Z' }, data)).toBe('CNS ou CPF, em 05/03/2026');
    expect(textoDoVinculo({ notificationId: 'n1', numero: '2026/000001', metodo: 'MANUAL', em: null }, data)).toBe('Manual');
    expect(textoDoVinculo(null, data)).toBe('Sem vínculo');
  });
});
