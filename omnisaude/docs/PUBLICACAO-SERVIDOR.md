# Publicação num servidor próprio (alternativa)

> O caminho principal é a publicação 100% na Cloudflare, em [`PUBLICACAO.md`](PUBLICACAO.md). Este guia é
> para quem prefere uma máquina própria com Docker Compose.

O OmniSaúde roda com Docker numa máquina que responde pelo endereço `mm.api.br`. Na frente fica o Caddy,
que **emite e renova sozinho o certificado HTTPS** (Let's Encrypt) e encaminha:

```
navegador ──HTTPS──► mm.api.br (portas 80/443 da máquina) ──► Caddy
                                                              ├─ /omnisaude/api, /omnisaude/socket.io → API
                                                              └─ /omnisaude/*                        → web
```

Sem túnel: a internet precisa alcançar a máquina diretamente nas portas 80 e 443.

> **Atenção:** com `SEED_DEMO=true` (padrão) sobe o tenant de demonstração `demo`, com dados fictícios e a
> senha pública `OmniSaude2026` (que está no README). Qualquer pessoa com o endereço consegue entrar. Não
> cadastre pacientes reais nele. Para uso real ainda falta, entre outros pontos de `docs/STATUS.md`, a tela de
> cadastro de profissionais.

## Pré-requisitos (valem para qualquer máquina)

1. **IP público fixo** na máquina que vai servir o site.
2. **DNS:** um registro `A` de `mm.api.br` apontando para esse IP, no provedor de DNS do domínio. Se o DNS
   estiver na Cloudflare, deixe o registro em **"DNS only" (nuvem cinza)**, para o Caddy conseguir o
   certificado.
3. **Portas 80 e 443** livres na máquina (nenhum outro servidor web usando) e abertas no firewall.
4. Recomendado: 2 vCPU, 4 GB de RAM livres e 40 GB de disco.

Se a máquina **já tem um nginx/Apache atendendo `mm.api.br`**, veja "Modo atrás de um nginx" no fim.

---

## Opção A: servidor Linux (VPS), administrado do seu Windows

Abra o PowerShell no Windows e conecte ao servidor (Ubuntu 24.04):

```powershell
ssh root@IP_DO_SERVIDOR
```

A partir daqui os comandos rodam **no servidor**:

```bash
apt update && apt install -y git ufw openssl
```
```bash
curl -fsSL https://get.docker.com | sh
```
```bash
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443 && ufw --force enable
```
```bash
git clone https://github.com/mmr-filho/repo-claude.git /opt/omnisaude
```
```bash
cd /opt/omnisaude && git checkout claude/busy-cray-f9aqxw
```
```bash
cd /opt/omnisaude/omnisaude/deploy/producao && sh gerar-env.sh
```
```bash
docker compose up -d --build
```

---

## Opção B: o próprio computador Windows servindo o site

Antes, confira com o seu provedor de internet: **conexões residenciais costumam usar CGNAT** (IP
compartilhado), e aí as portas 80/443 nunca chegam ao seu computador. Nesse caso, use a opção A. O computador
também precisa ficar **sempre ligado e sem suspender**.

1. Instale o Docker Desktop (com WSL 2) e o Git, conforme as instruções anteriores, e abra o Docker Desktop
   até aparecer "Engine running".
2. No roteador, crie **redirecionamento de portas** (port forwarding) de 80 e 443 (TCP; 443 também UDP)
   para o IP local do computador (veja com `ipconfig`, em "Endereço IPv4"). Os menus variam por roteador.
3. Libere as portas no Firewall do Windows (PowerShell **como administrador**):
```powershell
New-NetFirewallRule -DisplayName "OmniSaude HTTP/HTTPS" -Direction Inbound -Protocol TCP -LocalPort 80,443 -Action Allow
```
4. Num PowerShell comum, entre na pasta do repositório (onde você já clonou) e atualize:
```powershell
cd repo-claude
```
```powershell
git pull
```
```powershell
cd omnisaude\deploy\producao
```
5. Gere o `.env` com senhas novas:
```powershell
powershell -ExecutionPolicy Bypass -File .\gerar-env.ps1
```
6. Suba:
```powershell
docker compose up -d --build
```

---

## Depois de subir (A ou B)

A primeira subida leva de 10 a 20 minutos (build das imagens). Acompanhe:

```bash
docker compose ps
```
```bash
docker compose logs -f gateway
```

No log do `gateway`, a linha `certificate obtained successfully` indica que o HTTPS está pronto. Se aparecer
erro de "challenge", o DNS ainda não aponta para a máquina ou a porta 80 não está chegando.

Confira:

```bash
curl https://mm.api.br/omnisaude/api/health
```

Abra **https://mm.api.br/omnisaude** e entre com a instituição `demo`, a senha `OmniSaude2026` e, por
exemplo, o CPF `100.000.001-08` (recepção). Os demais perfis estão no `README.md`.

A conta de operação da plataforma (`POST /omnisaude/api/platform/login`, que cria e suspende instituições)
usa o e-mail e a senha de `PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_PASSWORD` do `.env`, e não a senha pública
da demonstração.

**Guarde uma cópia do `.env`** num cofre de senhas: sem o `DATA_KEY`, os segredos de 2FA gravados no banco
ficam ilegíveis. Não gere o `.env` de novo depois da primeira subida (as senhas dos bancos já criados não
mudariam junto).

## Modo atrás de um nginx (quando ele já atende mm.api.br)

No `.env`, troque as quatro linhas do modo padrão por:

```
SITE_ADDRESS=:80
HTTP_PORT=127.0.0.1:8080
HTTPS_PORT=127.0.0.1:8443
TRUST_PROXY=2
```

E, no bloco `server` de `mm.api.br` do nginx (sem barra no fim de `location /omnisaude`):

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

Depois `docker compose up -d` e recarregue o nginx (`nginx -t && systemctl reload nginx`).

## Operação

Atualizar para a versão mais nova (as migrações rodam sozinhas na subida), na pasta `deploy/producao`:

```bash
git pull
```
```bash
docker compose up -d --build
```

Backup dos bancos (copie os arquivos para fora da máquina; os comandos funcionam no Linux e no PowerShell):

```bash
docker compose exec -T master-db pg_dump -U omni_app -Fc -f /tmp/master.dump master_auth_db
```
```bash
docker compose cp master-db:/tmp/master.dump ./master.dump
```
```bash
docker compose exec -T tenant-db pg_dump -U postgres -Fc -f /tmp/tenant_demo.dump tenant_db_demo
```
```bash
docker compose cp tenant-db:/tmp/tenant_demo.dump ./tenant_demo.dump
```

Parar tudo (os dados e os certificados ficam nos volumes do Docker):

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
