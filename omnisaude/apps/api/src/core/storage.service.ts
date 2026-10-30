import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { APP_CONFIG, type AppConfig } from './config';

/**
 * Armazenamento de objetos: Cloudflare R2 pela API S3 (laudos, termos, documentos digitalizados, PDFs
 * assinados). Sem R2 configurado, grava numa pasta local (somente desenvolvimento).
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger('Storage');
  private readonly s3?: S3Client;
  private readonly bucket?: string;
  private readonly localDir: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.localDir = resolve(config.LOCAL_STORAGE_DIR);
    if (config.R2_BUCKET && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY && (config.R2_ENDPOINT || config.R2_ACCOUNT_ID)) {
      this.s3 = new S3Client({
        region: 'auto',
        endpoint: config.R2_ENDPOINT ?? `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY },
      });
      this.bucket = config.R2_BUCKET;
    } else {
      this.logger.warn(`R2 não configurado: arquivos em ${this.localDir}`);
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.s3) {
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
      return;
    }
    const path = this.localPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Buffer> {
    if (this.s3) {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    }
    return readFile(this.localPath(key));
  }

  private localPath(key: string) {
    const path = resolve(join(this.localDir, key));
    if (!path.startsWith(this.localDir)) throw new Error('Chave de arquivo inválida');
    return path;
  }
}
