# @omnisaude/accessibility

Acessibilidade em **Libras**: avatar do **VLibras** na tela do paciente e **teleatendimento com intérprete** (VRS) via WebRTC.

## VLibras

```ts
import { loadVLibrasWidget, prescriptionToLibrasContent, presentTextForLibras } from '@omnisaude/accessibility';

await loadVLibrasWidget({ position: 'BR' });          // idempotente: injeta a marcação oficial e o script uma vez
presentTextForLibras(painelPaciente, prescriptionToLibrasContent(itensDaReceita));
```

- `loadVLibrasWidget` injeta `div[vw] > div[vw-access-button] + div[vw-plugin-wrapper]`, carrega `https://vlibras.gov.br/app/vlibras-plugin.js` e chama `new VLibras.Widget('https://vlibras.gov.br/app')`. Em SPA a página já carregou, então o evento `load` é redisparado (contorno usual).
- `presentTextForLibras` publica receitas, orientações e bulas resumidas como parágrafos curtos numa região visível (`aria-live`), usando `textContent` (nunca interpreta HTML).
- `prescriptionToLibrasContent` reescreve a receita em frases curtas e linguagem simples ("Como usar: pela boca.").

**Limitações:** o widget oficial traduz **conteúdo exibido na página**: o paciente ativa o avatar e toca no texto. **Não há API oficial para traduzir texto sem mostrá-lo**, nem para disparar a tradução automaticamente. O widget depende de acesso a `vlibras.gov.br` (em rede bloqueada, hospede o VLibras localmente). A tradução automática não substitui intérprete humano em situações clínicas complexas: para isso existe a chamada abaixo.

## Teleatendimento em Libras (WebRTC)

- `signaling`: tipos das mensagens trocadas entre navegador e servidor (`call.request`, `call.assigned`, `call.incoming`, `rtc.offer/answer/ice`, `call.end`...) e `parseClientMessage()`, que valida e normaliza o que chega do navegador. A identidade de quem envia vem da sessão autenticada, nunca do corpo.
- `InterpreterCentral` (servidor, sem framework): fila de chamados (FIFO), disponibilidade dos intérpretes, pareamento com o intérprete livre há mais tempo, expiração (padrão 2 min), cancelamento só por quem abriu, desconexão, `canJoinRoom()` e `roomPeer()` para o gateway autorizar e retransmitir mensagens. Eventos: `queued`, `positions`, `assigned`, `cancelled`, `timeout`, `ended`.
- `LibrasCallClient` (navegador): `getUserMedia` com vídeo em boa resolução (Libras é visual), oferta/resposta, fila de candidatos ICE que chegam antes da descrição remota, `hangup()`. O intérprete é o `initiator` por convenção.

```ts
// gateway (NestJS): central.on('assigned', ({ request, call }) => { enviar(call.requesterId, { type: 'call.assigned', ... }); enviar(call.interpreterId, { type: 'call.incoming', ... }); });
// navegador:
const call = new LibrasCallClient({ channel, roomId, initiator: false, iceServers });
call.on('remoteStream', (s) => (video.srcObject = s));
await call.start();
```

**Limitações:** em redes de prefeitura com NAT restritivo é **obrigatório** um servidor TURN (o padrão traz só um STUN público). O estado da central fica em memória de um processo: com várias instâncias da API, use afinidade de sessão ou mova o estado para o Redis.
