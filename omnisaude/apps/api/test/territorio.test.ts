import { randomUUID } from 'node:crypto';
import { zipSync } from 'fflate';
import proj4 from 'proj4';
import { cnsFromBase, completeCpf, distanciaM, metrosPorGrau, type Posicao } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();

// Quarteirões de 80 m x 80 m separados por ruas de 20 m (passo de 100 m), em torno de um ponto de Gurupi/TO.
const C: Posicao = [-49.0686, -11.7298];
const mpg = metrosPorGrau(C[1]);
const desloca = (p: Posicao, lesteM: number, norteM: number): Posicao => [p[0] + lesteM / mpg.lng, p[1] + norteM / mpg.lat];
const quadrado = (centro: Posicao, lado = 80) => {
  const a = desloca(centro, -lado / 2, -lado / 2);
  const b = desloca(centro, lado / 2, lado / 2);
  return { type: 'Polygon' as const, coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]] };
};
/** Grade 3 x 3 de quarteirões numerados de 1 a 9 (linha a linha, de sudoeste a nordeste). */
const grade = (origem: Posicao) => [0, 1, 2].flatMap((lin) => [0, 1, 2].map((col) => ({ numero: String(lin * 3 + col + 1), centro: desloca(origem, (col - 1) * 100, (lin - 1) * 100) })));

const UTM22S_PRJ =
  'PROJCS["SIRGAS_2000_UTM_Zone_22S",GEOGCS["GCS_SIRGAS_2000",DATUM["D_SIRGAS_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",10000000.0],PARAMETER["Central_Meridian",-51.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
const SAD69_PRJ =
  'PROJCS["SAD_1969_UTM_Zone_22S",GEOGCS["GCS_South_American_1969",DATUM["D_South_American_1969",SPHEROID["GRS_1967_Truncated",6378160.0,298.25]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",10000000.0],PARAMETER["Central_Meridian",-51.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';

/** Shapefile mínimo (polígonos, anel externo no sentido horário como manda o formato) com um campo de texto. */
function shapefile(feicoes: { aneis: number[][][]; atributos: Record<string, string> }[], campos: string[]) {
  const be = (v: DataView, o: number, n: number) => v.setInt32(o, n, false);
  const registros = feicoes.map((f) => {
    const pontos = f.aneis.flat();
    const tam = 44 + 4 * f.aneis.length + 16 * pontos.length;
    const buf = new ArrayBuffer(tam);
    const v = new DataView(buf);
    const xs = pontos.map((p) => p[0]!);
    const ys = pontos.map((p) => p[1]!);
    v.setInt32(0, 5, true);
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((n, i) => v.setFloat64(4 + i * 8, n, true));
    v.setInt32(36, f.aneis.length, true);
    v.setInt32(40, pontos.length, true);
    let parte = 0;
    f.aneis.forEach((a, i) => {
      v.setInt32(44 + i * 4, parte, true);
      parte += a.length;
    });
    pontos.forEach((p, i) => {
      v.setFloat64(44 + 4 * f.aneis.length + i * 16, p[0]!, true);
      v.setFloat64(44 + 4 * f.aneis.length + i * 16 + 8, p[1]!, true);
    });
    return new Uint8Array(buf);
  });
  const todos = feicoes.flatMap((f) => f.aneis.flat());
  const caixa = [Math.min(...todos.map((p) => p[0]!)), Math.min(...todos.map((p) => p[1]!)), Math.max(...todos.map((p) => p[0]!)), Math.max(...todos.map((p) => p[1]!))];
  const cabecalho = (tamanhoBytes: number) => {
    const h = new DataView(new ArrayBuffer(100));
    be(h, 0, 9994);
    be(h, 24, tamanhoBytes / 2);
    h.setInt32(28, 1000, true);
    h.setInt32(32, 5, true);
    caixa.forEach((n, i) => h.setFloat64(36 + i * 8, n, true));
    return new Uint8Array(h.buffer);
  };
  const shpTam = 100 + registros.reduce((s, r) => s + 8 + r.length, 0);
  const shp = new Uint8Array(shpTam);
  shp.set(cabecalho(shpTam), 0);
  const shx = new Uint8Array(100 + 8 * registros.length);
  shx.set(cabecalho(shx.length), 0);
  let off = 100;
  registros.forEach((r, i) => {
    const h = new DataView(shp.buffer, off, 8);
    be(h, 0, i + 1);
    be(h, 4, r.length / 2);
    shp.set(r, off + 8);
    const x = new DataView(shx.buffer, 100 + i * 8, 8);
    be(x, 0, off / 2);
    be(x, 4, r.length / 2);
    off += 8 + r.length;
  });
  const larg = 20;
  const cab = 32 + 32 * campos.length + 1;
  const reg = 1 + larg * campos.length;
  const dbf = new Uint8Array(cab + reg * feicoes.length + 1);
  const d = new DataView(dbf.buffer);
  dbf[0] = 3;
  d.setUint32(4, feicoes.length, true);
  d.setUint16(8, cab, true);
  d.setUint16(10, reg, true);
  const enc = new TextEncoder();
  campos.forEach((c, i) => {
    dbf.set(enc.encode(c.slice(0, 10)), 32 + i * 32);
    dbf[32 + i * 32 + 11] = 'C'.charCodeAt(0);
    dbf[32 + i * 32 + 16] = larg;
  });
  dbf[cab - 1] = 0x0d;
  feicoes.forEach((f, i) => {
    const o = cab + i * reg;
    dbf[o] = 0x20;
    campos.forEach((c, j) => dbf.set(enc.encode((f.atributos[c] ?? '').padEnd(larg, ' ').slice(0, larg)), o + 1 + j * larg));
  });
  dbf[dbf.length - 1] = 0x1a;
  return { shp, shx, dbf };
}

describe.runIf(enabled)('Território georreferenciado (PLT-3)', () => {
  let t: TestApp;
  let gestora = '';
  let vig = '';
  let acs = '';
  let recepcao = '';
  let medica = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let localidade = '';
  let localidade2 = '';
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const b64 = (s: string | Uint8Array) => Buffer.from(s).toString('base64');
  const quarteiraoPorNumero = async (localityId: string, numero: string) => db.block.findFirstOrThrow({ where: { localityId, number: numero, active: true } });

  beforeAll(async () => {
    t = await startTestApp('territorio');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    acs = await t.login('acs', 'UBS Centro', 'ACS');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
  });

  afterAll(async () => {
    await t?.close();
  });

  it('localidade (código de até 8 dígitos, único entre as ativas) e bairro com apelidos', async () => {
    localidade = (await t.http().post('/api/territorio/localidades').set(auth(gestora)).send({ code: '1', name: 'Gurupi (sede)', category: 'CIDADE', zone: 'URBANA' }).expect(201)).body.id;
    await t.http().post('/api/territorio/localidades').set(auth(gestora)).send({ code: '1', name: 'Outra' }).expect(409);
    await t.http().post('/api/territorio/localidades').set(auth(gestora)).send({ code: '123456789', name: 'Longo' }).expect(400);
    localidade2 = (await t.http().post('/api/territorio/localidades').set(auth(vig)).send({ code: '2', name: 'Trevo da Praia', category: 'POVOADO', zone: 'RURAL' }).expect(201)).body.id;
    const bairro = (
      await t
        .http()
        .post('/api/territorio/bairros')
        .set(auth(gestora))
        .send({ localityId: localidade, name: 'Setor Central', aliases: ['CENTRO'], geometry: quadrado(C, 400) })
        .expect(201)
    ).body;
    expect(bairro).toMatchObject({ name: 'Setor Central', aliases: ['CENTRO'] });
    await t.http().post('/api/territorio/localidades').set(auth(acs)).send({ code: '3', name: 'ACS não edita' }).expect(403);
  });

  it('importar a malha em GeoJSON liga cada domicílio ao seu quarteirão', async () => {
    // Imóveis com GPS antes da malha: um no meio de cada quarteirão da linha do meio e um na rua (8 m do quarteirão 5).
    const casas = [];
    for (const [i, g] of grade(C).entries()) {
      if (i < 3 || i > 5) continue;
      casas.push(
        (
          await t
            .http()
            .post('/api/households')
            .set(auth(recepcao))
            .send({ street: 'Rua Teste', number: String(100 + i), district: 'Setor Central', latitude: g.centro[1], longitude: g.centro[0] })
            .expect(201)
        ).body.id,
      );
    }
    const naRua = desloca(C, 48, 0);
    const casaRua = (await t.http().post('/api/households').set(auth(recepcao)).send({ street: 'Rua Teste', number: '200', latitude: naRua[1], longitude: naRua[0] }).expect(201)).body.id;
    expect((await db.household.findUniqueOrThrow({ where: { id: casas[0] } })).blockId).toBeNull();
    const fc = { type: 'FeatureCollection', features: grade(C).map((g) => ({ type: 'Feature', properties: { QUADRA: g.numero, BAIRRO: 'CENTRO' }, geometry: quadrado(g.centro) })) };
    const previa = (
      await t
        .http()
        .post('/api/territorio/importacoes/previa')
        .set(auth(gestora))
        .send({ tipo: 'QUARTEIROES', nomeArquivo: 'quadras.geojson', arquivoBase64: b64(JSON.stringify(fc)) })
        .expect(200)
    ).body;
    expect(previa).toMatchObject({ formato: 'GEOJSON', src: 'EPSG:4326', total: 9, validas: 9, sugestao: { numero: 'QUADRA', bairro: 'BAIRRO' } });
    const r = (
      await t
        .http()
        .post(`/api/territorio/importacoes/${previa.id}/aplicar`)
        .set(auth(gestora))
        .send({ mapeamento: { numero: 'QUADRA', bairro: 'BAIRRO' }, localidadeFixa: localidade })
        .expect(200)
    ).body;
    expect(r).toMatchObject({ criados: 9, atualizados: 0, totalErros: 0, sobreposicoes: [] });
    expect(r.imoveis.comQuarteirao).toBeGreaterThanOrEqual(4);
    for (const [k, id] of casas.entries()) expect((await db.household.findUniqueOrThrow({ where: { id } })).blockId).toBe((await quarteiraoPorNumero(localidade, String(4 + k))).id);
    // Na rua, a 8 m do quarteirão 5: ligado ao mais próximo (tolerância do GPS).
    expect((await db.household.findUniqueOrThrow({ where: { id: casaRua } })).blockId).toBe((await quarteiraoPorNumero(localidade, '5')).id);
    // O bairro veio pelo apelido (CENTRO).
    expect((await quarteiraoPorNumero(localidade, '1')).neighborhoodId).not.toBeNull();
    // A prévia não se aplica duas vezes.
    await t
      .http()
      .post(`/api/territorio/importacoes/${previa.id}/aplicar`)
      .set(auth(gestora))
      .send({ mapeamento: { numero: 'QUADRA' }, localidadeFixa: localidade })
      .expect(422);
  });

  it('um raio de 150 m devolve os quarteirões atingidos', async () => {
    const r = (await t.http().get(`/api/territorio/raio?lat=${C[1]}&lng=${C[0]}&metros=150`).set(auth(acs)).expect(200)).body;
    // Do centro do quarteirão 5, a borda dos vizinhos laterais fica a 60 m e a dos diagonais a ~85 m: os 9 entram.
    expect(r.quarteiroes.map((q: { numero: string }) => q.numero).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(r.quarteiroes[0]).toMatchObject({ numero: '5', distanciaM: 0, localidade: { code: '1' } });
    const r50 = (await t.http().get(`/api/territorio/raio?lat=${C[1]}&lng=${C[0]}&metros=50`).set(auth(acs)).expect(200)).body;
    expect(r50.quarteiroes.map((q: { numero: string }) => q.numero)).toEqual(['5']);
    // Padrão da instituição: 150 m.
    expect((await t.http().get(`/api/territorio/raio?lat=${C[1]}&lng=${C[0]}`).set(auth(acs)).expect(200)).body.raioM).toBe(150);
  });

  it('shapefile em SIRGAS 2000 / UTM 22S é reprojetado pela .prj; sem .prj ou em SAD 69 é recusado', async () => {
    const utm = proj4('EPSG:4326', UTM22S_PRJ);
    const origem = desloca(C, 2000, 0);
    const feicoes = grade(origem)
      .slice(0, 2)
      .map((g) => {
        const anel = quadrado(g.centro).coordinates[0]!.map((p) => utm.forward(p as number[]));
        return { aneis: [anel.slice().reverse()], atributos: { NUM_QUAD: g.numero.padStart(3, '0') } };
      });
    const { shp, shx, dbf } = shapefile(feicoes, ['NUM_QUAD']);
    const zip = zipSync({ 'quadras.shp': shp, 'quadras.shx': shx, 'quadras.dbf': dbf, 'quadras.prj': new TextEncoder().encode(UTM22S_PRJ), 'quadras.cpg': new TextEncoder().encode('UTF-8') });
    const previa = (
      await t
        .http()
        .post('/api/territorio/importacoes/previa')
        .set(auth(vig))
        .send({ tipo: 'QUARTEIROES', nomeArquivo: 'quadras.zip', arquivoBase64: b64(zip) })
        .expect(200)
    ).body;
    expect(previa).toMatchObject({ formato: 'SHAPEFILE', src: 'EPSG:31982', validas: 2, sugestao: { numero: 'NUM_QUAD' } });
    await t
      .http()
      .post(`/api/territorio/importacoes/${previa.id}/aplicar`)
      .set(auth(vig))
      .send({ mapeamento: { numero: 'NUM_QUAD' }, localidadeFixa: localidade2 })
      .expect(200);
    const q1 = await quarteiraoPorNumero(localidade2, '1');
    expect(distanciaM([q1.centerLng, q1.centerLat], grade(origem)[0]!.centro)).toBeLessThan(1);
    expect(q1.areaM2).toBeGreaterThan(6390);
    expect(q1.areaM2).toBeLessThan(6410);
    // Sem .prj: pede o sistema de referência; informado, aceita.
    const semPrj = zipSync({ 'q.shp': shp, 'q.shx': shx, 'q.dbf': dbf });
    const erro = (
      await t
        .http()
        .post('/api/territorio/importacoes/previa')
        .set(auth(vig))
        .send({ tipo: 'QUARTEIROES', nomeArquivo: 'q.zip', arquivoBase64: b64(semPrj) })
        .expect(400)
    ).body;
    expect(erro.message).toMatch(/\.prj/);
    expect(
      (
        await t
          .http()
          .post('/api/territorio/importacoes/previa')
          .set(auth(vig))
          .send({ tipo: 'QUARTEIROES', nomeArquivo: 'q.zip', arquivoBase64: b64(semPrj), src: 'EPSG:31982' })
          .expect(200)
      ).body.src,
    ).toBe('EPSG:31982');
    // SAD 69: precisa das grades do IBGE.
    const sad = zipSync({ 'q.shp': shp, 'q.shx': shx, 'q.dbf': dbf, 'q.prj': new TextEncoder().encode(SAD69_PRJ) });
    expect(
      (
        await t
          .http()
          .post('/api/territorio/importacoes/previa')
          .set(auth(vig))
          .send({ tipo: 'QUARTEIROES', nomeArquivo: 'q.zip', arquivoBase64: b64(sad) })
          .expect(400)
      ).body.message,
    ).toMatch(/SAD 69/);
    // GeoJSON em metros sem sistema declarado: recusado.
    const emMetros = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [feicoes[0]!.aneis[0]] } }] };
    await t
      .http()
      .post('/api/territorio/importacoes/previa')
      .set(auth(vig))
      .send({ tipo: 'QUARTEIROES', nomeArquivo: 'm.geojson', arquivoBase64: b64(JSON.stringify(emMetros)) })
      .expect(400);
  });

  it('importação robusta: SAD 69 dentro do zip, zip bomba, BOM, número com zeros, bairro preservado e malha completa com erro', async () => {
    const origem = desloca(C, 2000, 0);
    const [g1, g2] = grade(origem);
    const feicao = (num: string, centro: Posicao) => ({ type: 'Feature', properties: { NUM: num }, geometry: quadrado(centro) });
    // GeoJSON com crs do SAD 69 dentro do zip: recusado como o arquivo solto.
    const sad = { type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4618' } }, features: [feicao('1', g1!.centro)] };
    const zSad = zipSync({ 'q.geojson': new TextEncoder().encode(JSON.stringify(sad)) });
    expect(
      (
        await t
          .http()
          .post('/api/territorio/importacoes/previa')
          .set(auth(vig))
          .send({ tipo: 'QUARTEIROES', nomeArquivo: 'q.zip', arquivoBase64: b64(zSad) })
          .expect(400)
      ).body.message,
    ).toMatch(/SAD 69/);
    // Zip pequeno que vira mais de 150 MB: recusado sem descompactar.
    const bomba = zipSync({ 'q.geojson': [new Uint8Array(151 * 1024 * 1024), { level: 1 }] });
    expect(bomba.length).toBeLessThan(10 * 1024 * 1024);
    expect(
      (
        await t
          .http()
          .post('/api/territorio/importacoes/previa')
          .set(auth(vig))
          .send({ tipo: 'QUARTEIROES', nomeArquivo: 'q.zip', arquivoBase64: b64(bomba) })
          .expect(400)
      ).body.message,
    ).toMatch(/150 MB/);

    // O quarteirão 1 da localidade 2 ganha um bairro no editor; o arquivo novo não traz bairro.
    const praia = (await t.http().post('/api/territorio/bairros').set(auth(gestora)).send({ localityId: localidade2, name: 'Praia' }).expect(201)).body.id;
    const q1 = await quarteiraoPorNumero(localidade2, '1');
    await t.http().patch(`/api/territorio/quarteiroes/${q1.id}`).set(auth(gestora)).send({ neighborhoodId: praia }).expect(200);
    // Arquivo com BOM, "001" (é o 1) e uma feição com número inválido, marcado como malha completa.
    const fc = { type: 'FeatureCollection', features: [feicao('001', g1!.centro), feicao('2', g2!.centro), feicao('X?', desloca(origem, 0, 400))] };
    const comBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(fc))]);
    const previa = (
      await t
        .http()
        .post('/api/territorio/importacoes/previa')
        .set(auth(vig))
        .send({ tipo: 'QUARTEIROES', nomeArquivo: 'q.geojson', arquivoBase64: b64(comBom) })
        .expect(200)
    ).body;
    const r = (
      await t
        .http()
        .post(`/api/territorio/importacoes/${previa.id}/aplicar`)
        .set(auth(vig))
        .send({ mapeamento: { numero: 'NUM' }, localidadeFixa: localidade2, desativarAusentes: true })
        .expect(200)
    ).body;
    expect(r).toMatchObject({ criados: 0, atualizados: 2, desativados: 0, totalErros: 1 });
    expect(r.avisos[0]).toMatch(/Nenhum quarteirão foi desativado/);
    expect((await quarteiraoPorNumero(localidade2, '1')).neighborhoodId).toBe(praia);

    // Bairro em duas feições com o mesmo nome: a segunda é erro, não sobrescreve a primeira.
    const bairros = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { NOME: 'Praia Norte' }, geometry: quadrado(desloca(C, 5000, 0), 300) },
        { type: 'Feature', properties: { NOME: 'PRAIA NORTE' }, geometry: quadrado(desloca(C, 5000, 600), 300) },
      ],
    };
    const pb = (
      await t
        .http()
        .post('/api/territorio/importacoes/previa')
        .set(auth(vig))
        .send({ tipo: 'BAIRROS', nomeArquivo: 'b.geojson', arquivoBase64: b64(JSON.stringify(bairros)) })
        .expect(200)
    ).body;
    const rb = (
      await t
        .http()
        .post(`/api/territorio/importacoes/${pb.id}/aplicar`)
        .set(auth(vig))
        .send({ mapeamento: { nome: 'NOME' }, localidadeFixa: localidade2 })
        .expect(200)
    ).body;
    expect(rb).toMatchObject({ criados: 1, atualizados: 0, totalErros: 1 });
    expect(rb.erros[0].motivo).toMatch(/repetido/);
  });

  it('editor de quarteirões: recusa sobreposição, número repetido e contorno cruzado; edição concorrente dá conflito', async () => {
    const livre = desloca(C, 0, 400);
    await t
      .http()
      .post('/api/territorio/quarteiroes')
      .set(auth(gestora))
      .send({ localityId: localidade, number: '10', geometry: quadrado(desloca(C, 30, 0)) })
      .expect(409);
    await t
      .http()
      .post('/api/territorio/quarteiroes')
      .set(auth(gestora))
      .send({ localityId: localidade, number: '5', geometry: quadrado(livre) })
      .expect(409);
    const gravata = { type: 'Polygon', coordinates: [[desloca(livre, -40, -40), desloca(livre, 40, 40), desloca(livre, 40, -40), desloca(livre, -40, 40), desloca(livre, -40, -40)]] };
    await t.http().post('/api/territorio/quarteiroes').set(auth(gestora)).send({ localityId: localidade, number: '10', geometry: gravata }).expect(400);
    const casa = (await t.http().post('/api/households').set(auth(recepcao)).send({ street: 'Rua Nova', number: '1', latitude: livre[1], longitude: livre[0] }).expect(201)).body.id;
    const q = (
      await t
        .http()
        .post('/api/territorio/quarteiroes')
        .set(auth(gestora))
        .send({ localityId: localidade, number: '10-A', geometry: quadrado(livre) })
        .expect(201)
    ).body;
    expect(q).toMatchObject({ number: '10-A', religados: 1 });
    expect((await db.household.findUniqueOrThrow({ where: { id: casa } })).blockId).toBe(q.id);
    await t.http().patch(`/api/territorio/quarteiroes/${q.id}`).set(auth(gestora)).send({ notes: 'Conferido em campo', versao: q.updatedAt }).expect(200);
    await t.http().patch(`/api/territorio/quarteiroes/${q.id}`).set(auth(gestora)).send({ notes: 'Outra pessoa', versao: q.updatedAt }).expect(409);
    // Mudar o contorno para longe solta o imóvel.
    const r = (
      await t
        .http()
        .patch(`/api/territorio/quarteiroes/${q.id}`)
        .set(auth(gestora))
        .send({ geometry: quadrado(desloca(livre, 0, 300)) })
        .expect(200)
    ).body;
    expect(r.religados).toBe(1);
    expect((await db.household.findUniqueOrThrow({ where: { id: casa } })).blockId).toBeNull();
    await t
      .http()
      .post('/api/territorio/quarteiroes')
      .set(auth(acs))
      .send({ localityId: localidade, number: '11', geometry: quadrado(desloca(livre, 0, 600)) })
      .expect(403);
  });

  it('posição do imóvel: marcada no mapa ou por GPS, com o raio normalizado e recusa acima de 50 m', async () => {
    const casa = (await t.http().post('/api/households').set(auth(recepcao)).send({ street: 'Rua Sem Ponto', number: '9' }).expect(201)).body.id;
    const p = desloca(C, 100, 100);
    const m = (await t.http().post(`/api/territorio/imoveis/${casa}/posicao`).set(auth(gestora)).send({ lat: p[1], lng: p[0], origem: 'MAPA', sequencia: '40-1' }).expect(200)).body;
    expect(m).toMatchObject({ precisao: 'MAPA', blockId: (await quarteiraoPorNumero(localidade, '9')).id });
    expect((await db.household.findUniqueOrThrow({ where: { id: casa } })).rgSequence).toBe('40-1');
    await t.http().post(`/api/territorio/imoveis/${casa}/posicao`).set(auth(acs)).send({ lat: p[1], lng: p[0], origem: 'GPS', accuracyM: 40, confianca: 68 }).expect(422);
    const g = (await t.http().post(`/api/territorio/imoveis/${casa}/posicao`).set(auth(acs)).send({ lat: p[1], lng: p[0], origem: 'GPS', accuracyM: 10, confianca: 68 }).expect(200)).body;
    expect(g.precisao).toBe('GPS_CAMPO');
    expect((await db.household.findUniqueOrThrow({ where: { id: casa } })).geoAccuracyM).toBeCloseTo(16.2, 1);
    const pend = (await t.http().get('/api/territorio/imoveis?situacao=SEM_POSICAO').set(auth(acs)).expect(200)).body as { id: string }[];
    expect(pend.map((x) => x.id)).not.toContain(casa);

    // Visita do ACS com GPS num imóvel sem posição: a posição entra como GPS em campo e o imóvel vai ao quarteirão.
    const visitada = (await t.http().post('/api/households').set(auth(recepcao)).send({ street: 'Rua da Visita', number: '3' }).expect(201)).body.id;
    const pv = desloca(C, -100, 100);
    const sync = (
      await t
        .http()
        .post('/api/acs/sync')
        .set(auth(acs))
        .send({ operacoes: [{ tipo: 'VISITA', clientId: randomUUID(), registradoEm: new Date().toISOString(), householdId: visitada, visita: { motivos: ['1'], desfecho: '3', latitude: pv[1], longitude: pv[0] } }] })
        .expect(200)
    ).body;
    expect(sync.resultados[0]).toMatchObject({ status: 'OK' });
    expect(await db.household.findUniqueOrThrow({ where: { id: visitada } })).toMatchObject({ geoPrecision: 'GPS_CAMPO', geoSource: 'visita', blockId: (await quarteiraoPorNumero(localidade, '7')).id });
  });

  it('geocodificação só local pela base de endereços do IBGE (CNEFE): endereço, quadra/lote, logradouro e bairro', async () => {
    const p1 = desloca(C, -100, 0);
    const p2 = desloca(C, 0, -100);
    const ruaA = [desloca(C, 100, -90), desloca(C, 120, -90), desloca(C, 140, -90)];
    const cab =
      'COD_UNICO_ENDERECO;COD_UF;COD_MUNICIPIO;COD_DISTRITO;COD_SUBDISTRITO;COD_SETOR;NUM_QUADRA;NUM_FACE;CEP;DSC_LOCALIDADE;NOM_TIPO_SEGLOGR;NOM_TITULO_SEGLOGR;NOM_SEGLOGR;NUM_ENDERECO;DSC_MODIFICADOR;NOM_COMP_ELEM1;VAL_COMP_ELEM1;NOM_COMP_ELEM2;VAL_COMP_ELEM2;NOM_COMP_ELEM3;VAL_COMP_ELEM3;NOM_COMP_ELEM4;VAL_COMP_ELEM4;NOM_COMP_ELEM5;VAL_COMP_ELEM5;LATITUDE;LONGITUDE;NV_GEO_COORD;COD_ESPECIE;DSC_ESTABELECIMENTO;COD_INDICADOR_ESTAB_ENDERECO;COD_INDICADOR_CONST_ENDERECO;COD_INDICADOR_FINALIDADE_CONST;COD_TIPO_ESPECI';
    const linha = (id: string, rua: string, num: string, mod: string, comp: [string, string][], p: Posicao, nivel = 1) =>
      [
        id,
        '17',
        '1709500',
        '170950005',
        '17095000500',
        '170950005000001P',
        '001',
        '001',
        '77400000',
        'SETOR CENTRAL',
        'AVENIDA',
        '',
        rua,
        num,
        mod,
        ...comp.flat(),
        ...Array(10 - comp.length * 2).fill(''),
        p[1].toFixed(6),
        p[0].toFixed(6),
        String(nivel),
        '1',
        '',
        '',
        '',
        '',
        '1',
      ].join(';');
    const csv = [
      cab,
      linha('1', 'GOIAS', '1500', '', [], p1),
      linha('1', 'GOIAS', '1500', '', [], p1),
      linha(
        '2',
        'PARA',
        '0',
        'SN',
        [
          ['QUADRA', '12'],
          ['LOTE', '7'],
        ],
        p2,
      ),
      ...ruaA.map((p, i) => linha(String(10 + i), 'MARANHAO', String(10 + i), '', [], p, 1)),
    ].join('\r\n');
    const previa = (
      await t
        .http()
        .post('/api/territorio/importacoes/previa')
        .set(auth(gestora))
        .send({ tipo: 'ENDERECOS', nomeArquivo: '1709500_GURUPI.csv', arquivoBase64: b64(csv) })
        .expect(200)
    ).body;
    expect(previa).toMatchObject({ total: 5, municipios: ['1709500'], niveis: { 1: 5 } });
    await t.http().post(`/api/territorio/importacoes/${previa.id}/aplicar`).set(auth(gestora)).send({}).expect(200);
    const cria = async (dados: Record<string, unknown>) =>
      (
        await t
          .http()
          .post('/api/households')
          .set(auth(recepcao))
          .send({ ibgeCode: '1709500', ...dados })
          .expect(201)
      ).body.id as string;
    const porEndereco = await cria({ street: 'Av. Goiás', number: '1500' });
    const porQuadraLote = await cria({ street: 'Avenida Pará', number: 'S/N', complement: 'QD 12 LT 07' });
    const porRua = await cria({ street: 'Av Maranhão', number: '999' });
    const porBairro = await cria({ street: 'Rua Desconhecida', number: '1', district: 'Centro' });
    const comGps = await cria({ street: 'Av. Goiás', number: '1500', latitude: C[1], longitude: C[0] });
    const r = (
      await t
        .http()
        .post('/api/territorio/imoveis/geocodificar')
        .set(auth(gestora))
        .send({ ids: [porEndereco, porQuadraLote, porRua, porBairro, comGps] })
        .expect(200)
    ).body;
    expect(r).toMatchObject({ analisados: 5, atualizados: 4 });
    const h = async (id: string) => db.household.findUniqueOrThrow({ where: { id } });
    expect(await h(porEndereco)).toMatchObject({ geoPrecision: 'ENDERECO', geoSource: 'cnefe:endereco', blockId: (await quarteiraoPorNumero(localidade, '4')).id });
    expect(distanciaM([(await h(porEndereco)).longitude!, (await h(porEndereco)).latitude!], p1)).toBeLessThan(0.5);
    expect(await h(porQuadraLote)).toMatchObject({ geoPrecision: 'ENDERECO', geoSource: 'cnefe:quadra-lote' });
    expect(await h(porRua)).toMatchObject({ geoPrecision: 'LOGRADOURO', blockId: null });
    expect(await h(porBairro)).toMatchObject({ geoPrecision: 'LOCALIDADE', geoSource: 'centro-do-bairro', blockId: null });
    // GPS em campo não é trocado por posição pior.
    expect(await h(comGps)).toMatchObject({ geoPrecision: 'GPS_CAMPO', latitude: C[1] });
  });

  it('mapa de casos só para a vigilância, com o quarteirão do caso e os quarteirões no raio do bloqueio', async () => {
    const paciente = (
      await t
        .http()
        .post('/api/patients')
        .set(auth(recepcao))
        .send({
          name: 'Diego Dengue Territorio',
          birthDate: '1985-03-03',
          sex: 'M',
          cpf: completeCpf('483111001'),
          cns: cnsFromBase('28311100100'),
          motherName: 'Mae do Diego',
          phone: '(63) 97777-2525',
          address: { cep: '77405070', street: 'Rua da Saída', number: '25', district: 'Centro', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' },
        })
        .expect(201)
    ).body.id;
    await t
      .http()
      .post('/api/households')
      .set(auth(recepcao))
      .send({ street: 'Rua Mapa', number: '5', latitude: C[1], longitude: C[0], family: { responsibleId: paciente } })
      .expect(201);
    const n = (await t.http().post('/api/vigilancia/notificacoes').set(auth(medica)).send({ patientId: paciente, conditionKey: 'dengue' }).expect(201)).body;
    const hoje = new Date().toISOString().slice(0, 10);
    const ontem = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await t.http().get(`/api/vigilancia/mapa?de=${ontem}&ate=${hoje}`).set(auth(medica)).expect(403);
    await t.http().get(`/api/vigilancia/mapa?de=${ontem}&ate=${hoje}`).set(auth(acs)).expect(403);
    const mapa = (await t.http().get(`/api/vigilancia/mapa?de=${ontem}&ate=${hoje}`).set(auth(vig)).expect(200)).body;
    const ponto = mapa.pontos.find((p: { id: string }) => p.id === n.id);
    expect(ponto).toMatchObject({ precisao: 'GPS_CAMPO', fonte: 'cadastro', blockId: (await quarteiraoPorNumero(localidade, '5')).id });
    expect(mapa.porQuarteirao.find((q: { numero: string }) => q.numero === '5').casos).toBeGreaterThanOrEqual(1);
    const raio = (await t.http().get(`/api/vigilancia/notificacoes/${n.id}/quarteiroes`).set(auth(vig)).expect(200)).body;
    expect(raio).toMatchObject({ regra: 'AUTOMATICO', raioM: 150, precisao: 'GPS_CAMPO' });
    expect(raio.quarteiroes.map((q: { numero: string }) => q.numero)).toEqual(expect.arrayContaining(['5', '1', '9']));
    await t.http().get(`/api/vigilancia/notificacoes/${n.id}/quarteiroes`).set(auth(medica)).expect(403);
    // O retrato da ficha guarda a precisão da residência.
    expect((await db.notification.findUniqueOrThrow({ where: { id: n.id } })).residencePrecision).toBe('GPS_CAMPO');
  });

  it('configuração: raio do bloqueio e numeração por bairro (exige quarteirões ligados a bairros)', async () => {
    await t.http().patch('/api/territorio/configuracoes').set(auth(gestora)).send({ raioBloqueioM: 30 }).expect(400);
    expect((await t.http().patch('/api/territorio/configuracoes').set(auth(gestora)).send({ raioBloqueioM: 200 }).expect(200)).body.raioBloqueioM).toBe(200);
    await t.http().patch('/api/territorio/configuracoes').set(auth(gestora)).send({ numeracaoQuarteirao: 'BAIRRO' }).expect(422);
    await t.http().patch('/api/territorio/configuracoes').set(auth(acs)).send({ raioBloqueioM: 300 }).expect(403);
    const resumo = (await t.http().get('/api/territorio/resumo').set(auth(acs)).expect(200)).body;
    expect(resumo).toMatchObject({ localidades: 2, quarteiroes: 12, baseDeEnderecos: 5, config: { raioBloqueioM: 200 } });

    // Com todos os quarteirões em bairros, numera por bairro; o mesmo número em outro bairro impede voltar à localidade.
    const semBairro = await db.block.findMany({ where: { active: true, neighborhoodId: null }, select: { localityId: true } });
    for (const l of new Set(semBairro.map((b) => b.localityId))) {
      const nb = await db.neighborhood.create({ data: { localityId: l, name: `Bairro Provisório ${l.slice(-4)}` } });
      await db.block.updateMany({ where: { active: true, neighborhoodId: null, localityId: l }, data: { neighborhoodId: nb.id } });
    }
    await t.http().patch('/api/territorio/configuracoes').set(auth(gestora)).send({ numeracaoQuarteirao: 'BAIRRO' }).expect(200);
    const outro = (await t.http().post('/api/territorio/bairros').set(auth(gestora)).send({ localityId: localidade, name: 'Vila Nova Teste' }).expect(201)).body.id;
    await t
      .http()
      .post('/api/territorio/quarteiroes')
      .set(auth(gestora))
      .send({ localityId: localidade, number: '1', geometry: quadrado(desloca(C, 3000, 3000)) })
      .expect(400);
    await t
      .http()
      .post('/api/territorio/quarteiroes')
      .set(auth(gestora))
      .send({ localityId: localidade, neighborhoodId: outro, number: '1', geometry: quadrado(desloca(C, 3000, 3000)) })
      .expect(201);
    const volta = await t.http().patch('/api/territorio/configuracoes').set(auth(gestora)).send({ numeracaoQuarteirao: 'LOCALIDADE' }).expect(422);
    expect(volta.body.code ?? volta.body.error).toBeDefined();
    expect(JSON.stringify(volta.body)).toContain('repetido');
  });
});
