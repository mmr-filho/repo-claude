# OmniSaúde — app Android (smartphones e tablets)

O app empacota com [Capacitor 8](https://capacitorjs.com) a exportação estática do front-end (`apps/web`).
As telas são as mesmas da versão web; no aparelho elas usam os recursos nativos:

| Recurso | Plugin | Onde é usado |
| --- | --- | --- |
| Leitor de Datamatrix GS1, QR Code e código de barras (ML Kit) | `@capacitor-mlkit/barcode-scanning` | Beira-leito (pulseira e dose), farmácia (estoque, recebimento de transferências, devolução) |
| Câmera | `@capacitor/camera` | Recepção: foto do documento para OCR |
| Reconhecimento de voz (pt-BR) | `@capacitor-community/speech-recognition` | Ditado clínico (Speech-to-SOAP) e comandos de voz |
| Síntese de voz | `@capacitor-community/text-to-speech` | Resultado da administração beira-leito, chamadas e instruções |
| Localização (GPS) | API do WebView (`navigator.geolocation`) | Agente de saúde: posição do domicílio e da visita no mapa |

Sem o plugin (navegador), cada recurso cai para a API web equivalente: `BarcodeDetector` + câmera, upload de foto,
Web Speech API e `speechSynthesis`. Leitores de código USB/Bluetooth que "digitam" o código também funcionam.

## Pré-requisitos

- Node 22.12 ou mais novo e as dependências do monorepo instaladas (`npm install` na raiz `omnisaude/`).
- [Android Studio](https://developer.android.com/studio) com o Android SDK (API 36) e JDK 21.
- `ANDROID_HOME` apontando para o SDK (ou abra o projeto pelo Android Studio).

## Gerar o app

1. **Aponte para a API.** O endereço é embutido no build web e precisa ser **HTTPS** em produção:

   ```bash
   export NEXT_PUBLIC_API_URL=https://api.suaprefeitura.gov.br/api
   ```

   O servidor da API deve liberar no CORS as origens do app: `https://localhost` e `capacitor://localhost`
   (`CORS_ORIGINS`, já incluídas no padrão).

2. **Gere o front-end estático e sincronize com o projeto Android** (a partir de `omnisaude/`):

   ```bash
   npm run sync -w @omnisaude/mobile
   ```

   Isso roda `next build` com `OMNI_STATIC_EXPORT=1` (saída em `apps/web/out`) e `cap sync android`
   (copia os arquivos para `android/app/src/main/assets/public` e registra os plugins).

3. **Compile:**

   ```bash
   npm run apk -w @omnisaude/mobile          # APK de depuração: android/app/build/outputs/apk/debug/
   npm run open -w @omnisaude/mobile         # ou abra no Android Studio
   ```

   Para publicar, gere o AAB assinado (`npm run apk:release -w @omnisaude/mobile`) configurando a chave de
   assinatura no Android Studio (*Build → Generate Signed Bundle*). Não versione o keystore.

### Desenvolvimento com recarga automática

Com o `next dev` rodando no computador (porta 3000) e o aparelho na mesma rede:

```bash
CAP_SERVER_URL=http://192.168.0.10:3000 npx cap sync android
```

Volte ao normal rodando `npx cap sync android` sem a variável. Em modo de desenvolvimento o app aceita HTTP;
o build de produção, não.

## Permissões (AndroidManifest)

- `CAMERA`: leitura de códigos e foto de documentos.
- `RECORD_AUDIO`: ditado e comandos de voz.
- `VIBRATE`: confirmação tátil de aprovação/bloqueio na administração.
- `INTERNET`: comunicação com a API.
- `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`: posição dos domicílios e visitas (tela do ACS).

As permissões de câmera e microfone são pedidas no primeiro uso. O manifesto também declara a consulta ao
serviço de reconhecimento de voz do Android (exigido a partir do Android 11) e pede ao Google Play Services o
módulo do leitor de códigos (`barcode_ui`) na instalação.

## Layout

O front-end é responsivo: em **tablets** as telas de monitoramento (censo de leitos, filas, faturamento) usam
layout denso em grade; em **smartphones** as telas operacionais (beira-leito, recepção) usam botões grandes
(alvo mínimo de 44 px) e fluxo em etapas.

## Limitações conhecidas

- Só a tela **Agente de saúde** trabalha sem internet (fila no IndexedDB e sincronização ao voltar a rede); as demais dependem da API. Uma administração beira-leito sem conexão **não** é registrada (o app avisa).
- A sessão fica no armazenamento do WebView do app até o logout ou a expiração do token (12 h por padrão).
- O ícone e a tela de abertura são os padrões do Capacitor; substitua em `android/app/src/main/res/`.
