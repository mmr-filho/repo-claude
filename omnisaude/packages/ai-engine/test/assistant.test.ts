import { describe, expect, it } from 'vitest';
import { assistantOutputSchema, buildAssistantSystemPrompt, gravidadeFinal, interpretarPorRegras, orientacaoTriagem, sinaisDeAlerta, textoMenu, urgenciaNoTexto } from '../src/assistant';

describe('Assistente do WhatsApp: regras sem IA', () => {
  it('reconhece menu numérico e palavras-chave', () => {
    expect(interpretarPorRegras('2').intencao).toBe('AGENDAR');
    expect(interpretarPorRegras('Oi, bom dia').intencao).toBe('SAUDACAO');
    expect(interpretarPorRegras('quero marcar uma consulta').intencao).toBe('AGENDAR');
    expect(interpretarPorRegras('preciso cancelar minha consulta').intencao).toBe('CANCELAR');
    expect(interpretarPorRegras('saiu o resultado do meu exame?').intencao).toBe('EXAMES');
    expect(interpretarPorRegras('qual o horário de funcionamento da UBS Centro').intencao).toBe('UNIDADES');
    expect(interpretarPorRegras('quero falar com um atendente').intencao).toBe('ATENDENTE');
    expect(interpretarPorRegras('quero fazer uma reclamação do atendimento de ontem').intencao).toBe('OUVIDORIA');
    expect(interpretarPorRegras('gostaria de elogiar a enfermeira').intencao).toBe('OUVIDORIA');
    expect(interpretarPorRegras('em que posição estou na fila do cardiologista').intencao).toBe('FILA');
    expect(interpretarPorRegras('obrigada!').intencao).toBe('DESPEDIDA');
    expect(interpretarPorRegras('xyz qualquer coisa').intencao).toBe('OUTRO');
  });

  it('sinais de alerta viram emergência mesmo que o modelo diga o contrário', () => {
    expect(sinaisDeAlerta('estou com dor no peito e falta de ar')).toEqual(['dor no peito', 'falta de ar']);
    expect(interpretarPorRegras('minha mãe desmaiou e não acorda')).toMatchObject({ intencao: 'TRIAGEM', gravidade: 'EMERGENCIA' });
    expect(gravidadeFinal('meu filho está com a boca torta e a fala enrolada', 'NAO_URGENTE')).toMatchObject({ gravidade: 'EMERGENCIA', sinais: ['sinais de AVC'] });
    expect(gravidadeFinal('febre de 39 e vômito que não para', null).gravidade).toBe('URGENCIA');
    expect(gravidadeFinal('dor de garganta há dois dias', null).gravidade).toBe('POUCO_URGENTE');
    expect(interpretarPorRegras('tosse e febre desde ontem')).toMatchObject({ intencao: 'TRIAGEM', gravidade: 'POUCO_URGENTE' });
    expect(urgenciaNoTexto('estou com febre alta e vomitando sem parar e a UBS não quis me atender')).toBe(true);
    expect(urgenciaNoTexto('quero reclamar da demora na recepção')).toBe(false);
  });

  it('orientação de triagem cita 192 na emergência e a UPA na urgência', () => {
    const upa = { nome: 'UPA 24h Norte', tipo: 'UPA', endereco: 'Av. Norte, 100' };
    expect(orientacaoTriagem('EMERGENCIA', { sinais: ['dor no peito'], upa })).toContain('192');
    expect(orientacaoTriagem('EMERGENCIA', { upa })).toContain('UPA 24h Norte');
    expect(orientacaoTriagem('URGENCIA', { upa })).toContain('24 horas');
    expect(orientacaoTriagem('POUCO_URGENTE', { ubs: { nome: 'UBS Centro', tipo: 'UBS' } })).toContain('UBS Centro');
    expect(orientacaoTriagem('NAO_URGENTE', {})).toContain('MARCAR');
  });

  it('menu, prompt e schema', () => {
    expect(textoMenu('Vida', 'Maria')).toContain('Olá, Maria! Sou Vida');
    const prompt = buildAssistantSystemPrompt({
      instituicao: 'Consórcio Vale Verde',
      nomeAssistente: 'Vida',
      unidades: [{ nome: 'UBS Centro', tipo: 'UBS', horario: '7h às 17h' }],
      faq: [{ pergunta: 'Como pego a receita azul?', resposta: 'Com o médico, na consulta.' }],
      cidadao: { primeiroNome: 'Maria', resumo: ['Próxima consulta: 03/11 07:00 na UBS Centro'] },
      agora: '2026-10-31 15:00',
    });
    expect(prompt).toContain('UBS Centro');
    expect(prompt).toContain('receita azul');
    expect(prompt).toContain('Cidadão identificado: Maria');
    expect(assistantOutputSchema.safeParse({ intencao: 'DUVIDA', resposta: 'ok', gravidade: null, sinais: [], especialidade: null, precisaHumano: false }).success).toBe(true);
    expect(assistantOutputSchema.safeParse({ intencao: 'INEXISTENTE', resposta: '', gravidade: null, sinais: [], especialidade: null, precisaHumano: false }).success).toBe(false);
  });
});
