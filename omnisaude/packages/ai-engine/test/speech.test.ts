import { describe, expect, it } from 'vitest';
import { extractVitals, FakeLlmClient, heuristicSoap, structureSoap, WhisperAsrProvider, wordsToNumbers } from '@omnisaude/ai-engine';

describe('números por extenso', () => {
  it.each([
    ['quinhentos', '500'],
    ['cento e vinte por oitenta', '120 por 80'],
    ['trinta e oito virgula cinco', '38.5'],
    ['dois mil e quinhentos', '2500'],
    ['um e meio comprimido', '1.5 comprimido'],
    ['de seis em seis horas', 'de 6 em 6 horas'],
    ['dor e febre', 'dor e febre'],
    ['vinte e um dias', '21 dias'],
  ])('%s -> %s', (input, expected) => {
    expect(wordsToNumbers(input)).toBe(expected);
  });
});

describe('extractVitals', () => {
  it('lê sinais vitais ditados', () => {
    expect(extractVitals('PA 140 por 90, FC 88, saturação 97%, temperatura 38,5, FR 18, HGT 210, dor 7/10')).toEqual({
      systolic: 140,
      diastolic: 90,
      heartRate: 88,
      spo2: 97,
      temperature: 38.5,
      respiratoryRate: 18,
      glucose: 210,
      painScore: 7,
    });
    expect(extractVitals('pressão doze por oito, frequência cardíaca de noventa')).toEqual({ systolic: 120, diastolic: 80, heartRate: 90 });
  });
});

describe('heuristicSoap', () => {
  it('classifica frases por palavras-pista', () => {
    const r = heuristicSoap(
      'Paciente refere cefaleia há 3 dias, nega febre. Ao exame PA 150 por 95, FC 80, bom estado geral. ' +
        'Hipótese diagnóstica de hipertensão descompensada. Prescrevo losartana 50 mg e oriento retorno em 15 dias.',
    );
    expect(r.soap.subjective).toMatch(/cefaleia/);
    expect(r.soap.objective).toMatch(/PA 150 por 95/);
    expect(r.soap.assessment).toMatch(/hipertensão/);
    expect(r.soap.plan).toMatch(/losartana/);
    expect(r.vitals).toMatchObject({ systolic: 150, diastolic: 95, heartRate: 80 });
    expect(r.medications).toEqual(['Losartana']);
    expect(r.source).toBe('heuristic');
  });

  it('respeita comandos de seção falados', () => {
    const r = heuristicSoap('Subjetivo: dor lombar. Piora ao levantar peso.\nObjetivo: Lasègue negativo.\nAvaliação lombalgia mecânica.\nPlano: dipirona e calor local.');
    expect(r.soap).toEqual({
      subjective: 'dor lombar. Piora ao levantar peso.',
      objective: 'Lasègue negativo.',
      assessment: 'lombalgia mecânica.',
      plan: 'dipirona e calor local.',
    });
  });
});

describe('structureSoap com IA', () => {
  it('usa o modelo para os blocos e o texto original para os números', async () => {
    const llm = new FakeLlmClient([
      { subjective: 'Tosse há 5 dias.', objective: 'Sat 95%.', assessment: 'Bronquite aguda.', plan: 'Sintomáticos.', cidSuggestions: [{ code: 'J20.9', description: 'Bronquite aguda' }, { code: 'a', description: 'b' }, { code: 'c', description: 'd' }, { code: 'e', description: 'f' }] },
    ]);
    const r = await structureSoap('tosse há cinco dias, saturação 95', { llm });
    expect(r.source).toBe('llm');
    expect(r.vitals).toEqual({ spo2: 95 });
    expect(r.cidSuggestions).toHaveLength(3);
    expect(llm.calls[0]!.task).toBe('speech-to-soap');
  });
});

describe('WhisperAsrProvider', () => {
  it('envia multipart para /asr e normaliza a resposta', async () => {
    let captured: { url: string; body: FormData } | undefined;
    const fakeFetch = (async (url: URL, init: RequestInit) => {
      captured = { url: String(url), body: init.body as FormData };
      return new Response(JSON.stringify({ text: ' paciente refere dor ', language: 'pt', segments: [{ start: 0, end: 1.2, text: ' paciente ' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const stt = new WhisperAsrProvider({ baseUrl: 'http://whisper:9000/', fetch: fakeFetch });
    const r = await stt.transcribe({ data: new Uint8Array([1, 2, 3]), mimeType: 'audio/webm' });
    expect(r).toEqual({ text: 'paciente refere dor', language: 'pt', segments: [{ start: 0, end: 1.2, text: 'paciente' }] });
    expect(captured!.url).toBe('http://whisper:9000/asr?task=transcribe&language=pt&output=json&encode=true');
    expect(captured!.body.get('audio_file')).toBeInstanceOf(Blob);
  });

  it('erro HTTP vira erro do motor', async () => {
    const stt = new WhisperAsrProvider({ baseUrl: 'http://x', fetch: (async () => new Response('', { status: 503 })) as unknown as typeof fetch });
    await expect(stt.transcribe({ data: new Uint8Array(), mimeType: 'audio/wav' })).rejects.toThrow(/503/);
  });
});
