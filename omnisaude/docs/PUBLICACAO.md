# Publicação em https://mm.api.br/omnisaude

O OmniSaúde roda num servidor seu (VPS) com Docker. Na frente dele fica um roteador interno (Caddy) que
atende tudo em `/omnisaude`, só em `127.0.0.1:8080`. A internet chega a esse roteador de um destes jeitos:

- **Cloudflare Tunnel**, como no Sigilo, se o domínio `mm.api.br` estiver na sua conta Cloudflare.
- **O servidor web que já responde por `mm.api.br`** (nginx, Caddy, Apache...), com um encaminhamento de
  `/omnisaude`.

```
navegador ──HTTPS──► mm.api.br/omnisaude ──► (Cloudflare Tunnel ou nginx) ──► 127.0.0.1:8080 (Caddy)
                                                                               ├─ /omnisaude/api, /omnisaude/socket.io → API
                                                                               └─ /omnisaude/*                        → web
```

Arquivos usados: `deploy/producao/docker-compose.yml`, `deploy/producao/Caddyfile` e `deploy/producao/.env`.

> **Atenção:** com `SEED_DEMO=true` (padrão) sobe o tenant de demonstração `demo`, com dados fictícios e a
> senha pública `OmniSaude2026` (que está no README). Qualquer pessoa com o endereço consegue entrar. Não
> cadastre pacientes reais nele. Para uso real ainda falta, entre outros pontos de `docs/STATUS.md`, a tela de
> cadastro de profissionais.

## 1. Servidor

- Ubuntu 24.04 LTS, **2 vCPU e 4 GB de RAM** (três PostgreSQL, Redis, API, worker e web; o build do Next.js
  sozinho usa perto de 2 GB) e 40 GB de disco.
- Se o servidor que já atende `mm.api.br` tiver folga, pode ser o mesmo.

Conecte por SSH e instale o necessário:

```bash
ssh root@IP_DO_SERVIDOR
```
```bash
apt update && apt install -y git ufw openssl
```
```bash
curl -fsSL https://get.docker.com | sh
```
```bash
ufw allow OpenSSH && ufw --force enable
```

Não abra as portas 8080, 3000, 3001 nem 5432: só o túnel ou o proxy local alcançam o sistema.

## 2. Código

```bash
git clone https://github.com/mmr-filho/repo-claude.git /opt/omnisaude
```
```bash
cd /opt/omnisaude && git checkout claude/busy-cray-f9aqxw
```
```bash
cd /opt/omnisaude/omnisaude/deploy/producao
```

## 3. Senhas e segredos

Crie o `.env` e gere todas as senhas de uma vez:

```bash
cp .env.example .env
```
```bash
for v in MASTER_DB_PASSWORD POSTGRES_SUPERUSER_PASSWORD APP_DB_PASSWORD ADMIN_DB_PASSWORD BI_DB_PASSWORD REPLICATION_PASSWORD JWT_SECRET; do sed -i "s|^$v=\$|$v=$(openssl rand -hex 24)|" .env; done
```
```bash
sed -i "s|^DATA_KEY=\$|DATA_KEY=$(openssl rand -base64 32)|" .env
```
```bash
chmod 600 .env
```

Guarde uma cópia do `.env` num cofre de senhas: sem o `DATA_KEY`, os segredos de 2FA gravados no banco não
podem ser lidos. Opcional: `ANTHROPIC_API_KEY` liga a leitura de documentos por foto e o BI por pergunta livre.

## 4. Subir

**Com Cloudflare Tunnel neste servidor** (crie o túnel no passo 5A antes e cole o token em `TUNNEL_TOKEN`
no `.env`):

```bash
docker compose --profile tunel up -d --build
```

**Sem túnel** (o nginx/Caddy do servidor encaminha, passo 5B):

```bash
docker compose up -d --build
```

A primeira subida leva de 10 a 20 minutos (build das imagens). Acompanhe:

```bash
docker compose ps
```
```bash
docker compose logs -f api
```

Confira localmente no servidor:

```bash
curl http://127.0.0.1:8080/omnisaude/api/health
```

## 5. Ligar mm.api.br/omnisaude ao sistema

### 5A. Cloudflare Tunnel

No painel da Cloudflare: **Zero Trust → Networks → Tunnels** (os nomes dos menus mudam de tempos em tempos).

1. **Create a tunnel** → tipo **Cloudflared** → nome `omnisaude` → escolha **Docker** e copie o token (a
   sequência depois de `--token`) para `TUNNEL_TOKEN` no `.env`.
2. Em **Public Hostname** adicione:
   - Subdomain `mm`, Domain `api.br` (ou como o domínio aparecer na sua conta);
   - Path: `omnisaude.*`
   - Service: tipo `HTTP`, URL `gateway:8080`.
3. Rode `docker compose --profile tunel up -d`.

Se `mm.api.br` **já é atendido por outro túnel** (de outro serviço), não crie um segundo para o mesmo nome:
acrescente a regra acima no túnel existente, **antes** da regra que atende o resto de `mm.api.br`. Se esse
túnel roda em outra máquina, o `cloudflared` dele não alcança `gateway:8080`: nesse caso rode o OmniSaúde na
mesma máquina do túnel e use a URL `http://127.0.0.1:8080`.

### 5B. nginx que já atende mm.api.br

Dentro do bloco `server` de `mm.api.br`, acrescente (sem barra no fim de `location /omnisaude`):

```nginx
location /omnisaude {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    client_max_body_size 20m;
}
```

Depois:

```bash
nginx -t && systemctl reload nginx
```

Com Caddy no servidor, o equivalente é `handle /omnisaude* { reverse_proxy 127.0.0.1:8080 }` no site
`mm.api.br`.

## 6. Conferir

```bash
curl https://mm.api.br/omnisaude/api/health
```

Abra **https://mm.api.br/omnisaude** e entre com a instituição `demo`, a senha `OmniSaude2026` e, por
exemplo, o CPF `100.000.001-08` (recepção). Os demais perfis estão no `README.md`.

## Operação

Atualizar para a versão mais nova (as migrações rodam sozinhas na subida):

```bash
cd /opt/omnisaude && git pull && cd omnisaude/deploy/producao && docker compose up -d --build
```

Backup dos bancos (agende diariamente e copie para fora do servidor):

```bash
docker compose exec -T master-db pg_dump -U omni_app master_auth_db > master_$(date +%F).sql
```
```bash
docker compose exec -T tenant-db pg_dump -U postgres tenant_db_demo > tenant_demo_$(date +%F).sql
```

Parar tudo (os dados ficam nos volumes do Docker):

```bash
docker compose down
```

## O que fica de fora nesta publicação

- RNDS, CADSUS, SEFAZ e WhatsApp apontam para o serviço simulado (`mocks`): nada sai do servidor. Para as
  integrações reais, remova `MOCKS_URL` e configure as variáveis `RNDS_*`, `WHATSAPP_*` e `SEFAZ_URL`
  (credenciamento e certificados são pré-requisitos; veja `docs/STATUS.md`).
- Os documentos anexados ficam no volume `arquivos`; para o Cloudflare R2, preencha `R2_*` no `.env`.
- O app Android deve ser gerado com `NEXT_PUBLIC_API_URL=https://mm.api.br/omnisaude/api`
  (veja `apps/mobile/README.md`).
