import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import signpdf from '@signpdf/signpdf';
import { Signer, SUBFILTER_ETSI_CADES_DETACHED } from '@signpdf/utils';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { buildCms, type ParsedPfx } from './cms';

/**
 * Gera o PDF de um documento clínico (prontuário, receita, atestado) e o assina em PAdES
 * (CMS destacado, subfiltro ETSI.CAdES.detached). Fontes padrão do PDF (Helvetica, codificação WinAnsi):
 * cobre o português; caracteres fora dela viram "?".
 */

export interface DocumentModel {
  title: string;
  unit: { name: string; cnes: string; address?: string | null };
  patient: {
    name: string;
    cpf?: string | null;
    cns?: string | null;
    birthDate: Date;
  };
  professional: {
    name: string;
    council?: string | null;
    cbo: string;
    roleLabel: string;
  };
  issuedAt: Date;
  timeZone: string;
  sections: { heading?: string; paragraphs: string[] }[];
  /** Linhas pequenas no fim (hash da trilha de auditoria, instruções de verificação). */
  footer: string[];
  signer: { name: string; cpf: string };
}

const PAGE = { width: 595.28, height: 841.89, margin: 50 } as const;
const WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split(''));

/** Mantém só o que a codificação WinAnsi das fontes padrão do PDF representa. */
export function toWinAnsi(text: string): string {
  return [...text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, '  ')]
    .map((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      if (ch === '\n' || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.has(ch)) return ch;
      return '?';
    })
    .join('');
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of toWinAnsi(text).split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        line = word;
        continue;
      }
      let chunk = '';
      for (const ch of word) {
        if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
          lines.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
    }
    lines.push(line);
  }
  return lines;
}

export function formatDateTime(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(d);
}
export function formatDate(d: Date, timeZone = 'UTC'): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    dateStyle: 'short',
  }).format(d);
}
export const maskCpf = (cpf: string) => (cpf.length === 11 ? `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}` : cpf);

class Writer {
  page!: PDFPage;
  y = 0;
  readonly width = PAGE.width - PAGE.margin * 2;
  constructor(
    private readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - PAGE.margin;
  }
  ensure(height: number) {
    if (this.y - height < PAGE.margin + 30) this.newPage();
  }
  text(
    text: string,
    opts: {
      size?: number;
      bold?: boolean;
      align?: 'left' | 'center';
      color?: [number, number, number];
      gap?: number;
    } = {},
  ) {
    const size = opts.size ?? 10.5;
    const font = opts.bold ? this.bold : this.regular;
    const lineHeight = size * 1.35;
    for (const line of wrap(text, font, size, this.width)) {
      this.ensure(lineHeight);
      const x = opts.align === 'center' ? PAGE.margin + (this.width - font.widthOfTextAtSize(line, size)) / 2 : PAGE.margin;
      this.page.drawText(line, {
        x,
        y: this.y - size,
        size,
        font,
        color: rgb(...(opts.color ?? [0.1, 0.1, 0.1])),
      });
      this.y -= lineHeight;
    }
    this.y -= opts.gap ?? 0;
  }
  rule(gap = 8) {
    this.ensure(gap * 2);
    this.y -= gap;
    this.page.drawLine({
      start: { x: PAGE.margin, y: this.y },
      end: { x: PAGE.width - PAGE.margin, y: this.y },
      thickness: 0.6,
      color: rgb(0.6, 0.6, 0.6),
    });
    this.y -= gap;
  }
  space(n: number) {
    this.y -= n;
  }
}

/** Monta o PDF (ainda sem assinatura) com o campo de assinatura reservado. */
export async function renderDocument(model: DocumentModel, placeholder: { reason: string; location: string; contactInfo: string }): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(model.title);
  doc.setAuthor(model.professional.name);
  doc.setCreator('OmniSaúde');
  doc.setProducer('OmniSaúde');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, regular, bold);

  w.text(model.unit.name, { bold: true, size: 12, align: 'center' });
  w.text(`CNES ${model.unit.cnes}${model.unit.address ? ` · ${model.unit.address}` : ''}`, { size: 9, align: 'center', color: [0.35, 0.35, 0.35] });
  w.space(14);
  w.text(model.title.toUpperCase(), {
    bold: true,
    size: 16,
    align: 'center',
    gap: 10,
  });
  w.rule();
  const ids = [model.patient.cpf ? `CPF ${maskCpf(model.patient.cpf)}` : null, model.patient.cns ? `CNS ${model.patient.cns}` : null].filter(Boolean).join(' · ');
  w.text(`Paciente: ${model.patient.name}`, { bold: true });
  w.text(`${ids ? `${ids} · ` : ''}Nascimento ${formatDate(model.patient.birthDate)}`, { size: 9.5, color: [0.3, 0.3, 0.3] });
  w.space(4);
  w.text(`Profissional: ${model.professional.name}${model.professional.council ? ` · ${model.professional.council}` : ''}`, { bold: true });
  w.text(`${model.professional.roleLabel} · CBO ${model.professional.cbo} · emitido em ${formatDateTime(model.issuedAt, model.timeZone)}`, { size: 9.5, color: [0.3, 0.3, 0.3] });
  w.rule();
  for (const section of model.sections) {
    if (section.heading) w.text(section.heading, { bold: true, size: 11, gap: 2 });
    for (const p of section.paragraphs) w.text(p, { gap: 4 });
    w.space(6);
  }
  w.space(10);
  w.rule(6);
  w.text('ASSINADO DIGITALMENTE', {
    bold: true,
    size: 9,
    color: [0.1, 0.4, 0.2],
  });
  w.text(`${model.signer.name} · CPF ${maskCpf(model.signer.cpf)} · ${formatDateTime(model.issuedAt, model.timeZone)}`, { size: 9 });
  w.text(
    'Documento assinado com certificado digital no padrão ICP-Brasil (PAdES), com validade jurídica nos termos da MP nº 2.200-2/2001. A assinatura pode ser conferida em https://validar.iti.gov.br ou na área de auditoria do sistema.',
    { size: 8, color: [0.3, 0.3, 0.3] },
  );
  for (const line of model.footer) w.text(line, { size: 7.5, color: [0.4, 0.4, 0.4] });

  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const label = `Página ${i + 1} de ${pages.length}`;
    page.drawText(label, {
      x: PAGE.width - PAGE.margin - regular.widthOfTextAtSize(label, 8),
      y: PAGE.margin / 2,
      size: 8,
      font: regular,
      color: rgb(0.5, 0.5, 0.5),
    });
  });

  pdflibAddPlaceholder({
    pdfDoc: doc,
    reason: toWinAnsi(placeholder.reason),
    contactInfo: toWinAnsi(placeholder.contactInfo),
    name: toWinAnsi(model.signer.name),
    location: toWinAnsi(placeholder.location),
    signatureLength: 24000,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    appName: 'OmniSaude',
  });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

class CmsSigner extends Signer {
  lastCms: Buffer | null = null;
  constructor(
    private readonly pfx: ParsedPfx,
    private readonly at: Date,
  ) {
    super();
  }
  override async sign(pdf: Buffer): Promise<Buffer> {
    this.lastCms = buildCms({
      content: pdf,
      pfx: this.pfx,
      signingTime: this.at,
    });
    return this.lastCms;
  }
}

/** Assina o PDF preparado por renderDocument; devolve o arquivo assinado e o CMS embutido. */
export async function signPdf(unsigned: Buffer, pfx: ParsedPfx, signingTime: Date): Promise<{ pdf: Buffer; cms: Buffer }> {
  const signer = new CmsSigner(pfx, signingTime);
  const signed = await signpdf.sign(unsigned, signer, signingTime);
  return { pdf: Buffer.from(signed), cms: signer.lastCms! };
}
