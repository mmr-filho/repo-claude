import { describe, expect, it } from 'vitest';
import { templatePayload } from '../src/client';
import { buildRegulationUpdateTemplate, TEMPLATE_DEFINITIONS } from '../src/templates';

describe('devolutiva da regulação por WhatsApp', () => {
  it('monta o modelo regulacao_atualizacao com os parâmetros na ordem do corpo aprovado', () => {
    const t = buildRegulationUpdateTemplate({
      patientName: 'Maria Aparecida da Silva',
      procedureName: 'consulta com Cardiologia',
      protocol: 'REG-2026-000001',
      status: 'AUTORIZADA',
      detail: 'Unidade: Policlínica Municipal',
    });
    expect(t.name).toBe('regulacao_atualizacao');
    expect(t.bodyParams).toEqual(['Maria', 'consulta com Cardiologia', 'REG-2026-000001', 'foi autorizado pela regulação', 'Unidade: Policlínica Municipal']);
    expect(t.buttons).toEqual([]);
    const def = TEMPLATE_DEFINITIONS.find((d) => d.name === 'regulacao_atualizacao')!;
    expect(def.body.match(/\{\{\d\}\}/g)).toHaveLength(t.bodyParams.length);
    const payload = templatePayload('5563999990101', t) as { template: { components: { type: string }[] } };
    expect(payload.template.components.map((c) => c.type)).toEqual(['body']);
    expect(buildRegulationUpdateTemplate({ patientName: 'José', procedureName: 'mamografia', protocol: 'REG-2026-000002', status: 'NEGADA' }).bodyParams[4]).toBe('Acompanhe pela unidade.');
  });
});
