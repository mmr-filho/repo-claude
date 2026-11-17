import { createRequire } from 'node:module';

/** Um arquivo do Prisma com o histórico de depuração (ver scripts/prisma-sem-historico.cjs). */
export interface ArquivoHistoricoPrisma {
  pacote: string;
  versao: string | null;
  arquivo: string | null;
  obrigatorio: boolean;
  situacao: 'aplicado' | 'pendente' | 'ausente' | 'nao-instalado' | 'erro';
}

interface Script {
  verificar(): ArquivoHistoricoPrisma[];
  orientacao(alvo: ArquivoHistoricoPrisma): string;
}

/**
 * Arquivos do Prisma carregados pela API que ainda guardam em memória os argumentos das últimas 100 chamadas de
 * depuração (o plano e os parâmetros de cada consulta, mesmo com o DEBUG desligado). Vazio quando a correção da
 * instalação está aplicada; cada item traz a orientação do que fazer (docs/PRISMA-MEMORIA.md). Nunca lança: é só
 * diagnóstico, e a API sobe de qualquer jeito.
 */
export function prismaComHistoricoDeDepuracao(): (ArquivoHistoricoPrisma & { orientacao: string })[] {
  try {
    const script = createRequire(__filename)('../scripts/prisma-sem-historico.cjs') as Script;
    return script
      .verificar()
      .filter((a) => a.obrigatorio && a.situacao !== 'aplicado')
      .map((a) => ({ ...a, orientacao: script.orientacao(a) }));
  } catch (err) {
    const motivo = (err instanceof Error ? err.message : String(err)).split('\n')[0];
    return [
      { pacote: '@prisma/client', versao: null, arquivo: null, obrigatorio: true, situacao: 'erro', orientacao: `não foi possível conferir (${motivo})` },
    ];
  }
}
