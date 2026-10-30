import { Container, getContainer } from '@cloudflare/containers';
import {
  API_PORT,
  CONTAINER_ENTRYPOINT,
  CRON_JOBS,
  apiPath,
  basePath,
  configFingerprint,
  containerEnv,
  isInternalOnly,
  toContainerRequest,
  type OmniVars,
} from './routing';

export interface Env extends OmniVars {
  /** Telas do OmniSaúde (exportação estática do Next.js em public/omnisaude). */
  ASSETS: Fetcher;
  /** API NestJS no Cloudflare Containers (uma instância). */
  API: DurableObjectNamespace<OmniApi>;
}

const STARTED_WITH = 'omni:config';

/**
 * A API roda numa única instância: o Socket.IO (painel, censo) e a central de intérpretes de Libras guardam
 * estado em memória. Na primeira partida o container prepara o banco antes de abrir a porta, o que pode
 * levar alguns minutos; por isso a espera é maior que o padrão.
 */
export class OmniApi extends Container<Env> {
  defaultPort = API_PORT;
  sleepAfter = '15m';
  enableInternet = true;
  private configError?: string;
  private starting?: Promise<void>;

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    this.entrypoint = CONTAINER_ENTRYPOINT;
    try {
      this.envVars = containerEnv(env);
    } catch (err) {
      this.configError = err instanceof Error ? err.message : String(err);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (this.configError) return Response.json({ message: this.configError }, { status: 500 });
    try {
      // Requisições simultâneas esperam a mesma partida.
      await (this.starting ??= this.ensureRunning().finally(() => (this.starting = undefined)));
    } catch (err) {
      console.error('API não subiu', err);
      return Response.json(
        { message: 'O OmniSaúde está iniciando. Tente de novo em instantes.' },
        { status: 503, headers: { 'retry-after': '15' } },
      );
    }
    return this.containerFetch(request, API_PORT);
  }

  override async onStart() {
    await this.ctx.storage.put(STARTED_WITH, await this.fingerprint());
  }

  override onStop(params: { exitCode: number; reason: string }) {
    if (params.exitCode !== 0) console.error(`Container da API parou (código ${params.exitCode}, ${params.reason})`);
  }

  /** Sobe a API; se ela está no ar com variáveis ou segredos antigos, reinicia com os atuais. */
  private async ensureRunning() {
    const { status } = await this.getState();
    if (status === 'healthy' || status === 'running') {
      if ((await this.ctx.storage.get<string>(STARTED_WITH)) !== (await this.fingerprint())) {
        console.log('Configuração do Worker mudou: reiniciando a API');
        await this.destroy();
      } else if (status === 'healthy') {
        return;
      }
    }
    await this.startAndWaitForPorts({ ports: API_PORT, cancellationOptions: { portReadyTimeoutMS: 5 * 60_000 } });
  }

  private fingerprint() {
    return configFingerprint(this.envVars ?? {}, this.entrypoint ?? []);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = apiPath(url.pathname, basePath(env));
    if (path === null) return env.ASSETS.fetch(request);
    if (isInternalOnly(path)) return new Response('Não encontrado', { status: 404 });
    return getContainer(env.API).fetch(toContainerRequest(request, path));
  },

  async scheduled(event, env, ctx): Promise<void> {
    const tasks = CRON_JOBS[event.cron];
    if (!tasks) return;
    const request = new Request(`${env.PUBLIC_ORIGIN}/api/jobs/tick?tasks=${tasks}`, {
      method: 'POST',
      headers: { 'x-omni-jobs': env.JOBS_SECRET },
    });
    ctx.waitUntil(
      getContainer(env.API)
        .fetch(request)
        .then(async (res) => {
          if (!res.ok) console.error(`Jobs ${tasks}: HTTP ${res.status} ${await res.text()}`);
        }),
    );
  },
} satisfies ExportedHandler<Env>;
