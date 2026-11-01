import { cnsFromBase, completeCpf, validarNumeroAih } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();

describe.runIf(enabled)('Central de leitos da rede e AIH', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let gestora: string;
  let recepcao: string;
  let medica: string;
  let nirHosp: string;
  let nirPoli: string;
  let faturamento: string;
  let hospId = '';
  let upaId = '';
  let pacienteA = '';
  let pacienteB = '';
  let solicitacaoId = '';
  let protocolo = '';
  let leitoReservado = '';
  let admissionId = '';
  let laudoId = '';
  let faixaId = '';
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const address = { cep: '77405070', street: 'Rua dos Leitos', number: '9', district: 'Setor Central', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };
  const vitaisGraves = { pas: 86, pad: 50, fc: 124, fr: 28, sato2: 89, temp: 38.9, consciencia: 'CONFUSO', oxigenio: true };
  const vitaisEstaveis = { pas: 128, pad: 80, fc: 76, fr: 16, sato2: 97, temp: 36.6, consciencia: 'ALERTA', oxigenio: false };

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('leitos', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws` });
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    nirHosp = await t.login('nir', 'Hospital Municipal São Lucas', 'NIR');
    nirPoli = await t.login('nir', 'Policlínica Municipal', 'NIR');
    faturamento = await t.login('faturamento', 'Hospital Municipal São Lucas', 'FATURAMENTO');
    const dir = (await t.http().get('/api/directory').set(auth(gestora)).expect(200)).body;
    hospId = dir.units.find((u: { name: string }) => u.name === 'Hospital Municipal São Lucas').id;
    upaId = dir.units.find((u: { name: string }) => u.name === 'UPA 24h Norte').id;
    const pessoa = async (name: string, cpf: string, cns: string) =>
      (
        await t
          .http()
          .post('/api/patients')
          .set(auth(recepcao))
          .send({ name, birthDate: '1952-09-09', sex: 'M', cpf: completeCpf(cpf), cns: cnsFromBase(cns), motherName: 'Mae Leitos Teste', phone: '(63) 99999-0501', whatsappOptIn: true, address })
          .expect(201)
      ).body.id as string;
    pacienteA = await pessoa('Arnaldo Leitos Teste', '477000501', '27700000501');
    pacienteB = await pessoa('Benedita Leitos Teste', '477000502', '27700000502');
  });

  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  describe('Solicitação de vaga', () => {
    it('médico solicita a vaga com sinais vitais: NEWS2 e prioridade sugerida; uma por pessoa', async () => {
      const r = await t
        .http()
        .post('/api/regulacao-leitos/solicitacoes')
        .set(auth(medica))
        .send({
          patientId: pacienteA,
          bedKind: 'CLINICA_MEDICA',
          specialty: 'Clínica médica',
          cid: 'J18.9',
          clinicalSummary: 'Pneumonia comunitária grave com hipotensão, taquipneia e dessaturação apesar de O2 por cateter.',
          vitals: vitaisGraves,
          support: { oxigenio: true },
          isolation: 'GOTICULAS',
        })
        .expect(201);
      solicitacaoId = r.body.id;
      protocolo = r.body.protocol;
      expect(protocolo).toMatch(/^LEI-\d{4}-\d{6}$/);
      expect(r.body.status).toBe('PENDENTE');
      expect(r.body.news2.pontos).toBe(17);
      expect(r.body.news2.risco).toBe('ALTO');
      expect(r.body.priority).toBe('VERMELHA');
      expect(r.body.cid).toBe('J189');
      expect(r.body.originUnit.name).toBe('UBS Centro');
      expect(r.body.eventos.map((e: { kind: string }) => e.kind)).toEqual(['CRIADA']);
      await t
        .http()
        .post('/api/regulacao-leitos/solicitacoes')
        .set(auth(medica))
        .send({ patientId: pacienteA, bedKind: 'CLINICA_MEDICA', specialty: 'Clínica médica', clinicalSummary: 'Outra solicitação para a mesma pessoa em andamento.' })
        .expect(409);
      await t
        .http()
        .post('/api/regulacao-leitos/solicitacoes')
        .set(auth(recepcao))
        .send({ patientId: pacienteB, bedKind: 'CLINICA_MEDICA', specialty: 'Clínica médica', clinicalSummary: 'Recepção não solicita vaga de leito da rede.' })
        .expect(403);
    });

    it('solicitação eletiva estável vem como AZUL; a fila ordena por prioridade e tempo', async () => {
      const r = await t
        .http()
        .post('/api/regulacao-leitos/solicitacoes')
        .set(auth(medica))
        .send({
          patientId: pacienteB,
          bedKind: 'CIRURGICA',
          specialty: 'Cirurgia geral',
          cid: 'K80',
          clinicalSummary: 'Colelitíase sintomática com indicação de colecistectomia videolaparoscópica eletiva.',
          vitals: vitaisEstaveis,
          elective: true,
        })
        .expect(201);
      expect(r.body.priority).toBe('AZUL');
      expect(r.body.news2.pontos).toBe(0);
      const fila = (await t.http().get('/api/regulacao-leitos/fila').set(auth(nirHosp)).expect(200)).body;
      expect(fila.total).toBeGreaterThanOrEqual(2);
      const ids = fila.itens.map((i: { id: string }) => i.id);
      expect(ids.indexOf(solicitacaoId)).toBeLessThan(ids.indexOf(r.body.id));
      expect(fila.porPrioridade.VERMELHA).toBeGreaterThanOrEqual(1);
      await t.http().get('/api/regulacao-leitos/fila').set(auth(medica)).expect(403);
      const daUnidade = (await t.http().get('/api/regulacao-leitos/solicitacoes').set(auth(medica)).expect(200)).body;
      expect(daUnidade.some((s: { id: string }) => s.id === solicitacaoId)).toBe(true);
      await t.http().post(`/api/regulacao-leitos/solicitacoes/${r.body.id}/cancelar`).set(auth(medica)).send({ reason: 'Paciente optou por serviço particular' }).expect(200);
    });

    it('regulador analisa, devolve com pendência e a origem complementa voltando à fila', async () => {
      const an = await t.http().post(`/api/regulacao-leitos/solicitacoes/${solicitacaoId}/analisar`).set(auth(nirHosp)).expect(200);
      expect(an.body.status).toBe('EM_ANALISE');
      expect(an.body.regulator.name).toContain('NIR');
      const dev = await t.http().post(`/api/regulacao-leitos/solicitacoes/${solicitacaoId}/devolver`).set(auth(nirHosp)).send({ reason: 'Anexar gasometria e radiografia de tórax' }).expect(200);
      expect(dev.body.status).toBe('DEVOLVIDA');
      expect(dev.body.returnedCount).toBe(1);
      await t
        .http()
        .post(`/api/regulacao-leitos/solicitacoes/${solicitacaoId}/autorizar`)
        .set(auth(nirHosp))
        .send({ destinationUnitId: hospId, destinationKind: 'CLINICA_MEDICA', notes: 'Não pode autorizar devolvida' })
        .expect(422);
      const comp = await t
        .http()
        .put(`/api/regulacao-leitos/solicitacoes/${solicitacaoId}`)
        .set(auth(medica))
        .send({ clinicalSummary: 'Pneumonia comunitária grave. Gasometria: pH 7,31, pO2 55, pCO2 48. RX: consolidação em base direita com derrame.', notes: 'Exames anexados' })
        .expect(200);
      expect(comp.body.status).toBe('PENDENTE');
      expect(comp.body.priority).toBe('VERMELHA');
      expect(comp.body.eventos.map((e: { kind: string }) => e.kind)).toEqual(['CRIADA', 'EM_ANALISE', 'DEVOLVIDA', 'COMPLEMENTADA']);
      await t.http().put(`/api/regulacao-leitos/solicitacoes/${solicitacaoId}`).set(auth(nirPoli)).send({ notes: 'NIR de outra unidade edita? Tem leitos_rede.regular, então pode.' }).expect(200);
    });

    it('segunda avaliação exige outro regulador e pode reclassificar', async () => {
      await t.http().post(`/api/regulacao-leitos/solicitacoes/${solicitacaoId}/segunda-avaliacao/pedir`).set(auth(nirHosp)).send({ notes: 'Discutir necessidade de UTI' }).expect(200);
      const det = (await t.http().get(`/api/regulacao-leitos/solicitacoes/${solicitacaoId}`).set(auth(nirHosp)).expect(200)).body;
      expect(det.secondOpinion).toEqual({ at: null, by: null, notes: null });
      await t.http().post(`/api/regulacao-leitos/solicitacoes/${solicitacaoId}/segunda-avaliacao`).set(auth(nirHosp)).send({ notes: 'Eu mesmo' }).expect(422);
      const seg = await t
        .http()
        .post(`/api/regulacao-leitos/solicitacoes/${solicitacaoId}/segunda-avaliacao`)
        .set(auth(gestora))
        .send({ notes: 'Mantém enfermaria com vigilância; sem critério de UTI no momento.', priority: 'AMARELA' })
        .expect(200);
      expect(seg.body.secondOpinion.notes).toContain('vigilância');
      expect(seg.body.priority).toBe('AMARELA');
      expect(seg.body.requestedPriority).toBe('VERMELHA');
    });
  });

  describe('Autorização, reserva, transferência e internação', () => {
    it('mapa da rede mostra os hospitais com vagos por tipo; autorização reserva o leito', async () => {
      const mapa = (await t.http().get('/api/regulacao-leitos/mapa').set(auth(medica)).expect(200)).body;
      const hosp = mapa.unidades.find((u: { unit: { id: string } }) => u.unit.id === hospId);
      expect(hosp).toBeDefined();
      expect(hosp.porTipo.some((p: { tipo: string; vagos: number }) => p.tipo === 'CLINICA_MEDICA' && p.vagos > 0)).toBe(true);
      const vagoCM = hosp.leitosVagos.find((b: { kind: string; isolation: string }) => b.kind === 'CLINICA_MEDICA' && b.isolation === 'NENHUM');
      leitoReservado = vagoCM.id;
      await t
        .http()
        .post(`/api/regulacao-leitos/solicitacoes/${solicitacaoId}/autorizar`)
        .set(auth(nirHosp))
        .send({ destinationUnitId: upaId, destinationKind: 'CLINICA_MEDICA', bedId: leitoReservado, notes: 'Leito de outra unidade' })
        .expect(422);
      const aut = await t
        .http()
        .post(`/api/regulacao-leitos/solicitacoes/${solicitacaoId}/autorizar`)
        .set(auth(nirHosp))
        .send({ destinationUnitId: hospId, destinationKind: 'CLINICA_MEDICA', bedId: leitoReservado, transport: 'AMBULANCIA_BASICA', notes: 'Vaga na clínica médica, leito reservado' })
        .expect(200);
      expect(aut.body.status).toBe('AUTORIZADA');
      expect(aut.body.destination).toMatchObject({ unitName: 'Hospital Municipal São Lucas', kind: 'CLINICA_MEDICA', bed: { code: vagoCM.code } });
      expect(aut.body.transportLabel).toContain('básico');
      const censo = (await t.http().get(`/api/beds/census?unitId=${hospId}`).set(auth(nirHosp)).expect(200)).body;
      const leito = censo.wards.flatMap((w: { beds: { id: string }[] }) => w.beds).find((b: { id: string }) => b.id === leitoReservado);
      expect(leito.status).toBe('RESERVADO');
      expect(leito.reservation).toMatchObject({ protocol: protocolo, name: 'Arnaldo Leitos Teste', originUnit: 'UBS Centro' });
      expect(censo.totals.RESERVADO).toBeGreaterThanOrEqual(1);
      // Leito reservado não pode ser mexido manualmente nem ocupado por outra pessoa.
      await t.http().patch(`/api/beds/${leitoReservado}`).set(auth(nirHosp)).send({ status: 'BLOQUEADO' }).expect(422);
      await t.http().post('/api/admissions').set(auth(nirHosp)).send({ patientId: pacienteB, bedId: leitoReservado, mainCid: 'K80' }).expect(422);
      const mapa2 = (await t.http().get('/api/regulacao-leitos/mapa').set(auth(medica)).expect(200)).body;
      expect(mapa2.unidades.find((u: { unit: { id: string } }) => u.unit.id === hospId).aCaminho).toBe(hosp.aCaminho + 1);
      expect(mapa2.totais.reservados).toBeGreaterThanOrEqual(1);
    });

    it('origem registra a transferência e o destino interna no leito reservado', async () => {
      const cardio = await t.login('cardiologista', 'Policlínica Municipal', 'MEDICO');
      await t.http().post(`/api/regulacao-leitos/solicitacoes/${solicitacaoId}/transferir`).set(auth(cardio)).send({ transport: 'AMBULANCIA_BASICA', notes: 'Policlínica não é a origem' }).expect(403);
      const tr = await t
        .http()
        .post(`/api/regulacao-leitos/solicitacoes/${solicitacaoId}/transferir`)
        .set(auth(medica))
        .send({ transport: 'AMBULANCIA_BASICA', notes: 'Saída às 14h com técnico de enfermagem' })
        .expect(200);
      expect(tr.body.status).toBe('EM_TRANSFERENCIA');
      expect(tr.body.transferAt).toBeTruthy();
      await t.http().post(`/api/regulacao-leitos/solicitacoes/${solicitacaoId}/internar`).set(auth(medica)).send({}).expect(403);
      const int = await t.http().post(`/api/regulacao-leitos/solicitacoes/${solicitacaoId}/internar`).set(auth(nirHosp)).send({}).expect(200);
      admissionId = int.body.admissionId;
      expect(int.body.solicitacao.status).toBe('INTERNADA');
      expect(int.body.solicitacao.admissionId).toBe(admissionId);
      const censo = (await t.http().get(`/api/beds/census?unitId=${hospId}`).set(auth(nirHosp)).expect(200)).body;
      const leito = censo.wards.flatMap((w: { beds: { id: string }[] }) => w.beds).find((b: { id: string }) => b.id === leitoReservado);
      expect(leito.status).toBe('OCUPADO');
      expect(leito.occupant).toMatchObject({ name: 'Arnaldo Leitos Teste', mainCid: 'J189', regulationCode: protocolo });
      expect(leito.isolation).toBe('GOTICULAS');
      const painel = (await t.http().get('/api/regulacao-leitos/painel').set(auth(gestora)).expect(200)).body;
      expect(painel.porStatus.INTERNADA).toBeGreaterThanOrEqual(1);
      expect(painel.ultimos30Dias.internadas).toBeGreaterThanOrEqual(1);
      expect(painel.ultimos30Dias.horasAteDecisao).not.toBeNull();
      const timeline = (await t.http().get(`/api/patients/${pacienteA}/timeline`).set(auth(medica)).expect(200)).body;
      expect(timeline.events.some((e: { type: string }) => e.type === 'LEITO')).toBe(true);
    });

    it('negativa e cancelamento liberam a reserva; a ficha sai em PDF', async () => {
      const nova = (
        await t
          .http()
          .post('/api/regulacao-leitos/solicitacoes')
          .set(auth(medica))
          .send({
            patientId: pacienteB,
            bedKind: 'UTI_ADULTO',
            specialty: 'Terapia intensiva',
            clinicalSummary: 'Sepse de foco urinário com necessidade de droga vasoativa e suporte intensivo.',
            support: { drogaVasoativa: true },
          })
          .expect(201)
      ).body;
      expect(nova.priority).toBe('VERMELHA');
      const mapa = (await t.http().get('/api/regulacao-leitos/mapa').set(auth(nirHosp)).expect(200)).body;
      const uti = mapa.unidades.find((u: { unit: { id: string } }) => u.unit.id === hospId).leitosVagos.find((b: { kind: string }) => b.kind === 'UTI_ADULTO');
      await t
        .http()
        .post(`/api/regulacao-leitos/solicitacoes/${nova.id}/autorizar`)
        .set(auth(nirHosp))
        .send({ destinationUnitId: hospId, destinationKind: 'UTI_ADULTO', bedId: uti.id, transport: 'AMBULANCIA_UTI', notes: 'UTI reservada' })
        .expect(200);
      const pdf = await t.http().get(`/api/regulacao-leitos/solicitacoes/${nova.id}/ficha.pdf`).set(auth(medica)).buffer(true).parse(binaryParser).expect(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      await t.http().post(`/api/regulacao-leitos/solicitacoes/${nova.id}/cancelar`).set(auth(medica)).send({ reason: 'Paciente evoluiu a óbito na origem' }).expect(200);
      const censo = (await t.http().get(`/api/beds/census?unitId=${hospId}`).set(auth(nirHosp)).expect(200)).body;
      expect(censo.wards.flatMap((w: { beds: { id: string; status: string }[] }) => w.beds).find((b: { id: string }) => b.id === uti.id).status).toBe('VAGO');
      const outra = (
        await t
          .http()
          .post('/api/regulacao-leitos/solicitacoes')
          .set(auth(medica))
          .send({ patientId: pacienteB, bedKind: 'CLINICA_MEDICA', specialty: 'Clínica médica', clinicalSummary: 'Solicitação para ser negada pelo regulador por falta de critério.' })
          .expect(201)
      ).body;
      const neg = await t.http().post(`/api/regulacao-leitos/solicitacoes/${outra.id}/negar`).set(auth(nirHosp)).send({ reason: 'Sem critério de internação: manter em observação na origem' }).expect(200);
      expect(neg.body.status).toBe('NEGADA');
      await t.http().post(`/api/regulacao-leitos/solicitacoes/${outra.id}/autorizar`).set(auth(nirHosp)).send({ destinationUnitId: hospId, destinationKind: 'CLINICA_MEDICA', notes: 'Já negada' }).expect(422);
    });
  });

  describe('AIH', () => {
    it('médico emite o laudo da internação; faixa do gestor gera o número com DV e marca a internação', async () => {
      const laudo = {
        patientId: pacienteA,
        admissionId,
        procedureCode: '0303140151',
        procedureName: 'Tratamento de pneumonias ou influenza (gripe)',
        mainCid: 'J189',
        secondaryCid: 'J90',
        specialtyCode: '03',
        nature: '02',
        symptoms: 'Tosse produtiva, febre, dispneia e dor torácica há 5 dias.',
        conditions: 'Hipoxemia, hipotensão e derrame pleural: necessidade de antibiótico venoso e oxigenoterapia.',
        diagnostics: 'RX com consolidação em base direita; gasometria pH 7,31; leucócitos 18.000.',
      };
      await t.http().post('/api/aih/laudos').set(auth(recepcao)).send(laudo).expect(403);
      await t
        .http()
        .post('/api/aih/laudos')
        .set(auth(medica))
        .send({ ...laudo, procedureCode: '12345' })
        .expect(400);
      const l = await t.http().post('/api/aih/laudos').set(auth(medica)).send(laudo).expect(201);
      laudoId = l.body.id;
      expect(l.body.status).toBe('PENDENTE');
      expect(l.body.specialtyLabel).toBe('Clínica médica');
      expect(l.body.natureLabel).toBe('Urgência');
      expect(l.body.admission.bed).toContain('Clínica Médica');
      await t.http().post('/api/aih/laudos').set(auth(medica)).send(laudo).expect(409);
      // Número manual com DV errado é recusado; a faixa do gestor (cadastrada aqui) gera o sequencial seguinte.
      await t.http().post(`/api/aih/laudos/${laudoId}/autorizar`).set(auth(nirHosp)).send({ aihNumber: '1726100000010' }).expect(422);
      await t.http().post('/api/aih/faixas').set(auth(medica)).send({ name: 'Sem permissão', uf: 'TO', year: 2026, seqStart: 10, seqEnd: 11 }).expect(403);
      await t.http().post('/api/aih/faixas').set(auth(nirHosp)).send({ name: 'Faixa invertida', uf: 'TO', year: 2026, seqStart: 12, seqEnd: 11 }).expect(422);
      faixaId = (await t.http().post('/api/aih/faixas').set(auth(nirHosp)).send({ name: 'Faixa teste', uf: 'TO', year: 2026, seqStart: 10, seqEnd: 11 }).expect(201)).body.id;
      const aut = await t.http().post(`/api/aih/laudos/${laudoId}/autorizar`).set(auth(nirHosp)).send({ rangeId: faixaId, notes: 'Autorizada pelo médico autorizador' }).expect(200);
      expect(aut.body.status).toBe('AUTORIZADA');
      expect(aut.body.aihNumber).toMatch(/^17261\d{8}$/);
      expect(validarNumeroAih(aut.body.aihNumber).ok).toBe(true);
      expect(aut.body.aihNumber.slice(5, 12)).toBe('0000010');
      expect(aut.body.validUntil).toBeTruthy();
      const faixas = (await t.http().get('/api/aih/faixas').set(auth(nirHosp)).expect(200)).body;
      expect(faixas.find((f: { id: string }) => f.id === faixaId)).toMatchObject({ usados: 1, restantes: 1 });
      const espelho = (
        await t
          .http()
          .get(`/api/billing/aih-mirror?competencia=${new Date().toISOString().slice(0, 7).replace('-', '')}`)
          .set(auth(faturamento))
          .expect(200)
      ).body;
      expect(espelho.items.find((i: { admissionId: string }) => i.admissionId === admissionId).aihNumber).toBe(aut.body.aihNumber);
      const pdf = await t.http().get(`/api/aih/laudos/${laudoId}/laudo.pdf`).set(auth(faturamento)).buffer(true).parse(binaryParser).expect(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      expect(pdf.headers['content-disposition']).toContain(aut.body.aihNumber);
    });

    it('número manual válido, negativa, faixa esgotada e cancelamento limpam a internação', async () => {
      const segundo = (
        await t
          .http()
          .post('/api/aih/laudos')
          .set(auth(medica))
          .send({
            patientId: pacienteB,
            procedureCode: '0407030034',
            procedureName: 'Colecistectomia videolaparoscópica',
            mainCid: 'K80',
            specialtyCode: '01',
            nature: '01',
            symptoms: 'Dor em hipocôndrio direito pós-prandial recorrente.',
            conditions: 'Colelitíase sintomática com indicação cirúrgica eletiva.',
            diagnostics: 'USG: cálculos múltiplos; vias biliares normais.',
          })
          .expect(201)
      ).body;
      const neg = await t.http().post(`/api/aih/laudos/${segundo.id}/negar`).set(auth(nirHosp)).send({ reason: 'Falta avaliação pré-anestésica' }).expect(200);
      expect(neg.body.status).toBe('NEGADA');
      const terceiro = (
        await t
          .http()
          .post('/api/aih/laudos')
          .set(auth(medica))
          .send({
            patientId: pacienteB,
            procedureCode: '0407030034',
            procedureName: 'Colecistectomia videolaparoscópica',
            mainCid: 'K80',
            specialtyCode: '01',
            nature: '01',
            symptoms: 'Dor em hipocôndrio direito pós-prandial recorrente.',
            conditions: 'Colelitíase sintomática com indicação cirúrgica eletiva; risco anestésico ASA II.',
            diagnostics: 'USG: cálculos múltiplos; avaliação pré-anestésica anexada.',
          })
          .expect(201)
      ).body;
      const manual = await t
        .http()
        .post(`/api/aih/laudos/${terceiro.id}/autorizar`)
        .set(auth(gestora))
        .send({ aihNumber: '1726100000010'.slice(0, 12) + '0', validUntil: '2027-01-31' })
        .expect(422);
      expect(manual.body.message).toContain('verificador');
      // Sem faixa informada, vale a faixa sem unidade (a de teste) ou a da unidade do laudo.
      const auto2 = await t.http().post(`/api/aih/laudos/${terceiro.id}/autorizar`).set(auth(gestora)).send({}).expect(200);
      expect(auto2.body.aihNumber.slice(5, 12)).toBe('0000011');
      const quarto = (
        await t
          .http()
          .post('/api/aih/laudos')
          .set(auth(medica))
          .send({
            patientId: pacienteA,
            procedureCode: '0303140151',
            procedureName: 'Tratamento de pneumonias',
            mainCid: 'J189',
            specialtyCode: '03',
            nature: '02',
            symptoms: 'Piora respiratória com nova febre e tosse.',
            conditions: 'Reinternação por pneumonia com necessidade de antibiótico venoso.',
            diagnostics: 'RX com nova consolidação.',
          })
          .expect(201)
      ).body;
      await t.http().post(`/api/aih/laudos/${quarto.id}/autorizar`).set(auth(gestora)).send({ rangeId: faixaId }).expect(422);
      const numero = (await t.http().get(`/api/aih/laudos/${laudoId}`).set(auth(nirHosp)).expect(200)).body.aihNumber as string;
      await t.http().post(`/api/aih/laudos/${quarto.id}/autorizar`).set(auth(gestora)).send({ aihNumber: numero }).expect(409);
      await t.http().post(`/api/aih/laudos/${quarto.id}/cancelar`).set(auth(medica)).send({ reason: 'Laudo emitido em duplicidade' }).expect(200);
      await t.http().post(`/api/aih/laudos/${laudoId}/cancelar`).set(auth(medica)).send({ reason: 'Médico não cancela AIH autorizada' }).expect(403);
      await t.http().post(`/api/aih/laudos/${laudoId}/cancelar`).set(auth(nirHosp)).send({ reason: 'Número emitido para o paciente errado' }).expect(200);
      const espelho = (
        await t
          .http()
          .get(`/api/billing/aih-mirror?competencia=${new Date().toISOString().slice(0, 7).replace('-', '')}`)
          .set(auth(faturamento))
          .expect(200)
      ).body;
      expect(espelho.items.find((i: { admissionId: string }) => i.admissionId === admissionId).aihNumber).toBeNull();
      const painel = (await t.http().get('/api/aih/painel').set(auth(faturamento)).expect(200)).body;
      expect(painel.porStatus.AUTORIZADA).toBeGreaterThanOrEqual(1);
      const faixas = (await t.http().get('/api/aih/faixas').set(auth(nirHosp)).expect(200)).body;
      expect(faixas.find((f: { id: string }) => f.id === faixaId)).toMatchObject({ usados: 2, restantes: 0 });
      await t.http().patch(`/api/aih/faixas/${faixaId}`).set(auth(nirHosp)).send({ seqEnd: 5 }).expect(422);
      await t.http().patch(`/api/aih/faixas/${faixaId}`).set(auth(nirHosp)).send({ active: false }).expect(200);
      const lista = (await t.http().get('/api/aih/laudos?status=AUTORIZADA').set(auth(medica)).expect(200)).body;
      expect(lista.every((l: { status: string }) => l.status === 'AUTORIZADA')).toBe(true);
    });
  });

  describe('Concorrência', () => {
    it('solicitações simultâneas recebem protocolos distintos', async () => {
      // Uma solicitação em andamento por pessoa: cinco pessoas novas.
      const pessoas: string[] = [];
      for (const [i, nome] of ['Alice', 'Bruna', 'Clara', 'Diana', 'Elisa'].entries()) {
        const p = await t
          .http()
          .post('/api/patients')
          .set(auth(recepcao))
          .send({ name: `${nome} Simultanea Leitos`, birthDate: '1958-03-03', sex: 'F', cpf: completeCpf(`47700051${i}`), cns: cnsFromBase(`2770000051${i}`), motherName: 'Mae Leitos Teste', address })
          .expect(201);
        pessoas.push(p.body.id);
      }
      const juntas = await Promise.all(
        pessoas.map((patientId) =>
          t
            .http()
            .post('/api/regulacao-leitos/solicitacoes')
            .set(auth(medica))
            .send({ patientId, bedKind: 'CLINICA_MEDICA', specialty: 'Clínica médica', clinicalSummary: 'Pneumonia comunitária com necessidade de internação para antibiótico venoso.' }),
        ),
      );
      expect(juntas.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      const protocolos = juntas.map((r) => r.body.protocol as string);
      expect(protocolos.every((p) => /^LEI-\d{4}-\d{6}$/.test(p))).toBe(true);
      expect(new Set(protocolos).size).toBe(5);
    });
  });
});

function binaryParser(res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
