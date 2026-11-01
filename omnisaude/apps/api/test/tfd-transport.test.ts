import { cnsFromBase, completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();
const diaMais = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe.runIf(enabled)('TFD e transporte sanitário', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let gestora: string;
  let recepcao: string;
  let medica: string;
  let nir: string;
  let social: string;
  let pacienteA = '';
  let pacienteB = '';
  let pacienteC = '';
  let veiculoId = '';
  let vanId = '';
  let motoristaId = '';
  let motoristaVencidoId = '';
  let rotaId = '';
  let viagemId = '';
  let processoId = '';
  let protocolo = '';
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const address = { cep: '77405070', street: 'Rua do Embarque', number: '12', district: 'Setor Central', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };
  const laudo = (patientId: string, extra: Record<string, unknown> = {}) => ({
    patientId,
    cid: 'C50',
    diagnosis: 'Neoplasia maligna da mama',
    procedureName: 'Radioterapia',
    procedureCode: '0304010316',
    clinicalSummary: 'Carcinoma ductal invasivo, estadiamento IIB, pós-mastectomia; indicada radioterapia adjuvante em 25 sessões.',
    justification: 'O município não dispõe de serviço de radioterapia habilitado; referência estadual em Palmas.',
    urgency: false,
    destinationCity: 'Palmas',
    destinationUf: 'TO',
    destinationIbge: '1721000',
    destinationUnit: 'Hospital Geral de Palmas',
    transport: 'RODOVIARIO',
    needsCompanion: true,
    companionName: 'Carlos Acompanhante Teste',
    companionRelation: 'Esposo',
    accommodation: true,
    ...extra,
  });

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('tfd', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws` });
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    nir = await t.login('nir', 'Policlínica Municipal', 'NIR');
    social = await t.login('social', 'UBS Centro', 'SERVICO_SOCIAL');
    const pessoa = async (name: string, cpf: string, cns: string) =>
      (
        await t
          .http()
          .post('/api/patients')
          .set(auth(recepcao))
          .send({ name, birthDate: '1965-07-07', sex: 'F', cpf: completeCpf(cpf), cns: cnsFromBase(cns), motherName: 'Mae Viagem Teste', phone: '(63) 99999-0401', whatsappOptIn: true, address })
          .expect(201)
      ).body.id as string;
    pacienteA = await pessoa('Amanda Viagem Teste', '477000401', '27700000401');
    pacienteB = await pessoa('Beatriz Viagem Teste', '477000402', '27700000402');
    pacienteC = await pessoa('Cecilia Viagem Teste', '477000403', '27700000403');
  });

  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  describe('Frota, motoristas e rotas', () => {
    it('cadastra veículos (placa única) e registra abastecimento e manutenção', async () => {
      const v = await t
        .http()
        .post('/api/transporte/veiculos')
        .set(auth(nir))
        .send({ plate: 'TST1A23', model: 'Mercedes Sprinter', kind: 'VAN', seats: 4, wheelchair: false, odometerKm: 10000, nextMaintenanceKm: 10500 })
        .expect(201);
      veiculoId = v.body.id;
      expect(v.body.kindLabel).toBe('Van');
      await t.http().post('/api/transporte/veiculos').set(auth(nir)).send({ plate: 'TST1A23', model: 'Outro', kind: 'CARRO' }).expect(409);
      const van = await t.http().post('/api/transporte/veiculos').set(auth(nir)).send({ plate: 'TST9Z99', model: 'Fiat Ducato acessível', kind: 'VAN', wheelchair: true, odometerKm: 500 }).expect(201);
      vanId = van.body.id;
      expect(van.body.seats).toBe(12);
      await t.http().post(`/api/transporte/veiculos/${veiculoId}/registros`).set(auth(nir)).send({ kind: 'ABASTECIMENTO', odometerKm: 10000, cost: 300, liters: 50, description: 'Diesel S10' }).expect(201);
      await t.http().post(`/api/transporte/veiculos/${veiculoId}/registros`).set(auth(nir)).send({ kind: 'ABASTECIMENTO', odometerKm: 10400, cost: 240, description: 'sem litros' }).expect(422);
      await t.http().post(`/api/transporte/veiculos/${veiculoId}/registros`).set(auth(nir)).send({ kind: 'ABASTECIMENTO', odometerKm: 10400, cost: 240, liters: 40, description: 'Diesel S10' }).expect(201);
      const frota = (await t.http().get('/api/transporte/veiculos').set(auth(recepcao)).expect(200)).body;
      const mine = frota.veiculos.find((x: { id: string }) => x.id === veiculoId);
      expect(mine.odometerKm).toBe(10400);
      expect(mine.consumoMedioKmL).toBe(10);
      expect(frota.alertas.some((a: string) => a.includes('TST1A23'))).toBe(true);
      await t
        .http()
        .post(`/api/transporte/veiculos/${veiculoId}/registros`)
        .set(auth(nir))
        .send({ kind: 'MANUTENCAO', odometerKm: 10400, cost: 800, description: 'Troca de óleo e filtros', nextMaintenanceKm: 20000 })
        .expect(201);
      const depois = (await t.http().get('/api/transporte/veiculos').set(auth(recepcao)).expect(200)).body;
      expect(depois.alertas.some((a: string) => a.includes('TST1A23'))).toBe(false);
      const registros = (await t.http().get(`/api/transporte/veiculos/${veiculoId}/registros`).set(auth(recepcao)).expect(200)).body;
      expect(registros).toHaveLength(3);
    });

    it('cadastra motoristas e alerta CNH vencida ou a vencer', async () => {
      motoristaId = (
        await t
          .http()
          .post('/api/transporte/motoristas')
          .set(auth(nir))
          .send({ name: 'Joaquim Motorista Teste', cnh: '11122233344', cnhCategory: 'D', cnhExpiry: diaMais(400), phone: '(63) 98888-0001' })
          .expect(201)
      ).body.id;
      motoristaVencidoId = (
        await t
          .http()
          .post('/api/transporte/motoristas')
          .set(auth(nir))
          .send({ name: 'Vencido Motorista Teste', cnh: '55566677788', cnhCategory: 'D', cnhExpiry: diaMais(-3) })
          .expect(201)
      ).body.id;
      const lista = (await t.http().get('/api/transporte/motoristas').set(auth(recepcao)).expect(200)).body;
      expect(lista.find((m: { id: string }) => m.id === motoristaVencidoId).cnhVencida).toBe(true);
      expect(lista.find((m: { id: string }) => m.id === motoristaId).cnhVencida).toBe(false);
      const frota = (await t.http().get('/api/transporte/veiculos').set(auth(recepcao)).expect(200)).body;
      expect(frota.alertas.some((a: string) => a.includes('Vencido Motorista Teste'))).toBe(true);
    });

    it('cadastra rota com dias da semana e pontos de embarque', async () => {
      const r = await t
        .http()
        .post('/api/transporte/rotas')
        .set(auth(nir))
        .send({
          name: 'Teste → Palmas',
          destinationCity: 'Palmas',
          destinationUf: 'TO',
          weekdays: [1, 3, 5],
          departureTime: '04:30',
          returnTime: '18:00',
          vehicleId: veiculoId,
          stops: [
            { nome: 'UBS Centro', horario: '04:30' },
            { nome: 'Rodoviária', endereco: 'Av. Goiás', horario: '04:45' },
          ],
        })
        .expect(201);
      rotaId = r.body.id;
      expect(r.body.stops).toHaveLength(2);
      await t
        .http()
        .post('/api/transporte/rotas')
        .set(auth(recepcao))
        .send({ name: 'Sem permissão', destinationCity: 'Palmas', destinationUf: 'TO', weekdays: [1], departureTime: '05:00' })
        .expect(403);
    });
  });

  describe('Viagens e passageiros', () => {
    it('cria viagem a partir da rota, recusa CNH vencida e veículo ocupado', async () => {
      await t
        .http()
        .post('/api/transporte/viagens')
        .set(auth(nir))
        .send({ routeId: rotaId, driverId: motoristaVencidoId, date: diaMais(3) })
        .expect(422);
      const v = await t
        .http()
        .post('/api/transporte/viagens')
        .set(auth(nir))
        .send({ routeId: rotaId, driverId: motoristaId, date: diaMais(3) })
        .expect(201);
      viagemId = v.body.id;
      expect(v.body.destinationCity).toBe('Palmas');
      expect(v.body.departureTime).toBe('04:30');
      expect(v.body.vehicle.plate).toBe('TST1A23');
      expect(v.body.ocupacao).toMatchObject({ assentos: 4, usados: 0, livres: 4 });
      await t
        .http()
        .post('/api/transporte/viagens')
        .set(auth(nir))
        .send({ routeId: rotaId, driverId: motoristaId, date: diaMais(3) })
        .expect(409);
    });

    it('inclui passageiros respeitando lotação e acessibilidade', async () => {
      const a = await t
        .http()
        .post(`/api/transporte/viagens/${viagemId}/passageiros`)
        .set(auth(nir))
        .send({ patientId: pacienteA, companionName: 'Filho da Amanda', appointmentAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), appointmentPlace: 'HGP · oncologia' })
        .expect(200);
      expect(a.body.viagem.ocupacao).toMatchObject({ usados: 2, livres: 2 });
      expect(a.body.viagem.passageiros[0].pickupAddress).toContain('Rua do Embarque');
      await t.http().post(`/api/transporte/viagens/${viagemId}/passageiros`).set(auth(nir)).send({ patientId: pacienteA }).expect(409);
      await t.http().post(`/api/transporte/viagens/${viagemId}/passageiros`).set(auth(nir)).send({ patientId: pacienteB, wheelchair: true }).expect(422);
      const b = await t.http().post(`/api/transporte/viagens/${viagemId}/passageiros`).set(auth(nir)).send({ patientId: pacienteB, companionName: 'Mãe da Beatriz' }).expect(200);
      expect(b.body.viagem.ocupacao).toMatchObject({ usados: 4, livres: 0, lotada: true });
      await t.http().post(`/api/transporte/viagens/${viagemId}/passageiros`).set(auth(nir)).send({ patientId: pacienteC }).expect(422);
      await t.http().post(`/api/transporte/viagens/${viagemId}/passageiros`).set(auth(recepcao)).send({ patientId: pacienteC }).expect(403);
    });

    it('roteiro do dia lista a viagem com passageiros em ordem de saída', async () => {
      const r = (
        await t
          .http()
          .get(`/api/transporte/roteiro?date=${diaMais(3)}`)
          .set(auth(recepcao))
          .expect(200)
      ).body;
      expect(r.totais).toMatchObject({ viagens: 1, passageiros: 2 });
      expect(r.viagens[0].passageiros.map((p: { paciente: { name: string } }) => p.paciente.name)).toEqual(['Amanda Viagem Teste', 'Beatriz Viagem Teste']);
      const vazio = (
        await t
          .http()
          .get(`/api/transporte/roteiro?date=${diaMais(4)}`)
          .set(auth(recepcao))
          .expect(200)
      ).body;
      expect(vazio.viagens).toHaveLength(0);
    });

    it('inicia, registra falta e conclui com odômetro e abastecimento; indicadores somam', async () => {
      const passageiros = (await t.http().get(`/api/transporte/viagens/${viagemId}`).set(auth(nir)).expect(200)).body.passageiros as { id: string; paciente: { name: string } }[];
      const beatriz = passageiros.find((p) => p.paciente.name.startsWith('Beatriz'))!;
      await t.http().post(`/api/transporte/viagens/${viagemId}/iniciar`).set(auth(nir)).send({ odometerStart: 10400 }).expect(200);
      await t.http().post(`/api/transporte/viagens/${viagemId}/concluir`).set(auth(nir)).send({ odometerEnd: 100 }).expect(422);
      await t.http().post(`/api/transporte/passageiros/${beatriz.id}/status`).set(auth(nir)).send({ status: 'FALTOU' }).expect(200);
      await t.http().post(`/api/transporte/viagens/${viagemId}/iniciar`).set(auth(nir)).send({ odometerStart: 10400 }).expect(422);
      const fim = await t.http().post(`/api/transporte/viagens/${viagemId}/concluir`).set(auth(nir)).send({ odometerEnd: 10900, fuelLiters: 45, fuelCost: 270 }).expect(200);
      expect(fim.body.status).toBe('CONCLUIDA');
      expect(fim.body.km).toBe(500);
      const statuses = Object.fromEntries(fim.body.passageiros.map((p: { paciente: { name: string }; status: string }) => [p.paciente.name.split(' ')[0], p.status]));
      expect(statuses).toEqual({ Amanda: 'EMBARCOU', Beatriz: 'FALTOU' });
      const frota = (await t.http().get('/api/transporte/veiculos').set(auth(nir)).expect(200)).body;
      expect(frota.veiculos.find((x: { id: string }) => x.id === veiculoId).odometerKm).toBe(10900);
      const ind = (
        await t
          .http()
          .get(`/api/transporte/indicadores?from=${diaMais(-1)}&to=${diaMais(5)}`)
          .set(auth(nir))
          .expect(200)
      ).body;
      const mine = ind.porVeiculo.find((x: { vehicleId: string }) => x.vehicleId === veiculoId);
      expect(mine).toMatchObject({ viagens: 1, km: 500, passageiros: 1, faltas: 1 });
      expect(mine.combustivel).toBe(300 + 240 + 270);
      expect(mine.manutencao).toBe(800);
      expect(ind.totais.viagens).toBeGreaterThanOrEqual(1);
      await t.http().post(`/api/transporte/viagens/${viagemId}/passageiros`).set(auth(nir)).send({ patientId: pacienteC }).expect(422);
    });

    it('lista viagens por período e situação e cancela uma viagem planejada', async () => {
      const planejada = (
        await t
          .http()
          .post('/api/transporte/viagens')
          .set(auth(nir))
          .send({ vehicleId: vanId, driverId: motoristaId, date: diaMais(6), departureTime: '06:00', destinationCity: 'Araguaína', destinationUf: 'TO' })
          .expect(201)
      ).body;
      const lista = (
        await t
          .http()
          .get(`/api/transporte/viagens?from=${diaMais(0)}&to=${diaMais(7)}&status=PLANEJADA`)
          .set(auth(recepcao))
          .expect(200)
      ).body;
      expect(lista.some((v: { id: string }) => v.id === planejada.id)).toBe(true);
      expect(lista.some((v: { id: string }) => v.id === viagemId)).toBe(false);
      const cancelada = await t.http().post(`/api/transporte/viagens/${planejada.id}/cancelar`).set(auth(nir)).send({ reason: 'Veículo em manutenção corretiva' }).expect(200);
      expect(cancelada.body.status).toBe('CANCELADA');
    });
  });

  describe('TFD', () => {
    it('médico abre o processo com laudo e recebe número TFD-AAAA-NNNNNN; um por pessoa', async () => {
      const p = await t.http().post('/api/tfd/processos').set(auth(medica)).send(laudo(pacienteC)).expect(201);
      processoId = p.body.id;
      protocolo = p.body.protocol;
      expect(protocolo).toMatch(/^TFD-\d{4}-\d{6}$/);
      expect(p.body.status).toBe('ABERTO');
      expect(p.body.companion?.name).toBe('Carlos Acompanhante Teste');
      await t.http().post('/api/tfd/processos').set(auth(medica)).send(laudo(pacienteC)).expect(409);
      await t
        .http()
        .post('/api/tfd/processos')
        .set(auth(medica))
        .send(laudo(pacienteB, { needsCompanion: true, companionName: '' }))
        .expect(422);
      await t.http().post('/api/tfd/processos').set(auth(recepcao)).send(laudo(pacienteB)).expect(403);
    });

    it('bloqueia agendamento e ajuda de custo antes do parecer; envia e registra parecer deferido', async () => {
      await t
        .http()
        .post(`/api/tfd/processos/${processoId}/agendar`)
        .set(auth(social))
        .send({ appointmentAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), appointmentPlace: 'HGP' })
        .expect(422);
      await t
        .http()
        .put(`/api/tfd/processos/${processoId}/ajuda-custo`)
        .set(auth(social))
        .send({ itens: [{ tipo: 'DIARIA', beneficiario: 'PACIENTE', quantidade: 1, valorUnitario: 50 }] })
        .expect(422);
      await t.http().post(`/api/tfd/processos/${processoId}/parecer`).set(auth(social)).send({ deferido: true, notes: 'Antes do envio' }).expect(422);
      const env = await t.http().post(`/api/tfd/processos/${processoId}/enviar`).set(auth(social)).send({ notes: 'Enviado via SEI à Regional de Saúde' }).expect(200);
      expect(env.body.status).toBe('ENVIADO');
      await t.http().put(`/api/tfd/processos/${processoId}/laudo`).set(auth(medica)).send(laudo(pacienteC)).expect(422);
      const par = await t
        .http()
        .post(`/api/tfd/processos/${processoId}/parecer`)
        .set(auth(social))
        .send({ deferido: true, notes: 'Deferido pela CIR; 25 sessões autorizadas', allowanceApproved: true, transport: 'VEICULO_SANITARIO' })
        .expect(200);
      expect(par.body.status).toBe('DEFERIDO');
      expect(par.body.transport).toBe('VEICULO_SANITARIO');
      expect(par.body.allowance.approved).toBe(true);
    });

    it('agenda no destino, lança ajuda de custo com acompanhante, paga e avisa por WhatsApp', async () => {
      const quando = new Date(Date.now() + 10 * 86_400_000).toISOString();
      const ag = await t
        .http()
        .post(`/api/tfd/processos/${processoId}/agendar`)
        .set(auth(social))
        .send({ appointmentAt: quando, appointmentPlace: 'Hospital Geral de Palmas · radioterapia', notes: 'Chegar 30 min antes' })
        .expect(200);
      expect(ag.body.status).toBe('AGENDADO');
      expect(ag.body.appointment.place).toContain('radioterapia');
      const ajuda = await t
        .http()
        .put(`/api/tfd/processos/${processoId}/ajuda-custo`)
        .set(auth(social))
        .send({
          itens: [
            { tipo: 'DIARIA', beneficiario: 'PACIENTE', quantidade: 2, valorUnitario: 50 },
            { tipo: 'DIARIA', beneficiario: 'ACOMPANHANTE', quantidade: 2, valorUnitario: 50 },
            { tipo: 'PASSAGEM', beneficiario: 'PACIENTE', quantidade: 2, valorUnitario: 60.5 },
          ],
        })
        .expect(200);
      expect(ajuda.body.allowance.total).toBe(321);
      expect(ajuda.body.allowance.itens).toHaveLength(3);
      await t.http().post(`/api/tfd/processos/${processoId}/ajuda-custo/pagar`).set(auth(social)).expect(200);
      const det = (await t.http().get(`/api/tfd/processos/${processoId}`).set(auth(recepcao)).expect(200)).body;
      expect(det.allowance.paidAt).toBeTruthy();
      expect(det.eventos.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['ABERTO', 'ENVIADO', 'DEFERIDO', 'AGENDADO', 'AJUDA_CUSTO', 'AJUDA_PAGA']));
      // Devolutiva ao cidadão (parecer deferido + agendamento) pelo mesmo modelo da regulação; fora da janela de silêncio fica adiada.
      const disparo = (await t.http().post('/api/integrations/dispatch').set(auth(gestora)).expect(200)).body;
      expect(disparo.whatsapp.sent + disparo.whatsapp.postponed).toBeGreaterThanOrEqual(2);
      if (disparo.whatsapp.sent >= 2) {
        const sent = (await fetch(`${mocks.url}/whatsapp/_sent`).then((r) => r.json())) as { to: string; payload: { template?: { name: string } } }[];
        const avisos = sent.filter((m) => m.payload.template?.name === 'regulacao_atualizacao' && JSON.stringify(m.payload).includes(protocolo));
        expect(avisos.length).toBeGreaterThanOrEqual(2);
        expect(JSON.stringify(avisos)).toContain('radioterapia');
        expect(avisos.every((m) => m.to.endsWith('999990401'))).toBe(true);
      }
    });

    it('não aceita ajuda para acompanhante quando o laudo não prevê', async () => {
      const outro = (
        await t
          .http()
          .post('/api/tfd/processos')
          .set(auth(medica))
          .send(laudo(pacienteB, { needsCompanion: false, companionName: null, procedureName: 'Consulta em neurocirurgia' }))
          .expect(201)
      ).body;
      await t.http().post(`/api/tfd/processos/${outro.id}/enviar`).set(auth(social)).send({}).expect(200);
      await t.http().post(`/api/tfd/processos/${outro.id}/parecer`).set(auth(social)).send({ deferido: true, notes: 'Deferido', allowanceApproved: true }).expect(200);
      await t
        .http()
        .put(`/api/tfd/processos/${outro.id}/ajuda-custo`)
        .set(auth(social))
        .send({ itens: [{ tipo: 'DIARIA', beneficiario: 'ACOMPANHANTE', quantidade: 1, valorUnitario: 50 }] })
        .expect(422);
      const ind = await t.http().post(`/api/tfd/processos/${outro.id}/cancelar`).set(auth(social)).send({ reason: 'Paciente desistiu' }).expect(200);
      expect(ind.body.status).toBe('CANCELADO');
      await t.http().post(`/api/tfd/processos/${outro.id}/enviar`).set(auth(social)).send({}).expect(422);
    });

    it('reserva transporte sanitário (paciente + acompanhante ocupam lugares), cancela e reserva de novo', async () => {
      const viagem = (
        await t
          .http()
          .post('/api/transporte/viagens')
          .set(auth(nir))
          .send({ vehicleId: vanId, driverId: motoristaId, date: diaMais(10), departureTime: '05:00', destinationCity: 'Palmas', destinationUf: 'TO', destinationPlace: 'HGP' })
          .expect(201)
      ).body;
      const res = await t.http().post(`/api/tfd/processos/${processoId}/viagem`).set(auth(social)).send({ tripId: viagem.id, wheelchair: true }).expect(200);
      expect(res.body.tripId).toBe(viagem.id);
      await t.http().post(`/api/tfd/processos/${processoId}/viagem`).set(auth(social)).send({ tripId: viagem.id }).expect(422);
      const v = (await t.http().get(`/api/transporte/viagens/${viagem.id}`).set(auth(nir)).expect(200)).body;
      expect(v.ocupacao).toMatchObject({ usados: 2, cadeirantes: 1 });
      expect(v.passageiros[0]).toMatchObject({ tfdId: processoId, companionName: 'Carlos Acompanhante Teste', wheelchair: true, appointmentPlace: 'Hospital Geral de Palmas · radioterapia' });
      const det = (await t.http().get(`/api/tfd/processos/${processoId}`).set(auth(social)).expect(200)).body;
      expect(det.viagem).toMatchObject({ id: viagem.id, status: 'PLANEJADA', destinationCity: 'Palmas' });
      expect(det.viagem.passageiro.status).toBe('AGENDADO');
      await t.http().post(`/api/tfd/processos/${processoId}/viagem/cancelar`).set(auth(social)).expect(200);
      const v2 = (await t.http().get(`/api/transporte/viagens/${viagem.id}`).set(auth(nir)).expect(200)).body;
      expect(v2.ocupacao.usados).toBe(0);
      expect(v2.passageiros[0].status).toBe('CANCELADO');
      await t.http().post(`/api/tfd/processos/${processoId}/viagem`).set(auth(social)).send({ tripId: viagem.id }).expect(200);
      const v3 = (await t.http().get(`/api/transporte/viagens/${viagem.id}`).set(auth(nir)).expect(200)).body;
      expect(v3.ocupacao.usados).toBe(2);
      const lista = (await t.http().get(`/api/transporte/viagens?patientId=${pacienteC}`).set(auth(nir)).expect(200)).body;
      expect(lista.some((x: { id: string }) => x.id === viagem.id)).toBe(true);
    });

    it('gera PDFs do laudo e da guia de viagem', async () => {
      const laudoPdf = await t.http().get(`/api/tfd/processos/${processoId}/laudo.pdf`).set(auth(recepcao)).buffer(true).parse(binaryParser).expect(200);
      expect(laudoPdf.headers['content-type']).toContain('application/pdf');
      expect((laudoPdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      expect(laudoPdf.headers['content-disposition']).toContain(protocolo);
      const guia = await t.http().get(`/api/tfd/processos/${processoId}/guia.pdf`).set(auth(recepcao)).buffer(true).parse(binaryParser).expect(200);
      expect((guia.body as Buffer).length).toBeGreaterThan(1000);
    });

    it('lista por escopo, painel e linha do tempo do paciente; conclui o processo', async () => {
      const central = (await t.http().get('/api/tfd/processos').set(auth(gestora)).expect(200)).body;
      expect(central.some((p: { id: string }) => p.id === processoId)).toBe(true);
      const daUnidade = (await t.http().get('/api/tfd/processos').set(auth(recepcao)).expect(200)).body;
      expect(daUnidade.some((p: { id: string }) => p.id === processoId)).toBe(true);
      const poli = (await t.http().get('/api/tfd/processos?escopo=unidade').set(auth(nir)).expect(200)).body;
      expect(poli.some((p: { id: string }) => p.id === processoId)).toBe(false);
      const painel = (await t.http().get('/api/tfd/painel').set(auth(gestora)).expect(200)).body;
      expect(painel.porStatus.AGENDADO).toBeGreaterThanOrEqual(1);
      expect(painel.ajudaCustoAno).toBeGreaterThanOrEqual(321);
      const timeline = (await t.http().get(`/api/patients/${pacienteC}/timeline`).set(auth(medica)).expect(200)).body;
      const eventos = Array.isArray(timeline) ? timeline : (timeline.events ?? timeline.items ?? []);
      expect(eventos.some((e: { type: string }) => e.type === 'TFD')).toBe(true);
      const fim = await t.http().post(`/api/tfd/processos/${processoId}/concluir`).set(auth(social)).send({ notes: 'Tratamento realizado' }).expect(200);
      expect(fim.body.status).toBe('CONCLUIDO');
      expect(fim.body.closedAt).toBeTruthy();
      await t.http().post('/api/tfd/processos').set(auth(medica)).send(laudo(pacienteC)).expect(201);
    });

    it('processos abertos ao mesmo tempo recebem protocolos distintos', async () => {
      // Um processo em andamento por pessoa: cinco pessoas novas.
      const pessoas: string[] = [];
      for (const [i, nome] of ['Alice', 'Bruna', 'Clara', 'Diana', 'Elisa'].entries()) {
        const p = await t
          .http()
          .post('/api/patients')
          .set(auth(recepcao))
          .send({ name: `${nome} Simultanea Viagem`, birthDate: '1970-04-04', sex: 'F', cpf: completeCpf(`47700041${i}`), cns: cnsFromBase(`2770000041${i}`), motherName: 'Mae Viagem Teste', address })
          .expect(201);
        pessoas.push(p.body.id);
      }
      const juntos = await Promise.all(pessoas.map((patientId) => t.http().post('/api/tfd/processos').set(auth(medica)).send(laudo(patientId))));
      expect(juntos.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      const protocolos = juntos.map((r) => r.body.protocol as string);
      expect(protocolos.every((p) => /^TFD-\d{4}-\d{6}$/.test(p))).toBe(true);
      expect(new Set(protocolos).size).toBe(5);
    });
  });
});

function binaryParser(res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
