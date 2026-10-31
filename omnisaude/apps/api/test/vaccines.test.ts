import { cnsFromBase, completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();
const mais = (iso: string, dias: number) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + dias)).toISOString().slice(0, 10);

describe.runIf(enabled)('Sala de vacina: cartão, baixa do lote, RNDS, faltosos e certificado', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let gestora: string;
  let recepcao: string;
  let enfermeira: string;
  let ubsId = '';
  let hoje = '';
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const address = { cep: '77405070', street: 'Rua das Vacinas', number: '1', district: 'Setor Central', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('vaccines', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws`, RNDS_REQUESTER_CPF: '52998224725' });
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    enfermeira = await t.login('enfermeiro', 'UBS Centro', 'ENFERMAGEM');
    const me = (await t.http().get('/api/auth/me').set(auth(gestora)).expect(200)).body;
    ubsId = me.context.unitId;
    hoje = new Intl.DateTimeFormat('en-CA', { timeZone: me.tenant.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  });
  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  let seq = 0;
  async function pessoa(input: { name: string; birthDate: string; sex: 'F' | 'M' }) {
    seq++;
    const p = (
      await t
        .http()
        .post('/api/patients')
        .set(auth(recepcao))
        .send({ ...input, cpf: completeCpf(`47700000${seq}`), cns: cnsFromBase(`277000000${String(seq).padStart(2, '0')}`), motherName: 'Mae Vacinas Teste', address })
        .expect(201)
    ).body;
    await t
      .http()
      .post('/api/households')
      .set(auth(recepcao))
      .send({ ...address, number: String(seq), unitId: ubsId, family: { responsibleId: p.id } })
      .expect(201);
    return p.id as string;
  }

  it('aplica uma dose do lote da sala: abate o estoque, aparece no cartão e entra na fila da RNDS', async () => {
    const bebe = await pessoa({ name: 'Bebe Vacinas Teste', birthDate: mais(hoje, -75), sex: 'M' });
    const estoque = (await t.http().get('/api/vacinas/estoque').set(auth(enfermeira)).expect(200)).body;
    const penta = estoque.find((l: { vaccineCode: string }) => l.vaccineCode === '42');
    expect(penta).toMatchObject({ locationKind: 'SALA_DE_VACINA', quantity: 50, vencido: false });
    const antes = (await t.http().get(`/api/vacinas/cartao?patientId=${bebe}`).set(auth(recepcao)).expect(200)).body;
    expect(antes.doses).toEqual([]);
    const pentaPendente = antes.proximas.find((p: { componente: string }) => p.componente === 'DTP');
    expect(pentaPendente).toMatchObject({ dose: 1, doseCodigo: '1', situacao: 'APRAZADA' });
    expect(antes.proximas.find((p: { componente: string }) => p.componente === 'BCG')).toMatchObject({ situacao: 'ATRASADA' });

    await t.http().post('/api/vacinas/aplicar').set(auth(recepcao)).send({ patientId: bebe, vaccineCode: '42', lotId: penta.lotId, doseCode: '1' }).expect(403);
    const errado = await t.http().post('/api/vacinas/aplicar').set(auth(enfermeira)).send({ patientId: bebe, vaccineCode: '22', lotId: penta.lotId, doseCode: '1' }).expect(400);
    expect(errado.body.code).toBe('LOTE_INCOMPATIVEL');
    const aplicada = (
      await t
        .http()
        .post('/api/vacinas/aplicar')
        .set(auth(enfermeira))
        .send({ patientId: bebe, vaccineCode: '42', lotId: penta.lotId, doseCode: '1', siteCode: '6', nextDueAt: mais(hoje, 60) })
        .expect(201)
    ).body;
    expect(aplicada.cartao.doses).toHaveLength(1);
    expect(aplicada.cartao.doses[0]).toMatchObject({
      vaccineCode: '42',
      dose: '1ª Dose',
      lot: penta.lotNumber,
      route: 'Intramuscular',
      site: 'FACE ANTEROLATERAL EXTERNA DA COXA DIREITA',
      strategy: 'Rotina',
      transcription: false,
      rnds: { status: 'PENDENTE' },
      nextDueAt: mais(hoje, 60),
    });
    expect(aplicada.cartao.aprazamento.find((s: { componente: string; dose: number }) => s.componente === 'DTP' && s.dose === 1).situacao).toBe('APLICADA');
    // 2ª dose: a idade mínima (4 meses) vence depois do intervalo mínimo (30 dias), então manda a idade.
    const nasc = new Date(`${mais(hoje, -75)}T00:00:00Z`);
    const quatroMeses = new Date(nasc.getTime() + 4 * 30.4375 * 86_400_000).toISOString().slice(0, 10);
    expect(aplicada.cartao.proximas.find((p: { componente: string }) => p.componente === 'DTP')).toMatchObject({ dose: 2, prevista: quatroMeses });
    // A hepatite B vem junto na penta: conta como dose do componente (a do nascimento fica coberta).
    expect(aplicada.cartao.aprazamento.find((s: { componente: string; dose: number }) => s.componente === 'HEPB' && s.dose === 1).situacao).toBe('APLICADA');
    const depois = (await t.http().get('/api/vacinas/estoque').set(auth(enfermeira)).expect(200)).body.find((l: { lotId: string }) => l.lotId === penta.lotId);
    expect(depois.quantity).toBe(49);
    const movimentos = (
      await t
        .http()
        .get(`/api/pharmacy/stock/movements?lotId=${penta.lotId}`)
        .set(auth(gestora))
        .ok(() => true)
    ).body;
    if (Array.isArray(movimentos)) expect(movimentos.some((m: { refType: string; quantity: number }) => m.refType === 'Vaccination' && Number(m.quantity) === -1)).toBe(true);

    // Envio à RNDS (simulador): o job de integração monta o RIA com os códigos e o simulador aceita o bundle.
    const dispatch = (await t.http().post('/api/integrations/dispatch').set(auth(gestora)).expect(200)).body;
    expect(dispatch.rnds).toMatchObject({ sent: 1, failed: 0 });
    const received = await fetch(`${mocks.url}/rnds/_received`).then(
      (r) => r.json() as Promise<{ bundle: { entry: { resource: { resourceType: string; lotNumber?: string; protocolApplied?: { doseNumberString: string }[]; vaccineCode?: { coding: { code: string }[] } } }[] } }[]>,
    );
    const imm = received.flatMap((b) => b.bundle.entry.map((e) => e.resource)).find((r) => r.resourceType === 'Immunization');
    expect(imm).toMatchObject({ lotNumber: penta.lotNumber, protocolApplied: [{ doseNumberString: '1' }] });
    expect(imm?.vaccineCode?.coding[0]?.code).toBe('42');
    const cartao = (await t.http().get(`/api/vacinas/cartao?patientId=${bebe}`).set(auth(recepcao)).expect(200)).body;
    expect(cartao.doses[0].rnds.status).toBe('ENVIADO');
  });

  it('recusa lote vencido ou sem saldo e aceita transcrição da caderneta sem mexer no estoque', async () => {
    const crianca = await pessoa({ name: 'Crianca Vacinas Teste', birthDate: mais(hoje, -400), sex: 'F' });
    const estoque = (await t.http().get('/api/vacinas/estoque').set(auth(enfermeira)).expect(200)).body;
    const scr = estoque.find((l: { vaccineCode: string }) => l.vaccineCode === '24');
    const semLote = await t.http().post('/api/vacinas/aplicar').set(auth(enfermeira)).send({ patientId: crianca, vaccineCode: '24', doseCode: '1' }).expect(400);
    expect(semLote.body.code).toBe('LOTE_OBRIGATORIO');
    const transcrita = (
      await t
        .http()
        .post('/api/vacinas/aplicar')
        .set(auth(enfermeira))
        .send({
          patientId: crianca,
          vaccineCode: '15',
          doseCode: '9',
          transcription: true,
          lotNumber: 'BCG-123',
          manufacturer: 'Ataulpho de Paiva',
          appliedAt: new Date(Date.parse(`${mais(hoje, -399)}T12:00:00Z`)).toISOString(),
        })
        .expect(201)
    ).body;
    expect(transcrita.cartao.doses[0]).toMatchObject({ vaccineCode: '15', transcription: true, strategy: 'Serviço privado', rnds: { status: 'NAO_SE_APLICA' } });
    expect(transcrita.cartao.aprazamento.find((s: { componente: string }) => s.componente === 'BCG').situacao).toBe('APLICADA');
    await t.http().post('/api/vacinas/aplicar').set(auth(enfermeira)).send({ patientId: crianca, vaccineCode: '24', lotId: scr.lotId, doseCode: '1' }).expect(201);
    const depois = (await t.http().get('/api/vacinas/estoque').set(auth(enfermeira)).expect(200)).body.find((l: { lotId: string }) => l.lotId === scr.lotId);
    expect(depois.quantity).toBe(49);
    const futura = await t
      .http()
      .post('/api/vacinas/aplicar')
      .set(auth(enfermeira))
      .send({ patientId: crianca, vaccineCode: '24', lotId: scr.lotId, doseCode: '2', appliedAt: new Date(Date.now() + 2 * 86_400_000).toISOString() })
      .expect(400);
    expect(futura.body.code).toBe('DATA_FUTURA');
  });

  it('lista faltosos e aprazamentos da unidade e emite o certificado em PDF', async () => {
    const faltosos = (await t.http().get(`/api/vacinas/faltosos?unitId=${ubsId}`).set(auth(enfermeira)).expect(200)).body;
    const bebe = faltosos.pessoas.find((p: { nome: string }) => p.nome === 'Bebe Vacinas Teste');
    expect(bebe).toBeDefined();
    expect(bebe.atrasadas.map((d: { componente: string }) => d.componente)).toContain('BCG');
    expect(bebe.atrasadas.map((d: { componente: string }) => d.componente)).not.toContain('DTP');
    const aprazamentos = (
      await t
        .http()
        .get(`/api/vacinas/aprazamentos?unitId=${ubsId}&from=${hoje}&to=${mais(hoje, 60)}`)
        .set(auth(enfermeira))
        .expect(200)
    ).body;
    expect(aprazamentos.doses.some((d: { nome: string; dose: { componente: string; dose: number } }) => d.nome === 'Bebe Vacinas Teste' && d.dose.componente === 'DTP' && d.dose.dose === 2)).toBe(true);
    const crianca = (await t.http().get('/api/patients?q=Crianca Vacinas Teste').set(auth(recepcao)).expect(200)).body[0];
    const pdf = await t
      .http()
      .get(`/api/vacinas/certificado?patientId=${crianca.id}`)
      .set(auth(recepcao))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.body as Buffer).length).toBeGreaterThan(2000);
    const calendario = (await t.http().get('/api/vacinas/calendario').set(auth(recepcao)).expect(200)).body;
    expect(calendario.imunobiologicos.some((i: { code: string }) => i.code === '42')).toBe(true);
    expect(calendario.regras.length).toBeGreaterThan(30);
  });
});
