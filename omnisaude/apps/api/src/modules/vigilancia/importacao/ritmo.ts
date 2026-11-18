import { setImmediate as proximaVolta } from 'node:timers/promises';

/**
 * Trabalho longo em fatias (VIG-1c): cede o laço de eventos depois de `fatiaMs` de trabalho síncrono, para a API seguir
 * atendendo os outros pedidos durante a leitura de um envio grande. O container da produção tem 1/4 de vCPU: uma fatia
 * de 20 ms aqui vira cerca de 80 ms lá.
 */
export class Ritmo {
  private desde = performance.now();

  constructor(private readonly fatiaMs = 20) {}

  /** Cede a vez se a fatia acabou (senão volta na hora). */
  async ceder(): Promise<void> {
    if (performance.now() - this.desde < this.fatiaMs) return;
    await proximaVolta();
    this.desde = performance.now();
  }
}

/**
 * Cópia plana do texto. Um pedaço de texto com 13 caracteres ou mais (fatia, concatenação) pode segurar viva a string
 * de onde saiu; o que fica guardado durante o envio inteiro (chaves, avisos, amostras) passa por aqui.
 */
export function plana(s: string): string;
export function plana(s: string | null): string | null;
export function plana(s: string | null): string | null {
  return s === null || s.length < 13 ? s : (' ' + s).slice(1);
}
