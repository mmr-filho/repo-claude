# Sigilo

Aplicativo de mensagens entre celulares para quem quer uma conversa **como na rua ou no escritório: sem testemunhas e sem registros**.

- As mensagens são **cifradas de ponta a ponta** e só abrem depois que a pessoa **digita a senha**.
- **Se apagam depois de lidas.** O texto só existe na memória enquanto a conversa está aberta.
- **Não há servidor de contas.** Quem decide quem pertence a uma rede é o **administrador**, que assina certificados no aparelho dele. Cada celular confere as assinaturas sozinho.
- **Redes são isoladas.** Duas redes só conversam se os **dois administradores** concordarem. A conexão não passa para as redes de terceiros.
- O único servidor que sobra é um **relé anônimo**: guarda mensagens já cifradas, sem contas e sem saber quem escreve. Roda no **Cloudflare Workers** (sem VPS) ou em Node.
- **Destrava com a senha ou com a digital** (nos aparelhos que têm leitor biométrico). A digital é um atalho: a senha continua valendo.
- O app escolhe o meio de envio **mais privado disponível**: proximidade (Bluetooth), internet (relé) e SMS (só Android, só com permissão). Hoje **o relé está pronto**; Bluetooth e SMS ainda não (veja "O que falta").

> Nome de trabalho. Para trocar, procure por `sigilo` / `Sigilo` no projeto.

## Como funciona, em uma tela

1. O administrador **cria a rede** no app e **convida** pessoas: cada convite é um código (ou QR code) de uso único.
2. A pessoa **entra com o convite**, escolhe a senha e recebe do administrador o **certificado** que a identifica na rede (e a lista de colegas, também assinada).
3. Para conversar, o app cifra a mensagem para o destinatário e a deposita na **caixa postal dele** no relé.
4. O destinatário, com o app aberto, **digita a senha**, lê, e a mensagem é **apagada da caixa postal**. Quem enviou vê "🔥 Lida e apagada".
5. Para conectar duas redes, um administrador pede (com o código da outra rede) e o outro **aceita**. As duas assinaturas formam o vínculo.

Detalhes, protocolo e modelo de ameaças em [`docs/ARQUITETURA-V2.md`](docs/ARQUITETURA-V2.md).

## Estrutura

```
apps/mobile       App Expo / React Native (Android e iOS), protocolo v2
packages/core     Criptografia, certificados, mensagens, nó local. `src/v2/` é o protocolo atual; `src/` (v1) é o legado
packages/relay    Relé anônimo: Cloudflare Workers (Durable Objects) ou Node + SQLite
packages/server   LEGADO: servidor v1 com contas (o app não usa mais; mantido com seus testes)
e2e               Teste de interface de ponta a ponta no navegador
docs              Arquitetura, implantação
deploy            Docker Compose do servidor v1 (legado)
```

## Como rodar

Requisitos: **Node 22.13 ou superior** e, para o app, o **Expo Go** (SDK 58) no celular.

```bash
npm install
```

### 1. O relé

**Para testar na sua rede (Node, porta 3100):**

```bash
npm run dev -w @sigilo/relay
```

**Para uso real, no Cloudflare Workers:** veja [`docs/IMPLANTACAO.md`](docs/IMPLANTACAO.md) (`npx wrangler login` e `npm run deploy -w @sigilo/relay`).

### 2. O app

O endereço do relé **não é pedido no cadastro**: fica dentro do app, em [`apps/mobile/src/config.ts`](apps/mobile/src/config.ts) (`BUILT_IN_RELAY_URL`), e pode ser trocado ao gerar o app com `EXPO_PUBLIC_RELAY_URL`. Quem **entra com convite** usa o relé que vem dentro do convite, então só o administrador, ao criar a rede, depende dessa configuração. **Enquanto nenhum endereço estiver configurado, "Criar uma rede" fica desabilitado.**

Em outro terminal, aponte para o relé que o celular alcança. Para teste na mesma rede Wi-Fi use o IP do computador:

```bash
EXPO_PUBLIC_RELAY_URL=http://192.168.0.10:3100 npm run mobile
```

No Expo Go, toque em **Criar uma rede**, informe seu nome, o nome da rede e uma senha (mínimo de 6 caracteres; o app avisa quando ela é curta ou só de números). A caixa **"Destravar com a digital"** vem marcada nos aparelhos que têm leitor, e dá para ligar e desligar depois em **Ajustes**. Na aba **Rede → Convites**, gere um convite para outra pessoa. Para testar a conversa você precisa de **um segundo aparelho** (ou um emulador): nele, toque em **Entrar com convite**, cole o código (ou leia o QR code) e escolha a senha. A aprovação chega sozinha enquanto o app da administradora está aberto.

> O app exige **HTTPS** para o relé, exceto em endereços de rede local (para testes).

### Compilar e rodar no Android (sem Expo Go)

**Requisitos:** [Android Studio](https://developer.android.com/studio) (traz o SDK e o emulador), **JDK 17 ou mais novo** (o Gradle 9 exige) e `ANDROID_HOME` apontando para o SDK. No celular, ative **Depuração USB**; ou crie um emulador.

```bash
# com o relé rodando e o aparelho/emulador conectado (confira com: adb devices)
EXPO_PUBLIC_RELAY_URL=http://192.168.0.10:3100 npm run android
```

A primeira compilação leva vários minutos. No emulador Android o computador é `http://10.0.2.2:3100`. O build de **debug** aceita HTTP na rede local; um **release** só conversa com relé **HTTPS**.

### Gerar o APK (arquivo para instalar)

O endereço do relé **é gravado dentro do app na hora da geração** (pela variável `EXPO_PUBLIC_RELAY_URL` ou por `BUILT_IN_RELAY_URL` em `apps/mobile/src/config.ts`); para trocar, gere de novo.

**Opção A: na sua máquina**

```bash
cd apps/mobile
npx expo prebuild --platform android --clean
cd android
EXPO_PUBLIC_RELAY_URL=https://relay.suaorganizacao.com ./gradlew assembleRelease     # Windows: gradlew.bat assembleRelease
```

O arquivo sai em `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`. A variável precisa estar no mesmo comando do Gradle.

**Opção B: na nuvem do Expo (EAS Build)**, sem Android Studio (conta gratuita em expo.dev):

```bash
npm install -g eas-cli && eas login
cd apps/mobile
eas build --platform android --profile preview     # APK para instalar
eas build --platform android --profile production  # .aab para a Google Play
```

Defina `"env": { "EXPO_PUBLIC_RELAY_URL": "https://..." }` no perfil em `apps/mobile/eas.json`.

**HTTP x HTTPS.** Um APK de release só aceita relé **HTTPS**. Para um APK de **teste** com relé HTTP na sua rede, gere com `SIGILO_ALLOW_CLEARTEXT=1` e use-o só para teste.

**Antes de distribuir:** troque o pacote `com.example.sigilo` (`apps/mobile/app.json`) e assine com sua própria chave (o release da Opção A usa a de **debug**). O backup automático do Android já está desligado.

## Testes

```bash
npm test                                 # núcleo (37), relé e nó de ponta a ponta (41), servidor v1 legado (41)
npm run typecheck                        # todos os pacotes
npm run test:e2e                         # abre o app no Chromium contra um relé real e usa a interface
npm run test:worker -w @sigilo/relay     # roda o relé no workerd (runtime da Cloudflare) e a suíte contra ele
```

Os testes do relé e do nó usam vários aparelhos simulados com a criptografia de verdade. Verificam, por exemplo: o texto nunca aparece no relé; a mensagem lida some; redes sem vínculo não se enxergam (mesmo com vazamento do endereço de uma caixa); desvincular, revogar e vencer certificados; envio por mais de um meio; trancar no meio de uma consulta sem perder a entrada na rede.

`npm run test:e2e` precisa de um Chromium (`CHROMIUM_PATH=/caminho/do/chromium`, ou `npx playwright-core install chromium`) e salva capturas de tela de cada etapa.

## O que falta, e o que não foi verificado

Leia antes de usar com dados reais:

- **Não rodei o app em celular nem emulador.** Verifiquei que compila para Android e iOS, passa no typecheck e funciona de ponta a ponta no navegador. Não foram testados em aparelho: Keychain/Keystore, a **digital** (no teste do navegador o leitor é simulado; a guarda da chave pelo hardware e a janela de biometria do sistema só aparecem num aparelho real), a **leitura de QR code pela câmera**, bloqueio de captura de tela, tela de privacidade, bloqueio ao ir para segundo plano e o botão "voltar" do Android.
- **Bluetooth (proximidade) e SMS não estão implementados.** O núcleo já escolhe o meio pela privacidade e exige permissão para o SMS, mas os módulos nativos ainda não foram escritos. Hoje todo envio vai pelo relé.
- **Desbloquear leva alguns segundos.** A derivação da senha roda em JavaScript e é paga a cada desbloqueio. No interpretador Hermes medi ~3 s numa CPU de servidor; celulares intermediários devem ser mais lentos (não medi em aparelho).
- **Sem notificação push**, por decisão de privacidade: o app consulta o relé enquanto está aberto (padrão: a cada 10 s; 3 s com a conversa aberta). Fechado, nada chega. No Workers, cada consulta conta nos limites do plano: veja `docs/IMPLANTACAO.md`.
- **Quem perde a senha ou o aparelho perde a identidade** (não há recuperação). O administrador emite um convite novo.
- **A chave da rede existe só no aparelho do administrador.** Perdê-la é perder a rede. Ainda não há backup nem mais de um administrador com poder de assinar.
- **Revogar** vale na hora para quem receber o aviso e, para todos, em até 30 dias (a validade dos certificados). Quem passa mais de 30 dias sem abrir o app precisa de um convite novo.
- **Metadados:** o relé vê IP, horário e tamanho aproximado dos acessos; a Cloudflare, quando hospeda o relé, também.
- **Só texto, só conversas 1 a 1.** Sem grupos, imagens ou arquivos.
- **Senha curta é fraca.** O mínimo é 6 caracteres e o app só avisa (não impede) quando a senha é só de números ou tem menos de 10 caracteres. Quem consegue **copiar o cofre** do aparelho (celular roubado e desbloqueado à força, malware, backup) pode testar senhas offline, e o scrypt só encarece cada tentativa. Em contas medidas aqui (8 núcleos de CPU, ~37 ms por tentativa): **6 dígitos numéricos caem em cerca de 77 minutos; 6 caracteres entre letras e números, em anos**. Prefira letras e números, ou uma frase. Veja `docs/ARQUITETURA-V2.md`, seção 2.
- **A digital não substitui a senha.** O cofre é aberto por uma chave guardada no Keychain/Keystore e liberada só pela biometria; se as digitais cadastradas no aparelho mudarem, essa chave se invalida e o app pede a senha de novo. Quem tem acesso à digital do dono, com o aparelho na mão, abre o app (como em qualquer app com biometria).

## Servidor v1 (legado)

O servidor com contas (`packages/server`, guia em `docs/IMPLANTACAO.md`, com Docker e Cloudflare Tunnel) foi a primeira versão. **O app não se conecta mais a ele.** Foi mantido, com seus 41 testes, enquanto o v2 amadurece, e pode ser removido depois. Sua arquitetura está em [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).
