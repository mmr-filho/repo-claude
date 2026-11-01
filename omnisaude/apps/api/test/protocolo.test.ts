import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/core/errors';
import { anoDoProtocolo, gravarComProtocolo } from '../src/core/protocolo';

describe('Número de protocolo', () => {
  it('o ano segue o fuso da instituição, não o UTC do servidor', () => {
    // 31/12/2026 às 22h em Brasília já é 01/01/2027 em UTC.
    const virada = new Date('2027-01-01T01:00:00Z');
    expect(anoDoProtocolo('America/Sao_Paulo', virada)).toBe(2026);
    expect(anoDoProtocolo('UTC', virada)).toBe(2027);
  });

  it('com índice único recusando (P2002), tenta o número seguinte; outros erros não são repetidos', async () => {
    const saltos: number[] = [];
    const gravados: string[] = [];
    const ocupados = new Set(['N-1', 'N-2']);
    const r = await gravarComProtocolo(
      async (salto) => {
        saltos.push(salto);
        return `N-${salto + 1}`;
      },
      async (protocolo) => {
        if (ocupados.has(protocolo)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        gravados.push(protocolo);
        return protocolo;
      },
    );
    expect(r).toBe('N-3');
    expect(saltos).toEqual([0, 1, 2]);
    expect(gravados).toEqual(['N-3']);

    let chamadas = 0;
    const outro = Object.assign(new Error('fk'), { code: 'P2003' });
    await expect(
      gravarComProtocolo(
        async () => 'N-1',
        async () => {
          chamadas++;
          throw outro;
        },
      ),
    ).rejects.toBe(outro);
    expect(chamadas).toBe(1);
  });

  it('desiste depois de 5 tentativas com PROTOCOLO_INDISPONIVEL', async () => {
    let chamadas = 0;
    const falha = gravarComProtocolo(
      async (salto) => `N-${salto}`,
      async () => {
        chamadas++;
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      },
    );
    await expect(falha).rejects.toBeInstanceOf(DomainError);
    await expect(falha).rejects.toMatchObject({ code: 'PROTOCOLO_INDISPONIVEL' });
    expect(chamadas).toBe(5);
  });
});
