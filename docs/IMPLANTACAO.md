# Colocando o servidor no ar

O app precisa de **um servidor sempre ligado, com HTTPS**, num endereço que os celulares alcancem (por exemplo `https://sigilo.suaorganizacao.com`). O código do servidor já está no repositório (`packages/server`); este guia mostra onde rodá-lo.

## Resposta curta sobre a Cloudflare

| Produto da Cloudflare | Serve para o Sigilo? |
|---|---|
| **Cloudflare Tunnel** (+ seu domínio no DNS da Cloudflare) | **Sim, é o caminho recomendado.** A Cloudflare faz a "porta de entrada" HTTPS, e o servidor roda numa máquina sua (VPS ou computador). Não precisa abrir porta nem configurar certificado. WebSocket funciona. |
| **Workers / Pages** | **Não, não do jeito que está.** O servidor é um processo Node.js que grava num arquivo SQLite e mantém conexões WebSocket na memória. Workers não têm disco nem esse SQLite; rodar lá exigiria reescrever o servidor (Durable Objects + banco da Cloudflare). |
| **Cloudflare Containers** | **Não recomendo.** Até onde sei, o disco do contêiner não é persistente, e o banco de contas e mensagens precisa ser. Confira a documentação atual antes de considerar. |

Ou seja: **a Cloudflare entra na frente do servidor, e o servidor roda em outro lugar.**

## O que você precisa

1. **Um computador ligado 24 h com Docker**, por exemplo:
   - uma VPS pequena (1 vCPU e 1 GB de RAM bastam para começar; custa em torno de US$ 4 a 6 por mês na Hetzner, DigitalOcean, Contabo e similares; há planos gratuitos, como o *Always Free* da Oracle Cloud, sujeitos às regras de cada provedor);
   - ou uma máquina sua que fique sempre ligada (mini-PC, Raspberry Pi 4 ou 5).
2. **Um domínio** gerenciado pela Cloudflare (o DNS do domínio precisa estar lá). Se você só tem conta e não tem domínio, é preciso registrar um (a Cloudflare vende a preço de custo) ou usar o teste rápido descrito mais abaixo.
3. A **conta Cloudflare** que você já tem. O Tunnel está no painel *Zero Trust*, que tem plano gratuito.

Não medi quantos usuários uma máquina pequena suporta. Comece pequeno e acompanhe o uso.

## Passo a passo

### 1. Prepare a máquina

Instale o Docker (no Ubuntu: <https://docs.docker.com/engine/install/ubuntu/>) e o git. Libere só a porta do SSH no firewall. **Não abra a porta 3000**: o servidor só deve ser alcançado pelo túnel.

### 2. Crie o túnel na Cloudflare

No painel da Cloudflare, abra **Zero Trust → Networks → Tunnels** (os nomes dos menus mudam de tempos em tempos) e:

1. **Create a tunnel** → tipo **Cloudflared** → dê um nome (ex.: `sigilo`).
2. Escolha **Docker** e **copie o token** que aparece (a longa sequência depois de `--token`).
3. Na aba **Public Hostname**, adicione:
   - *Subdomain:* `sigilo`, *Domain:* o seu domínio;
   - *Service:* tipo `HTTP`, URL `sigilo:3000`.

### 3. Suba o servidor

Na máquina:

```bash
git clone https://github.com/mmr-filho/repo-claude
cd repo-claude
git checkout claude/quirky-gates-6s7wtu
cd deploy
cp .env.example .env
nano .env                      # cole o token em TUNNEL_TOKEN=
docker compose up -d --build
```

Isso sobe dois contêineres: o servidor (`sigilo`) e o túnel (`cloudflared`). Os dados ficam no volume `sigilo-data`, que sobrevive a reinícios e atualizações.

### 4. Confira

```bash
curl https://sigilo.suaorganizacao.com/health     # deve responder {"ok":true}
docker compose logs -f sigilo                      # acompanhar
```

### 5. Crie a primeira rede e o administrador

```bash
docker compose exec sigilo node dist/cli.js create-network \
  --slug unirg --name "UniRG" --admin maria --admin-name "Maria Silva"
```

O código de ativação aparece **uma única vez**. Entregue-o a quem será o administrador.

### 6. Gere o app apontando para o servidor

O endereço fica gravado dentro do app na hora da geração (veja "Gerar o APK" no [README](../README.md)):

```bash
EXPO_PUBLIC_SERVER_URL=https://sigilo.suaorganizacao.com   # junto do comando de geração do APK
```

## Teste rápido, sem domínio

Só para experimentar (não para uso real), o `cloudflared` cria um endereço HTTPS temporário, sem conta e sem domínio:

```bash
npm run dev:server                                 # servidor local na porta 3000
cloudflared tunnel --url http://localhost:3000     # mostra algo como https://palavras-aleatorias.trycloudflare.com
```

O endereço **muda a cada execução**, e o app tem o endereço gravado, então um APK gerado assim deixa de funcionar quando o túnel cai.

## Operação

- **Atualizar:** `git pull && docker compose up -d --build` (dentro de `deploy/`).
- **Logs:** `docker compose logs -f sigilo`.
- **Backup:** o banco é um arquivo SQLite dentro do volume. Para uma cópia consistente, pare o servidor por alguns segundos:

  ```bash
  docker compose stop sigilo
  docker run --rm -v "$(docker volume ls -q | grep sigilo-data)":/data -v "$PWD":/backup busybox \
    tar czf /backup/sigilo-$(date +%F).tgz /data
  docker compose start sigilo
  ```

  Guarde as cópias **fora** da máquina. Elas contêm contas, chaves públicas e as chaves privadas **cifradas** (protegidas pelas senhas dos usuários), além de mensagens ainda não lidas, que também estão cifradas.
- **Uma instância só.** As conexões em tempo real ficam na memória do processo; não rode duas réplicas do servidor.
- **Esqueceu a senha do único administrador:** `docker compose exec sigilo node dist/cli.js reset-activation maria@unirg`.

## Segurança: o que muda com a Cloudflare na frente

- A Cloudflare **termina o HTTPS** na borda dela. Isso significa que ela enxerga o tráfego entre o app e o servidor: **metadados** (quem fala com quem, quando), os envelopes **já cifrados** e os tokens de sessão. Ela **não consegue ler mensagens**, que são cifradas de ponta a ponta no celular. Mas um comprometimento da Cloudflare (ou da sua conta nela) permitiria sequestrar sessões. Proteja a conta com autenticação em dois fatores.
- Se você não quer essa confiança extra, a alternativa é HTTPS direto na VPS (por exemplo com Caddy e Let's Encrypt), sem Cloudflare.
- **Não coloque o Cloudflare Access** (tela de login do Zero Trust) na frente do endereço: o app não sabe passar por ela.
- Mantenha `TRUST_PROXY=true` (já está no compose) **somente** se o servidor não tiver porta pública. Com ela exposta, qualquer um poderia forjar o IP e driblar o limite de tentativas.
- No painel da Cloudflare, ative regras de limitação de taxa (*rate limiting*) em `/auth/*` se quiser uma camada a mais; o servidor já limita por IP e bloqueia contas após tentativas erradas.

## Outras opções de hospedagem

- **VPS com Caddy** (HTTPS automático, sem Cloudflare): mesma imagem Docker, trocando o `cloudflared` por um Caddy na frente.
- **Fly.io, Railway, Render:** servem se você ligar um **volume persistente** em `/data` e rodar **uma única instância**.
- Para crescer além de uma máquina, troque o SQLite por PostgreSQL e mova as conexões em tempo real para um barramento (por exemplo, Redis).

## O que não consegui verificar

Não consegui construir a imagem Docker nem subir o túnel neste ambiente (o daemon do Docker não roda aqui e não há acesso à sua conta Cloudflare). O que verifiquei: os mesmos passos do `Dockerfile` (instalar dependências, compilar, instalar só as de produção, rodar) funcionam em um diretório limpo, o servidor sobe e responde, e o arquivo `docker-compose.yml` é válido. Se algo falhar no `docker compose up`, copie a mensagem de erro e me envie.
