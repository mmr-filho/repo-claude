import { describe, expect, it } from 'vitest';
import {
  calcularNps,
  classificarNps,
  faixaPrazo,
  inferirAssuntoManifestacao,
  inferirTipoManifestacao,
  manifestacaoTemConteudo,
  numeroProtocoloOuvidoria,
  pedeAnonimato,
  prazoResposta,
  resumoSatisfacao,
  situacaoPrazo,
} from '../src/ouvidoria';

describe('Ouvidoria e satisfação', () => {
  it('protocolo e prazo legal de 30 dias', () => {
    expect(numeroProtocoloOuvidoria(2026, 7)).toBe('OUV-2026-000007');
    const recebida = new Date('2026-10-01T12:00:00Z');
    expect(prazoResposta(recebida).toISOString()).toBe('2026-10-31T12:00:00.000Z');
    expect(situacaoPrazo('2026-10-31T12:00:00Z', new Date('2026-10-10T12:00:00Z'))).toMatchObject({ situacao: 'NO_PRAZO', diasRestantes: 21 });
    expect(situacaoPrazo('2026-10-31T12:00:00Z', new Date('2026-10-28T12:00:00Z')).situacao).toBe('VENCE_EM_BREVE');
    expect(situacaoPrazo('2026-10-31T12:00:00Z', new Date('2026-11-02T12:00:00Z')).situacao).toBe('VENCIDA');
    // Uma hora e quase um dia depois do prazo já é vencida (não "vence em breve").
    expect(situacaoPrazo('2026-10-31T12:00:00Z', new Date('2026-10-31T13:00:00Z'))).toMatchObject({ situacao: 'VENCIDA', diasRestantes: -1 });
    expect(situacaoPrazo('2026-10-31T12:00:00Z', new Date('2026-11-01T11:59:00Z'))).toMatchObject({ situacao: 'VENCIDA', diasRestantes: -1 });
    const agora = new Date('2026-10-10T12:00:00Z');
    expect(faixaPrazo('VENCIDA', agora)).toEqual({ lt: agora });
    expect(faixaPrazo('VENCE_EM_BREVE', agora)).toEqual({ gte: agora, lt: new Date('2026-10-15T12:00:00Z') });
    expect(faixaPrazo('NO_PRAZO', agora)).toEqual({ gte: new Date('2026-10-15T12:00:00Z') });
  });

  it('infere tipo e assunto do texto do cidadão', () => {
    expect(inferirTipoManifestacao('Quero elogiar a enfermeira Ana, atendimento excelente')).toBe('ELOGIO');
    expect(inferirTipoManifestacao('Sugiro que a UBS abra no horário de almoço')).toBe('SUGESTAO');
    expect(inferirTipoManifestacao('Fui destratada e houve cobrança indevida')).toBe('DENUNCIA');
    expect(inferirTipoManifestacao('Esperei 4 horas e ninguém me atendeu')).toBe('RECLAMACAO');
    expect(inferirAssuntoManifestacao('Esperei 4 horas e ninguém me atendeu')).toBe('TEMPO_ESPERA');
    expect(inferirAssuntoManifestacao('o banheiro estava sujo')).toBe('ESTRUTURA');
    expect(inferirAssuntoManifestacao('não consigo marcar consulta')).toBe('AGENDAMENTO');
    expect(pedeAnonimato('Quero fazer uma denúncia anônima sobre a farmácia')).toBe(true);
    expect(pedeAnonimato('não quero me identificar')).toBe(true);
    expect(pedeAnonimato('quero reclamar do atendimento')).toBe(false);
    expect(manifestacaoTemConteudo('Quero fazer uma reclamação')).toBe(false);
    expect(manifestacaoTemConteudo('Quero fazer uma denúncia anônima')).toBe(false);
    expect(manifestacaoTemConteudo('Quero reclamar: o banheiro da unidade estava sujo')).toBe(true);
    expect(manifestacaoTemConteudo('Gostaria de elogiar a enfermeira Ana da sala de vacina')).toBe(true);
  });

  it('NPS e resumo de satisfação', () => {
    expect(classificarNps(10)).toBe('PROMOTOR');
    expect(classificarNps(7)).toBe('NEUTRO');
    expect(classificarNps(3)).toBe('DETRATOR');
    expect(calcularNps([10, 9, 8, 2])).toBe(25);
    expect(calcularNps([])).toBeNull();
    const r = resumoSatisfacao([
      { score: 5, recommend: 10 },
      { score: 4, recommend: 8 },
      { score: 2, recommend: 3 },
      { score: null, recommend: null },
    ]);
    expect(r).toMatchObject({ enviadas: 4, respondidas: 3, taxaResposta: 75, media: 3.7, nps: 0 });
    expect(r.distribuicao).toEqual({ 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 });
  });
});
