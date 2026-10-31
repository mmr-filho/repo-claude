import { Inject, Injectable } from '@nestjs/common';
import type { MasterClient } from '@omnisaude/database';
import { readFileSync } from 'node:fs';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import { MASTER_DB } from '../../core/database';
import { rndsEndpoints } from '@omnisaude/fhir';
import { StorageService } from '../../core/storage.service';

export interface WhatsAppConfig {
  baseUrl: string;
  apiVersion?: string;
  phoneNumberId: string;
  accessToken: string;
  appSecret?: string;
  verifyToken?: string;
}

export interface RndsConfig {
  authUrl: string;
  ehrUrl: string;
  /** homologacao, producao ou simulado (servidor de mocks). */
  environment: 'homologacao' | 'producao' | 'simulado' | 'personalizado';
  uf?: string;
  /** CNS do profissional em nome de quem as requisições são feitas (cabeçalho Authorization). */
  requesterCns?: string;
  /** Compatibilidade com o simulador e configurações antigas. */
  requesterCpf?: string;
  /** Identificador do solicitante credenciado (compõe o identificador dos documentos). */
  requesterId: string;
  tls?: { pfx: Buffer; passphrase?: string };
}

type Kind = 'WHATSAPP' | 'RNDS' | 'SEFAZ';

/**
 * Configuração das integrações por tenant: tenant_integrations (master) com o segredo referenciado por nome
 * de variável de ambiente (secretRef), e as variáveis globais como padrão. Em desenvolvimento, MOCKS_URL
 * aponta tudo para o servidor simulado.
 */
@Injectable()
export class IntegrationConfigService {
  private readonly cache = new Map<string, { at: number; value: { enabled: boolean; config: Record<string, unknown>; secretRef: string | null } | null }>();

  constructor(
    @Inject(MASTER_DB) private readonly master: MasterClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly storage: StorageService,
  ) {}

  private async row(tenantId: string, kind: Kind) {
    const key = `${tenantId}:${kind}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const row = await this.master.tenantIntegration.findUnique({ where: { tenantId_kind: { tenantId, kind } } });
    const value = row ? { enabled: row.enabled, config: (row.config ?? {}) as Record<string, unknown>, secretRef: row.secretRef } : null;
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  private secret(ref: string | null | undefined): string | undefined {
    return ref ? process.env[ref] : undefined;
  }

  async whatsapp(tenantId: string): Promise<WhatsAppConfig | null> {
    const row = await this.row(tenantId, 'WHATSAPP');
    if (row && !row.enabled) return null;
    const c = row?.config ?? {};
    const baseUrl = (c.baseUrl as string) ?? this.config.WHATSAPP_BASE_URL ?? (this.config.MOCKS_URL ? `${this.config.MOCKS_URL}/whatsapp` : undefined);
    const phoneNumberId = (c.phoneNumberId as string) ?? this.config.WHATSAPP_PHONE_NUMBER_ID ?? (this.config.MOCKS_URL ? '000000000000000' : undefined);
    const accessToken = this.secret(row?.secretRef) ?? this.config.WHATSAPP_ACCESS_TOKEN ?? (this.config.MOCKS_URL ? 'token-de-desenvolvimento' : undefined);
    if (!baseUrl || !phoneNumberId || !accessToken) return null;
    return {
      baseUrl,
      apiVersion: c.apiVersion as string | undefined,
      phoneNumberId,
      accessToken,
      appSecret: this.secret(c.appSecretRef as string) ?? this.config.WHATSAPP_APP_SECRET,
      verifyToken: (c.verifyToken as string) ?? this.config.WHATSAPP_VERIFY_TOKEN,
    };
  }

  async rnds(tenantId: string): Promise<RndsConfig | null> {
    const row = await this.row(tenantId, 'RNDS');
    if (row && !row.enabled) return null;
    const c = row?.config ?? {};
    const mocks = this.config.MOCKS_URL;
    const environment = ((c.environment as string) ?? this.config.RNDS_ENVIRONMENT) as 'homologacao' | 'producao' | undefined;
    const uf = ((c.uf as string) ?? this.config.RNDS_UF)?.toLowerCase();
    const official = environment ? safeEndpoints(environment, uf) : null;
    let authUrl = (c.authUrl as string) ?? this.config.RNDS_AUTH_URL ?? official?.authUrl;
    let ehrUrl = (c.ehrUrl as string) ?? this.config.RNDS_EHR_URL ?? official?.ehrUrl;
    let kind: RndsConfig['environment'] = environment ?? 'personalizado';
    if (!authUrl || !ehrUrl) {
      if (!mocks) return null;
      authUrl = `${mocks}/rnds/auth`;
      ehrUrl = `${mocks}/rnds/ehr`;
      kind = 'simulado';
    }
    const requesterCns = (c.requesterCns as string) ?? this.config.RNDS_REQUESTER_CNS;
    const requesterCpf = (c.requesterCpf as string) ?? this.config.RNDS_REQUESTER_CPF;
    if (!requesterCns && !requesterCpf) return null;
    const pfxPath = (c.certPfxPath as string) ?? this.config.RNDS_CERT_PFX;
    const pfx = pfxPath ? await this.certificate(pfxPath) : undefined;
    const passphrase = this.secret(c.certPassphraseRef as string) ?? this.config.RNDS_CERT_PASSPHRASE;
    return {
      authUrl,
      ehrUrl,
      environment: kind,
      uf,
      requesterCns,
      requesterCpf,
      requesterId: (c.requesterId as string) ?? tenantId,
      tls: pfx ? { pfx, passphrase } : undefined,
    };
  }

  /**
   * Certificado ICP-Brasil: caminho de arquivo, ou "r2:<chave>" para lê-lo do armazenamento de objetos
   * (no Cloudflare Containers não há disco persistente e cada segredo é limitado a poucos KB).
   */
  private async certificate(path: string): Promise<Buffer> {
    return path.startsWith('r2:') ? this.storage.get(path.slice(3)) : readFileSync(path);
  }

  async sefazUrl(tenantId: string): Promise<string | null> {
    const row = await this.row(tenantId, 'SEFAZ');
    if (row && !row.enabled) return null;
    return (row?.config.url as string) ?? this.config.SEFAZ_URL ?? (this.config.MOCKS_URL ? `${this.config.MOCKS_URL}/sefaz` : null);
  }
}

function safeEndpoints(environment: 'homologacao' | 'producao', uf?: string): { authUrl: string; ehrUrl: string } | null {
  try {
    return rndsEndpoints(environment, uf);
  } catch {
    return null;
  }
}
