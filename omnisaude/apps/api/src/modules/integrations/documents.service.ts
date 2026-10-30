import { Injectable, Logger } from '@nestjs/common';
import { LlmDocumentExtractor, parseDocumentText, validateExtraction } from '@omnisaude/ai-engine';
import type { CadsusCitizen } from '@omnisaude/fhir';
import { isValidCns, isValidCpf } from '@omnisaude/shared';
import type { RequestContext } from '../../core/context';
import { DomainError } from '../../core/errors';
import { PatientsService } from '../patients/patients.service';
import { AiService } from './ai.service';
import { RndsService } from './rnds.service';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger('Documentos');

  constructor(
    private readonly ai: AiService,
    private readonly rnds: RndsService,
    private readonly patients: PatientsService,
  ) {}

  /** Consulta síncrona ao CADSUS (via RNDS) e indica se a pessoa já está cadastrada no tenant. */
  async cadsusLookup(ctx: RequestContext, query: { cpf?: string; cns?: string }) {
    const client = await this.rnds.cadsus(ctx.tenant.id);
    if (!client) throw new DomainError('CADSUS_INDISPONIVEL', 'Integração com o CADSUS não configurada', 503);
    let citizen: CadsusCitizen | null = null;
    if (query.cpf) citizen = await client.findByCpf(query.cpf);
    else if (query.cns) citizen = await client.findByCns(query.cns);
    else throw new DomainError('CADSUS_CONSULTA', 'Informe CPF ou CNS');
    if (!citizen) return { found: false as const };
    const local = citizen.name && citizen.birthDate
      ? await this.patients.findDuplicates(ctx, { cpf: citizen.cpf, cns: citizen.cns[0], name: citizen.name, birthDate: citizen.birthDate })
      : [];
    return { found: true as const, citizen, localMatches: local };
  }

  /**
   * Leitura de documento (RG, CNH, certidão, cartão SUS) para autopreenchimento do cadastro.
   * Imagem: modelo multimodal (exige IA ativada no tenant). Texto (OCR feito no aparelho): parser local.
   * O resultado é validado (dígitos de CPF/CNS) e cruzado com o CADSUS e com a base local.
   */
  async readDocument(ctx: RequestContext, input: { image?: string; mediaType?: string; text?: string }) {
    let extracted;
    let source: 'IA' | 'TEXTO';
    if (input.image) {
      const llm = this.ai.require(ctx);
      const mediaType = (input.mediaType ?? 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp';
      extracted = await new LlmDocumentExtractor(llm).extract({ data: input.image, mediaType });
      source = 'IA';
    } else if (input.text) {
      extracted = parseDocumentText(input.text);
      source = 'TEXTO';
    } else {
      throw new DomainError('DOCUMENTO_VAZIO', 'Envie a imagem do documento ou o texto lido');
    }
    const validation = validateExtraction(extracted);
    const data = validation.data;
    let cadsus: Awaited<ReturnType<DocumentsService['cadsusLookup']>> | { error: string } | null = null;
    const cpf = data.cpf && isValidCpf(data.cpf) ? data.cpf : undefined;
    const cns = data.cns && isValidCns(data.cns) ? data.cns : undefined;
    if (cpf || cns) {
      try {
        cadsus = await this.cadsusLookup(ctx, cpf ? { cpf } : { cns });
      } catch (err) {
        cadsus = { error: (err as Error).message };
      }
    }
    const localMatches =
      data.fullName && data.birthDate
        ? await this.patients.findDuplicates(ctx, { cpf, cns, name: data.fullName, birthDate: data.birthDate, motherName: data.motherName })
        : [];
    const divergences: string[] = [];
    if (cadsus && 'found' in cadsus && cadsus.found) {
      const c = cadsus.citizen;
      if (data.birthDate && c.birthDate && data.birthDate !== c.birthDate) divergences.push('Data de nascimento difere do CADSUS');
      if (data.motherName && c.motherName && data.motherName.toUpperCase() !== c.motherName.toUpperCase()) divergences.push('Nome da mãe difere do CADSUS');
    }
    return { source, extracted: data, issues: validation.issues, valid: validation.valid, cadsus, localMatches, divergences };
  }
}
