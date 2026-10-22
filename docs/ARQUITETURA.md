# Arquitetura do Sigilo

Este documento descreve como o sistema funciona por dentro, o protocolo de criptografia, o que ele protege (e o que não protege) e as decisões que valem ser revistas.

## 1. Visão geral

```
┌─────────────── Celular (Expo / React Native) ───────────────┐        ┌────────── Servidor ──────────┐
│  Telas  ──▶  SigiloSession (@sigilo/core)                    │  HTTPS │  Fastify + SQLite            │
│               • deriva chaves da senha (scrypt)              │ ◀────▶ │  • contas, redes, vínculos   │
│               • cifra / decifra mensagens (X25519+XChaCha20) │   WS   │  • só texto cifrado          │
│               • chave privada só na memória, e só destrancada│        │  • avisos em tempo real      │
│  Armazenamento seguro: token, cofre local, chaves de contatos│        │  • apaga a mensagem ao ler   │
└──────────────────────────────────────────────────────────────┘        └──────────────────────────────┘
```

- **O servidor é "burro" quanto ao conteúdo:** guarda envelopes cifrados e metadados (quem, para quem, quando). Não tem como lê-los.
- **O aparelho faz toda a criptografia.** O pacote `@sigilo/core` é o mesmo no app e nos testes, então o que os testes provam vale para o app.
- **Nada de texto de mensagem vai para disco.** Mensagens recebidas existem só na memória da tela de conversa.

## 2. Redes, papéis e isolamento

- **Rede:** um grupo de pessoas administrado por um ou mais administradores. Tem um **código** público (`slug`, ex.: `unirg`).
- **Usuário:** `nome@rede`. Papéis: `admin` e `member`.
- **Quem cria o quê**
  - O operador do servidor cria a rede e seu primeiro administrador pela CLI (`create-network`).
  - Um administrador cadastra, desativa, reativa e "zera" (esqueci a senha) membros **da própria rede**, e nunca de outra (404).
- **Regra de ouro, aplicada no servidor em um só lugar (`canMessage`):** dois usuários só trocam mensagens se estiverem **na mesma rede** ou em **redes com vínculo ativo direto**. Também é a regra do diretório de contatos.
- **Vínculos entre redes** (`network_links`):
  - *Pedido:* o admin de A informa o código de B → vínculo `pendente`; o admin de B aceita ou recusa; A pode cancelar.
  - *Convite:* o admin de A gera um código de uso único (guardado só como hash); o admin de B o aceita → vínculo `ativo`.
  - Os dois lados precisam decidir: quem pediu/convidou nunca aceita por si.
  - Qualquer lado pode **desconectar**; as mensagens pendentes entre as duas redes são apagadas.
  - **Não é transitivo.** Existe no máximo um vínculo aberto por par de redes (índice único parcial no banco).
- **Anti-enumeração:** para quem não pode falar com o destino, `POST /messages` responde 404, igual a "não existe".

## 3. Contas e ativação

1. O admin cria o membro (`status = pending`) e recebe um **código de ativação** (80 bits, `XXXX-XXXX-XXXX-XXXX`, válido por 72 h, uso único, guardado como hash). Ele entrega à pessoa fora do sistema.
2. No app, a pessoa informa servidor, `usuario@rede`, o código e **escolhe a senha**. O aparelho gera o par de chaves, embrulha a chave privada com a senha e envia ao servidor só: chave pública, chave privada **cifrada**, sal/parâmetros do KDF e uma prova de senha.
3. Após 5 códigos errados, o código é invalidado e o admin precisa emitir outro.
4. **Esqueci a senha:** o admin gera novo código → a conta volta a `pending`, chaves e sessões são apagadas, mensagens pendentes dessa pessoa são apagadas. Os contatos, ao verem a chave nova, recebem um **aviso de troca de chave** (seção 4.5).

## 4. Criptografia

Bibliotecas: `@noble/curves`, `@noble/hashes`, `@noble/ciphers` (JavaScript puro, auditadas). Aleatoriedade vem do sistema operacional (`expo-crypto`).

### 4.1 Da senha às chaves

```
senha ──NFKC──▶ scrypt(sal 16 B, N, r=8, p=1) ──▶ MK (32 B)
                                                     ├─ HKDF("sigilo/v1/kek")  ──▶ KEK        (nunca sai do aparelho)
                                                     └─ HKDF("sigilo/v1/auth") ──▶ authSecret (vai ao servidor)
```

- O servidor recebe só o `authSecret` e o guarda com um segundo hash (scrypt com sal próprio). Dele **não se deriva** a KEK.
- O sal e os parâmetros do scrypt ficam no servidor (`POST /auth/prelogin`). Para contas inexistentes o servidor devolve um sal falso, estável (HMAC com segredo do servidor), para não revelar quem existe.
- O app **recusa parâmetros fracos** vindos do servidor (N < 2¹⁴ ou N > 2²⁰), evitando rebaixamento por um servidor malicioso.

### 4.2 Chave de identidade

Par **X25519** gerado no aparelho. A chave privada é cifrada com a KEK (XChaCha20-Poly1305, dados autenticados = chave pública) e o envelope fica no servidor. Isso permite entrar em outro aparelho só com usuário e senha. Quem obtém o envelope do servidor ainda precisa da senha.

### 4.3 Mensagem (ECIES autenticado, estilo Noise "X")

Para cada mensagem, o remetente gera um par X25519 **efêmero** e calcula:

```
dh1 = X25519(efêmera_sk, destinatário_pk)
dh2 = X25519(remetente_sk, destinatário_pk)           ← autentica o remetente
chave = HKDF-SHA256( dh1 ‖ dh2, sal = epk ‖ remetente_pk ‖ destinatário_pk, info = "sigilo/v1/msg/<papel>" )
envelope = XChaCha20-Poly1305( chave, nonce 24 B, dados autenticados = "papel | idMensagem | idRemetente | idDestinatário",
                               texto preenchido em blocos de 128 B )
```

Consequências (todas cobertas por testes):

- Só o destinatário abre; um terceiro, o servidor ou o próprio remetente "do futuro" (a efêmera é descartada) não abrem.
- **Autenticidade:** quem não tem a chave privada do remetente não consegue forjar mensagem "dele" (`dh2`).
- **Ligação ao contexto:** trocar id da mensagem, remetente ou destinatário invalida a cifra. O servidor não consegue redirecionar ou reetiquetar.
- Qualquer bit alterado é detectado. Mensagem inválida **não é apagada** automaticamente; o usuário vê "não pôde ser aberta" e decide descartar.
- **Tamanho:** o texto é preenchido em blocos de 128 bytes; o servidor vê só faixas de tamanho. Limite de 8 KB de texto.
- **Cópia do remetente:** cada mensagem tem um segundo envelope, cifrado para o **próprio remetente** (papel `sender`). Serve para o remetente reler o que enviou enquanto não foi lido, e para "apagar para todos". É apagado junto com o primeiro.

### 4.4 Cofre local (desbloqueio rápido)

Veja a seção 6. O cofre local é um segundo embrulho da chave privada, guardado no Keychain/Keystore, protegido pela mesma senha com scrypt de custo menor (N = 2¹²).

### 4.5 Verificação de chaves (confiança no primeiro uso)

O servidor entrega a chave pública de cada contato. Um servidor malicioso poderia entregar a chave dele no lugar. Defesas:

- O app **fixa** a chave de cada contato na primeira vez que a vê. Se mudar, bloqueia o envio e a leitura e mostra o **aviso de troca de chave** com o **número de segurança**; só continua se o usuário confirmar.
- **Número de segurança:** 12 grupos de 5 dígitos, iguais nos dois lados, derivados das duas chaves públicas. Se os dois compararem (pessoalmente/telefone) e baterem, não há interceptação. Botão "Verificar" na conversa.

## 5. Ciclo de vida da mensagem

```
Ana (aparelho)                    Servidor                         Bruno (aparelho)
  cifra para Bruno e para Ana ─▶ guarda 2 envelopes ──aviso WS──▶  "🔒 1 mensagem nova"  (sem texto)
                                                                    cofre trancado: só o contador
                                                                    Bruno digita a senha
                                 ◀── GET inbox ─────────────────── baixa e DECIFRA na memória
                                 ◀── POST /messages/read ───────── confirma leitura
                                 apaga a linha (secure_delete) ──▶ aviso "lida" ─▶ Ana: "🔥 Lida e apagada"
                                                                    ao sair da conversa, o texto some da memória
```

- **Lida = decifrada e entregue à tela.** A confirmação apaga as duas cópias no servidor.
- Se a rede cair antes da confirmação, a mensagem continua lá e aparece de novo (entrega "ao menos uma vez").
- **Mensagens não lidas expiram** (padrão 7 dias, `MESSAGE_TTL_HOURS`).
- O remetente pode **apagar para todos** enquanto não foi lida.
- Limites: 500 mensagens pendentes por par de contas e 60 envios/minuto por usuário.
- O banco usa `secure_delete`, mas o apagamento não é "forense": arquivos WAL e SSDs com nivelamento de desgaste podem guardar restos cifrados por algum tempo (e, mesmo assim, são só texto cifrado).

## 6. Bloqueio e cofre local

- Ao abrir o app, a sessão é retomada com o token, mas o **cofre está trancado**: a chave privada não está na memória. A tela só mostra quantas mensagens esperam (`GET /messages/summary` devolve apenas contadores).
- **Tranca** automaticamente: ao ir para segundo plano (configurável: imediato, 30 s, 1 min, 5 min), por inatividade (padrão 5 min, a digitação conta) e manualmente. Ao trancar, a chave é zerada na memória e a conexão em tempo real é encerrada.
- **Tela de privacidade:** o conteúdo é coberto quando o app não está ativo, para não aparecer no seletor de apps.
- **Bloqueio de captura de tela** na conversa (`expo-screen-capture`).

### Custo do KDF no celular (medição)

O scrypt roda em JavaScript puro (Hermes não tem JIT). Medi com o interpretador Hermes 0.12 numa CPU de servidor:

| N (r=8, p=1) | Hermes (interpretador) | Node (JIT) |
|---|---|---|
| 2¹² | 0,76 s | — |
| 2¹³ | 1,5 s | — |
| 2¹⁴ | 3,0 s | ~0,1 s |
| 2¹⁵ | 6,0 s | ~0,2 s |

Celulares intermediários costumam ser 2 a 4 vezes mais lentos que isso; **não medi em aparelho**. Por isso:

- **Envelope forte (servidor)**: N = 2¹⁴ por padrão, pago só no login, ativação e troca de senha. Ajustável por servidor (`KDF_N`) e gravado por conta.
- **Cofre local**: N = 2¹², usado nos desbloqueios do dia a dia. Fica no Keychain/Keystore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY` no iOS). A senha continua obrigatória; muda só o custo. Quem rouba o aparelho e extrai o cofre local tem, de qualquer modo, o token, que lhe dá o envelope do servidor (custo 2¹⁴, apenas 4 vezes maior).
- Senha errada no desbloqueio é recusada **rápido** (caminho local), sem esperar o KDF forte.
- O scrypt é **plugável** (`SessionOptions.scrypt`): em produção vale usar uma implementação nativa (por exemplo `react-native-quick-crypto`, que exige build próprio em vez do Expo Go) e então elevar `KDF_N`. O protocolo não muda.
- N = 2¹⁴ é o mínimo aceitável para esse algoritmo; **prefira senhas longas**.

## 7. Modelo de dados (SQLite)

| Tabela | Conteúdo |
|---|---|
| `networks` | `slug` (único), nome |
| `users` | rede, `username`, `handle` (único), papel, status (`pending/active/disabled`), hash do código de ativação, sal e hash da prova de senha, sal/parâmetros do KDF, chave pública, **chave privada cifrada**, contadores de bloqueio |
| `sessions` | hash do token (o token em si nunca é guardado), usuário, validade |
| `network_links` | par de redes ordenado, quem pediu, status (`pending/active/rejected/cancelled/revoked`), índice único parcial para vínculos abertos |
| `link_invites` | hash do código, rede emissora, validade, usado |
| `messages` | remetente, destinatário, **dois envelopes cifrados**, criação, expiração. A linha existe só até a leitura |

## 8. API

Corpo e respostas em JSON. Erros: `{ "error": "<código>", "message": "<texto>" }`. Autenticação: `Authorization: Bearer <token>`.

| Rota | O que faz |
|---|---|
| `GET /server-info`, `GET /health` | Parâmetros recomendados de KDF; verificação de vida |
| `POST /auth/prelogin` · `/auth/activate` · `/auth/login` · `/auth/logout` · `/auth/change-password` | Entrada e senha. Limite de requisições por IP e bloqueio por tentativas |
| `GET /me` | Sessão, chave pública, envelope cifrado e parâmetros do KDF |
| `GET /contacts` · `GET /contacts/:id` | Diretório: minha rede + redes com vínculo ativo |
| `POST /messages` · `GET /messages/inbox` · `/outbox` · `/summary` · `POST /messages/read` · `DELETE /messages/:id` | Enviar, ler envelopes, contadores, confirmar leitura (apaga), apagar para todos |
| `GET/POST /admin/members`, `…/:id/reset-activation`, `…/:id/disable`, `…/:id/enable` | Gestão de membros da própria rede |
| `GET /admin/links`, `POST …/requests`, `…/:id/accept\|reject\|cancel\|revoke`, `…/invites`, `…/invites/accept` | Vínculos entre redes |
| `GET /ws` | WebSocket de **avisos** (`message.new`, `message.read`, `message.recalled`, `contacts.changed`, `session.revoked`). O token vai na primeira mensagem, não na URL |

## 9. Modelo de ameaças

**Protege contra**

- *Servidor ou banco vazado:* só há texto cifrado, envelopes de chave e hashes. Para ler, o atacante precisa quebrar a senha por força bruta (custo do scrypt) — e só obtém mensagens ainda **não lidas**.
- *Operador ou administrador curioso:* não tem como ler mensagens. Administradores só gerenciam contas e vínculos da própria rede.
- *Colega que pega o celular destrancado:* sem a senha, vê no máximo contadores. Mensagens lidas não ficam no aparelho nem no servidor.
- *Mensagem forjada, redirecionada ou alterada* (inclusive pelo servidor): detectada e recusada.
- *Vazamento entre redes:* o isolamento é verificado no servidor em toda operação de mensagem e de contato.
- *Adivinhação de senha online:* limite por IP, bloqueio temporário da conta e código de ativação que se invalida.

**Não protege contra (ou só parcialmente)**

- *Servidor malicioso na primeira conversa:* pode entregar chave falsa. Mitigação: fixação de chave + número de segurança, **que depende de o usuário conferir**.
- *Administrador malicioso:* pode "zerar" uma conta e reativá-la para se passar pela pessoa. Os contatos recebem o aviso de troca de chave; sem conferência, o aviso pode ser ignorado.
- *Aparelho comprometido* (malware, root/jailbreak), ou alguém **olhando a tela** ou fotografando-a enquanto a conversa está aberta.
- *Senha fraca.* O app exige 10 caracteres, mas não mede qualidade.
- *Metadados:* o servidor sabe quem conversa com quem, quando e o tamanho aproximado.
- *Sigilo futuro completo:* não há "double ratchet" como no Signal. A chave efêmera protege contra vazamento da chave do remetente, mas a chave de identidade do destinatário abre todas as mensagens destinadas a ele que ainda estejam no servidor. A mitigação é apagar na leitura.
- *Negação de serviço* além dos limites básicos.

## 10. Decisões e alternativas

| Decisão | Por quê | Alternativa |
|---|---|---|
| Senha **do usuário** gera a chave (não senha por mensagem) | Uma senha só, familiar; o servidor nunca a vê | Senha por mensagem/conversa combinada entre as pessoas |
| Leitura = servidor apaga; nada de histórico local | Cumpre "apaga depois de lido" sem rastro no aparelho | Cache local cifrado (permite ler offline, deixa dados no aparelho) |
| Envelope para o remetente também | Remetente relê e recolhe enquanto não foi lido, sem guardar texto em disco | Remetente só vê "enviada" |
| 1 a 1 apenas | Mantém o protocolo simples e verificável | Grupos (chaves de grupo e reentrada de membros) |
| SQLite (`node:sqlite`) | Zero dependência nativa, simples de operar | PostgreSQL para escala e alta disponibilidade |
| WebSocket só para avisos | O servidor nunca empurra texto; o app busca e decifra | Empurrar o envelope pelo WebSocket |
| scrypt em JS + cofre local | Funciona no Expo Go e é usável em Hermes | KDF nativo + custo maior |
| Aceite **dos dois lados** em toda conexão | Pedido pede aceite do alvo; convite exige que o outro admin o aceite | Convite com vínculo imediato |

## 11. Próximos passos recomendados

1. **Testar em aparelhos reais** (Android e iOS): desempenho do KDF, Keychain/Keystore, bloqueio de captura de tela, comportamento em segundo plano.
2. **Notificações push sem conteúdo** ("Você tem uma nova mensagem"); hoje avisos só chegam com o app aberto.
3. **KDF nativo** e elevação de `KDF_N`.
4. Biometria como atalho de desbloqueio (opcional, sem substituir a senha).
5. Grupos, anexos cifrados e política por rede (por exemplo, lista de quem pode ser visto por redes conectadas).
6. Painel web para administradores e auditoria de ações administrativas.
7. PostgreSQL, observabilidade e Dockerfile para implantação.
