# Sigilo

Aplicativo de mensagens entre celulares, parecido com o WhatsApp, em que:

- as mensagens são **criptografadas de ponta a ponta** e só abrem depois que o usuário **digita a senha**;
- as mensagens **se apagam depois de lidas**;
- cada usuário tem uma **conta criada por um administrador**, que também administra uma **rede de comunicação**;
- **redes são isoladas** entre si. Duas redes só conversam se houver uma conexão, feita por **pedido** ou por **convite** e **aceita pelo administrador da outra rede**.

> Nome de trabalho. Para trocar, procure por `sigilo` / `Sigilo` no projeto.

## Como cada requisito foi atendido

| Requisito | Como funciona |
|---|---|
| Criptografia até digitar a senha | A senha gera, no aparelho, a chave que protege a chave privada do usuário. O servidor guarda só texto cifrado e nunca vê a senha, a chave nem as mensagens. Ao abrir o app (ou ao trancar), o cofre fica fechado e a lista mostra só *quantas* mensagens esperam. |
| Apagar depois de lidas | Ao exibir a conversa, o app confirma a leitura e o servidor **apaga o texto cifrado**. O texto só existe na memória da tela e some ao sair da conversa. A mensagem enviada some da tela de quem enviou assim que o outro lê. |
| Conta criada por administrador | Não existe cadastro público. O administrador cria o membro e recebe um **código de ativação** de uso único, que entrega à pessoa. Ela o usa para escolher a própria senha. |
| Rede criada por administrador | O operador do servidor cria a rede e o primeiro administrador por linha de comando (`npm run network:create`). Esse administrador cadastra os demais membros. |
| Redes isoladas | O servidor só deixa conversar quem está na mesma rede ou em redes com conexão ativa. Para quem está fora, o destinatário nem "existe" (resposta 404). A conexão **não é transitiva**: A–B e B–C não ligam A a C. |
| Conexão por pedido ou convite | **Pedido:** o administrador da rede A informa o código da rede B; o administrador de B aceita ou recusa. **Convite:** A gera um código de uso único e entrega ao administrador de B, que o aceita no app. Qualquer lado pode desconectar depois. |

## Estrutura

```
packages/core     Criptografia, protocolo e cliente da API (TypeScript puro; usado pelo app e pelos testes)
packages/server   Servidor: API REST + WebSocket de avisos + SQLite
apps/mobile       App Expo / React Native (Android e iOS)
e2e               Teste de interface de ponta a ponta no navegador
docs              Arquitetura, protocolo e modelo de ameaças
```

## Como rodar

Requisitos: **Node 22.13 ou superior** e, para o app, o **Expo Go** (SDK 58) no celular.

```bash
npm install
```

### 1. Servidor

Crie a primeira rede e seu administrador (o código de ativação aparece uma única vez):

```bash
npm run network:create -- --slug unirg --name "UniRG" --admin maria --admin-name "Maria Silva"
```

Suba o servidor (porta 3000; banco em `packages/server/data/sigilo.db`, ignorado pelo git):

```bash
npm run dev:server
```

### 2. App

Em outro terminal, aponte para o endereço do servidor que o celular alcança. Para teste na mesma rede Wi-Fi use o IP do computador:

```bash
EXPO_PUBLIC_SERVER_URL=http://192.168.0.10:3000 npm run mobile
```

Abra o app no Expo Go, toque em **Ativar conta**, informe `maria@unirg`, o código recebido e escolha uma senha (mínimo de 10 caracteres). Depois, na aba **Rede**, cadastre os outros membros e conecte outras redes.

> O app exige **HTTPS**, exceto para endereços de rede local (para testes). Em produção coloque o servidor atrás de um proxy com TLS (Caddy, nginx, etc.) e defina `TRUST_PROXY=true`.

### Compilar e rodar no Android (sem Expo Go)

O Expo Go é o caminho mais rápido, mas você também pode compilar o app nativo e instalá-lo no celular ou no emulador.

**Requisitos:** [Android Studio](https://developer.android.com/studio) (traz o SDK e o emulador), **JDK 17 ou mais novo** (o Gradle 9 exige) e a variável `ANDROID_HOME` apontando para o SDK (`~/Android/Sdk` no Linux, `~/Library/Android/sdk` no Mac, `%LOCALAPPDATA%\Android\Sdk` no Windows). No celular, ative **Opções do desenvolvedor → Depuração USB**; ou crie um emulador no Android Studio.

```bash
# com o servidor já rodando (passo 1) e o aparelho/emulador conectado (confira com: adb devices)
EXPO_PUBLIC_SERVER_URL=http://192.168.0.10:3000 npm run android
```

A primeira compilação baixa dependências e leva vários minutos. O comando gera a pasta `apps/mobile/android` (não versionada), compila, instala e abre o app. No emulador Android o servidor do seu computador é `http://10.0.2.2:3000`.

- **Build de debug** (o padrão acima) aceita HTTP na rede local. Um **release** (`npm run android -w @sigilo/mobile -- --variant release`) bloqueia HTTP puro e só conversa com servidor **HTTPS**.
- O pacote se chama `com.example.sigilo` e o release usa a chave de **debug**. Troque os dois antes de publicar.
- O backup automático do Android está desligado (`allowBackup=false`) para que dados do app não saiam do aparelho.

### Usuários e redes

O usuário é identificado por `nome@rede` (por exemplo `maria@unirg`). O **código da rede** (`unirg`) é público: é o que outra rede usa para pedir conexão, e a conexão só vale depois que o administrador aceitar.

Esqueceu a senha? O administrador da rede gera um novo código de ativação. Isso **zera a conta**: a pessoa escolhe nova senha e perde as mensagens que estavam pendentes (ninguém mais consegue abri-las). Se quem esqueceu foi o único administrador, o operador do servidor emite o código pela linha de comando:

```bash
cd packages/server && node --import tsx src/cli.ts reset-activation maria@unirg
```

## Testes

```bash
npm test              # 55 testes: criptografia (14) e servidor com clientes reais (41)
npm run typecheck     # todos os pacotes
npm run test:e2e      # abre o app no Chromium contra um servidor real e usa a interface
```

Os testes do servidor sobem o servidor de verdade, usam o mesmo código de criptografia do app e verificam, por exemplo, que o texto nunca aparece no banco, que a mensagem lida some, que redes sem conexão não se enxergam e que o administrador de uma rede não mexe em outra.

`npm run test:e2e` precisa de um Chromium (`CHROMIUM_PATH=/caminho/do/chromium`, ou `npx playwright-core install chromium`). Ele salva capturas de tela de cada etapa.

## Configuração do servidor

Variáveis de ambiente (todas opcionais; veja `packages/server/.env.example`): `PORT`, `DB_PATH`, `MESSAGE_TTL_HOURS` (mensagens **não lidas** expiram), `SESSION_TTL_DAYS`, `ACTIVATION_TTL_HOURS`, `INVITE_TTL_HOURS`, `KDF_N`, `MAX_LOGIN_FAILURES`, `LOCK_MINUTES`, `TRUST_PROXY`.

Para produção: `npm run build -w @sigilo/server` e `node packages/server/dist/index.js`.

## O que **não** foi verificado, e limitações

Leia antes de usar com dados reais:

- **Não rodei o app em celular nem emulador.** Verifiquei que o app compila para Android e iOS (bundle do Metro/Hermes), passa no typecheck e funciona de ponta a ponta no navegador (teste `e2e`). Não foram testados em aparelho: Keychain/Keystore, bloqueio de captura de tela, tela de privacidade no seletor de apps, bloqueio ao ir para segundo plano e o botão "voltar" do Android.
- **Velocidade da senha no celular.** A derivação de chave (scrypt) roda em JavaScript. Medi no interpretador Hermes de um servidor: ~3 s com o custo padrão. Celulares intermediários devem ser mais lentos. O custo forte é pago só no login/ativação; o desbloqueio do dia a dia usa um cofre local mais leve. Detalhes e como trocar por uma versão nativa em `docs/ARQUITETURA.md`.
- **Sem notificações push.** Avisos em tempo real só chegam com o app aberto. Ao abrir, o app mostra quantas mensagens aguardam.
- **Só texto, só conversas 1 a 1.** Sem grupos, imagens, áudio ou arquivos.
- **Captura de tela:** o app pede ao sistema para bloqueá-la enquanto uma conversa está aberta, mas nada impede fotografar a tela com outro aparelho.
- O servidor enxerga **metadados**: quem fala com quem, quando e o tamanho aproximado (as mensagens são preenchidas em blocos de 128 bytes).
- Banco SQLite (`node:sqlite`, experimental no Node 22) em um único servidor. Para muitos usuários, troque por PostgreSQL.
- A força da senha só é verificada no aparelho (o servidor nunca a vê). O app exige 10 caracteres, mas não mede entropia.

Roadmap sugerido: notificações push sem conteúdo, KDF nativo, grupos, anexos cifrados, biometria como atalho de desbloqueio.

Mais detalhes: [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).
