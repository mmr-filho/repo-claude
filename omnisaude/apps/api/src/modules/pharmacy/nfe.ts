import { XMLParser } from 'fast-xml-parser';

/** Campos da NF-e (layout 4.00) usados na entrada de estoque. */
export interface ParsedNfe {
  accessKey: string;
  number: string;
  series: string;
  issuedAt: Date;
  supplierCnpj: string;
  supplierName: string;
  destCnpj: string;
  total: number;
  items: ParsedNfeItem[];
}

export interface ParsedNfeItem {
  index: number;
  supplierCode: string;
  gtin: string | null;
  description: string;
  ncm: string | null;
  commercialUnit: string | null;
  quantity: number;
  unitPrice: number;
  isMedicine: boolean;
  anvisaCode: string | null;
  /** Bloco <rastro>: lote, quantidade, fabricação e validade. */
  lots: { lot: string; quantity: number; manufacturedAt: string | null; expiry: string }[];
}

export class NfeParseError extends Error {}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  // Mantém textos como string: CNPJ, GTIN e chave têm zeros à esquerda.
  parseTagValue: false,
  isArray: (name) => name === 'det' || name === 'rastro',
});

const text = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? String((v as { '#text'?: unknown })['#text'] ?? '') : String(v)).trim();
const num = (v: unknown): number => {
  const n = Number(text(v));
  if (!Number.isFinite(n)) throw new NfeParseError(`Valor numérico inválido: ${text(v)}`);
  return n;
};

export function parseNfe(xml: string): ParsedNfe {
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new NfeParseError(`XML inválido: ${(err as Error).message}`);
  }
  const nfe = doc.nfeProc?.NFe ?? doc.NFe;
  const inf = nfe?.infNFe;
  if (!inf) throw new NfeParseError('Documento não é uma NF-e (infNFe ausente)');
  const id = text(inf['@_Id']);
  const fromProt = text(doc.nfeProc?.protNFe?.infProt?.chNFe);
  const accessKey = (/^NFe(\d{44})$/.exec(id)?.[1] ?? fromProt).replace(/\D/g, '');
  if (accessKey.length !== 44) throw new NfeParseError('Chave de acesso da NF-e ausente ou inválida');

  const dets: any[] = inf.det ?? [];
  if (dets.length === 0) throw new NfeParseError('NF-e sem itens');
  const items = dets.map((det, i): ParsedNfeItem => {
    const prod = det.prod ?? {};
    const ean = text(prod.cEAN);
    const rastros: any[] = prod.rastro ?? [];
    return {
      index: Number(text(det['@_nItem']) || i + 1),
      supplierCode: text(prod.cProd),
      gtin: /^\d{8,14}$/.test(ean) ? ean : null,
      description: text(prod.xProd),
      ncm: text(prod.NCM) || null,
      commercialUnit: text(prod.uCom) || null,
      quantity: num(prod.qCom),
      unitPrice: num(prod.vUnCom),
      isMedicine: prod.med !== undefined,
      anvisaCode: text(prod.med?.cProdANVISA) || null,
      lots: rastros.map((r) => ({
        lot: text(r.nLote),
        quantity: num(r.qLote),
        manufacturedAt: text(r.dFab) || null,
        expiry: text(r.dVal),
      })),
    };
  });

  return {
    accessKey,
    number: text(inf.ide?.nNF),
    series: text(inf.ide?.serie),
    issuedAt: new Date(text(inf.ide?.dhEmi) || text(inf.ide?.dEmi)),
    supplierCnpj: text(inf.emit?.CNPJ),
    supplierName: text(inf.emit?.xNome),
    destCnpj: text(inf.dest?.CNPJ),
    total: num(inf.total?.ICMSTot?.vNF ?? 0),
    items,
  };
}
