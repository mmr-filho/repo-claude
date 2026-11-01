import type { ContextoAgravo } from './catalogo';

/**
 * De-para inicial de códigos (CID-10 e CIAP-2) para grupo de agravo da Lista Nacional. Vale o prefixo mais longo.
 * Só quatro mapeamentos foram conferidos em ficha ou nota técnica oficial e entram homologados; os demais entram
 * propostos e disparam o rascunho com o aviso "mapeamento não homologado" até um técnico da vigilância homologar.
 * Falso positivo é descartável; falso negativo perde prazo legal.
 */
export interface MapeamentoInicial {
  system: 'CID10' | 'CIAP2';
  codePrefix: string;
  group: string;
  context?: ContextoAgravo;
  status: 'PROPOSTO' | 'HOMOLOGADO';
  source: string;
}

const PROPOSTO = 'CID-10 (OMS/DATASUS), proposto pela equipe do OmniSaúde; homologar na vigilância';
const CIAP = 'CIAP-2, proposto pela equipe do OmniSaúde; homologar na vigilância';

const cid = (prefixos: string[], group: string, context?: ContextoAgravo, source = PROPOSTO): MapeamentoInicial[] =>
  prefixos.map((codePrefix) => ({ system: 'CID10', codePrefix, group, ...(context ? { context } : {}), status: 'PROPOSTO', source }));
const faixa = (letra: string, de: number, ate: number) => Array.from({ length: ate - de + 1 }, (_, i) => `${letra}${String(de + i).padStart(2, '0')}`);

export const MAPEAMENTOS_INICIAIS: MapeamentoInicial[] = [
  // Conferidos em fonte oficial.
  { system: 'CID10', codePrefix: 'A379', group: 'coqueluche', status: 'HOMOLOGADO', source: 'Ficha de investigação de coqueluche do Sinan Net v5 (CID A37.9)' },
  { system: 'CID10', codePrefix: 'A930', group: 'oropouche', status: 'HOMOLOGADO', source: 'NT nº 117/2024-CGARB/DEDT/SVSA/MS (CID A93.0)' },
  { system: 'CID10', codePrefix: 'B42', group: 'esporotricose', status: 'HOMOLOGADO', source: 'NT nº 20/2025-CGTM/DATHI/SVSA/MS (CID B42)' },
  { system: 'CID10', codePrefix: 'W64', group: 'atendimento-antirrabico', status: 'HOMOLOGADO', source: 'Ficha de atendimento antirrábico humano do Sinan (W64)' },
  // Propostos.
  ...cid(['A37'], 'coqueluche'),
  ...cid(['W54', 'W55'], 'atendimento-antirrabico'),
  ...cid(['A90', 'A91'], 'dengue'),
  ...cid(['A920'], 'chikungunya'),
  ...cid(['A925', 'A928'], 'zika'),
  ...cid(['P354'], 'zika', 'ANOMALIA_CONGENITA'),
  ...cid(['A923'], 'nilo-ocidental-arboviroses'),
  ...cid(['A95'], 'febre-amarela'),
  ...cid(['A77'], 'febre-maculosa'),
  ...cid(['A010'], 'febre-tifoide'),
  ...cid(['A00'], 'colera'),
  ...cid(['A051'], 'botulismo'),
  ...cid(['A36'], 'difteria'),
  ...cid(['A33'], 'tetano', 'OUTRO'),
  ...cid(['A35'], 'tetano', 'CASO'),
  ...cid(['A27'], 'leptospirose'),
  ...cid(['B334', 'A985'], 'hantavirose'),
  ...cid(['A20'], 'peste'),
  ...cid(['A82'], 'raiva-humana'),
  ...cid(['A30'], 'hanseniase'),
  ...cid(['A15', 'A16', 'A17', 'A18', 'A19'], 'tuberculose'),
  ...cid(['A39', 'A87', 'G00', 'G01', 'G02', 'G03'], 'meningites'),
  ...cid(['G000', 'A413'], 'haemophilus-invasiva'),
  ...cid(['B570', 'B571'], 'chagas-aguda'),
  ...cid(['B572', 'B573', 'B574', 'B575'], 'chagas-cronica'),
  ...cid(['B550'], 'leishmaniose-visceral'),
  ...cid(['B551', 'B552'], 'lta'),
  ...cid(['B65'], 'esquistossomose'),
  ...cid(['B50', 'B51', 'B52', 'B53', 'B54'], 'malaria'),
  ...cid(['B04'], 'mpox'),
  ...cid(['B05', 'B06'], 'sarampo-rubeola'),
  ...cid(['P350'], 'rubeola-congenita'),
  ...cid(['B01'], 'varicela'),
  ...cid(['B26'], 'caxumba'),
  ...cid(['B15', 'B16', 'B17', 'B18', 'B19'], 'hepatites-virais'),
  ...cid(['O984'], 'hepatite-b-gestacao', 'GESTANTE'),
  ...cid(['B20', 'B21', 'B22', 'B23', 'B24'], 'aids'),
  ...cid(['Z21'], 'hiv'),
  ...cid(['O987'], 'hiv-gestacao', 'GESTANTE'),
  ...cid(['B333'], 'htlv'),
  ...cid(['J09'], 'influenza-novo-subtipo'),
  ...cid(['A810'], 'dcj'),
  ...cid(['D57'], 'doenca-falciforme'),
  ...cid(['O986', 'P371'], 'toxoplasmose-gestacional-congenita'),
  ...cid(['A50', 'A51', 'A52', 'A53', 'O981'], 'sifilis'),
  ...cid(['Q'], 'anomalias-congenitas'),
  ...cid(['A221', 'A21', 'B03'], 'disseminacao-intencional'),
  ...cid(['A96', 'A983', 'A984'], 'febres-hemorragicas'),
  ...cid(['U109'], 'sim-p'),
  ...cid(['U071'], 'covid'),
  ...cid(['T880', 'T881', 'Y59'], 'esavi'),
  ...cid(faixa('T', 36, 65), 'intoxicacao-exogena'),
  ...cid(['T63'], 'acidente-animal-peconhento'),
  ...cid(faixa('X', 20, 29), 'acidente-animal-peconhento'),
  ...cid(['W46'], 'acidente-trabalho-biologico'),
  ...cid(['T74', ...faixa('Y', 0, 4), ...faixa('Y', 6, 9)], 'violencia'),
  ...cid(['T742', 'Y05', ...faixa('X', 60, 84)], 'violencia-sexual-suicidio'),
  // CIAP-2 (atenção primária).
  ...(
    [
      ['A70', 'tuberculose'],
      ['A71', 'sarampo-rubeola'],
      ['A72', 'varicela'],
      ['A73', 'malaria'],
      ['B90', 'hiv'],
      ['D72', 'hepatites-virais'],
      ['X70', 'sifilis'],
      ['Y70', 'sifilis'],
      ['Z25', 'violencia'],
    ] as const
  ).map(([codePrefix, group]): MapeamentoInicial => ({ system: 'CIAP2', codePrefix, group, status: 'PROPOSTO', source: CIAP })),
];
