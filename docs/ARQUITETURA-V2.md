# Sigilo v2: sem servidor de contas

O v2 existe para atender a um objetivo: **uma conversa de celular como uma conversa na rua ou no escritório: sem testemunhas e sem registros.** Para chegar perto disso, ele troca o servidor que sabe quem é quem (v1) por três coisas:

1. **Certificados assinados pelo administrador**: ninguém precisa de um servidor para dizer quem pertence a uma rede.
2. **Um relé anônimo** que só carrega mensagens cifradas, sem contas e sem saber quem escreve.
3. **Vários meios de transporte**, escolhidos pela privacidade: proximidade (Bluetooth), relé pela internet e SMS.

> **Status.** Prontos e testados: criptografia, certificados, formato de mensagem, relé (Node e Cloudflare Workers), o nó local (`LocalNode`), a política de transportes e **a interface do app** (criar rede, convidar por código/QR, entrar, cofre, conversa, administração, ajustes), com teste de ponta a ponta no navegador. **Ainda não estão prontos:** os módulos nativos de SMS e de Bluetooth. A seção 8 lista o que falta e o que eu não consigo testar aqui.

## 1. Quem confia em quem

| Peça | Sabe | Não sabe |
|---|---|---|
| **Aparelho** | Suas chaves, seus contatos, o texto que você lê | — |
| **Administrador** | Quem convidou, certificados que emitiu | Mensagens de ninguém |
| **Relé** | IP, horário e tamanho aproximado de cada acesso a uma caixa postal | Quem escreve, para quem (no sentido de identidade), o conteúdo |
| **Operadora (SMS)** | Número de origem e de destino, horário | O conteúdo (cifrado) |
| **Cloudflare** | Vê o tráfego HTTPS que chega ao Worker (inclui IPs) | O conteúdo (cifrado) |

Não existe servidor de contas. Perdeu o aparelho ou a senha: o administrador emite uma identidade nova (não há como recuperar a antiga) e os contatos recebem o aviso de troca de chave.

## 2. Chaves e cofre

Cada pessoa tem um par **X25519** (cifrar) e um par **Ed25519** (assinar). O administrador tem, além disso, a **chave da autoridade da rede** (Ed25519), que fica só no aparelho dele.

Tudo é guardado no aparelho, cifrado pela senha: `scrypt(senha) → HKDF → XChaCha20-Poly1305`. O custo padrão é N = 2¹⁴. **No v2 esse custo é pago a cada desbloqueio**, porque não há mais o envelope no servidor nem o cofre rápido do v1. No interpretador Hermes medi ~3 s por derivação numa CPU de servidor; num celular intermediário deve ser pior, e eu não medi em aparelho. O scrypt é plugável (`VaultOptions.scrypt`) para usar uma versão nativa. O estado do app (contatos, certificados) é cifrado com uma chave derivada da identidade, e só é legível com o cofre aberto. Só o nome da pessoa e o da rede ficam legíveis, para a tela de bloqueio.

**Tamanho da senha.** O mínimo é de 6 caracteres. O app avisa, sem impedir, quando a senha é só de números ou tem menos de 10 caracteres. O scrypt (N = 2¹⁴) só encarece cada tentativa de quem conseguir **uma cópia do cofre**; ele não impede senhas curtas de caírem. Medi, em CPU de servidor com 8 núcleos, ~37 ms por tentativa com scrypt nativo. Com isso, o espaço inteiro de **6 dígitos** (10⁶) cai em cerca de **77 minutos**, e o de **6 caracteres entre letras maiúsculas, minúsculas e números** (62⁶ ≈ 5,7 × 10¹⁰) leva anos. Uma GPU ou vários servidores encurtam esses tempos. O cofre fica no Keychain/Keystore do aparelho, o que dificulta a cópia, mas não a impede num aparelho comprometido.

**Digital (opcional).** Depois de criar ou entrar na rede, o usuário pode ligar o desbloqueio por digital (ou rosto). Nada muda no cofre: a mesma chave que a senha produz (a saída do scrypt, antes do HKDF) é guardada no SecureStore com `requireAuthentication`, ou seja, o sistema só a entrega depois de uma biometria válida. `exportVaultKey(senha)` confere a senha e devolve essa chave; `unlockWithKey(chave)` abre o cofre sem rodar o scrypt, então o desbloqueio por digital também é **instantâneo**. A senha continua valendo como alternativa. Se as digitais cadastradas no aparelho mudarem, o sistema invalida a chave guardada e o app volta à senha; trocar a senha renova a chave da digital (ou a desliga). Uma chave antiga não abre um cofre cuja senha mudou (`StaleVaultKeyError`; testado). **Não testei em aparelho**: no navegador o leitor é simulado.

## 3. Certificados

Todos assinados com Ed25519, com campos em ordem fixa e nomes codificados (um nome com quebra de linha não consegue forjar outro campo).

| Certificado | Quem assina | Para quê | Validade | Tamanho |
|---|---|---|---|---|
| **Membro** | Autoridade da rede | "Esta chave pertence a esta pessoa nesta rede", com a caixa postal e o relé dela | 30 dias | 455 B |
| **Vínculo** | As autoridades das **duas** redes | As duas redes podem conversar | 90 dias | 461 B |
| **Revogação** (membro) | Autoridade da rede | Retira a confiança numa chave antes do vencimento | — | 266 B |
| **Revogação** (vínculo) | Qualquer uma das duas autoridades | Encerra um vínculo antes do vencimento | — | — |
| **Descritor da rede** | A própria autoridade | O "código da rede" para pedir conexão | — | — |

**Regra de ouro** (`trustOf`): só se aceita um contato ou mensagem de quem apresenta um certificado de membro **válido** (assinatura, validade, não revogado) de uma rede em que se confia, que é a própria ou uma com **vínculo ativo direto**. Vínculos **não são transitivos**: o administrador B só entrega ao A os certificados dos *seus próprios* membros, nunca os de redes vinculadas a B, e o app de A recusaria de qualquer modo.

### Entrada na rede
1. O administrador gera um **convite** (430 caracteres, cabe num QR code): rede, chave da autoridade, como falar com o administrador e um segredo de uso único. **O nome da pessoa é definido pelo administrador no convite.**
2. A pessoa cria a identidade no aparelho e envia um **pedido de entrada** cifrado ao administrador, assinado para provar que tem a chave (e com o segredo do convite).
3. O administrador, ao abrir o app, verifica o segredo e a prova de posse e responde com o **certificado** e a lista de contatos. Os demais membros recebem o certificado novo.

### Vínculo entre redes
- **Pedido:** o administrador A informa o código da rede B (com assinatura do descritor); B vê a proposta e aceita ou recusa. Aceitar = contra-assinar. As duas assinaturas formam o certificado de vínculo.
- Cada administrador entrega ao outro os certificados (assinados) dos seus membros e cada um repassa aos seus. Nada precisa de confiança no administrador "repassador": cada certificado se prova sozinho.
- **Desvincular:** qualquer lado emite uma revogação de vínculo.

### Revogação e vencimento
Revogar um membro vale **na hora para quem receber o aviso** e **para todos quando o certificado vencer** (30 dias). Membros renovam sozinhos a partir de 7 dias antes de vencer, se o administrador ainda os reconhecer. Quem passa mais de 30 dias sem se conectar perde a confiança dos outros e precisa ser reconectado. **Essa defasagem é o custo de não ter servidor.**

## 4. Quadro cifrado (frame)

```
frame = versão(1) ‖ epk(32) ‖ AEAD_k1( refRemetente(8) ‖ carga ‖ mac(16) )
  k1  = HKDF( X25519(efêmera, destinatário) )                    → só o destinatário abre
  mac = HMAC( HKDF( X25519(remetente_estático, destinatário) ) ) → prova quem enviou
```

- **Remetente selado:** o relé não vê quem enviou; a referência do remetente vai *dentro* da parte cifrada. Nenhum trecho do quadro se repete entre mensagens (testado), então não há pseudônimo estável para correlacionar.
- **Autenticidade** do remetente (por `dh2`), com negabilidade, e a chave efêmera de cada mensagem.
- **Compacto:** sobrecarga fixa de **73 bytes**. Medido:

| Texto | Quadro | Em SMS de 140 B |
|---|---|---|
| 2 bytes | 86 B | 1 |
| 22 bytes | 106 B | 1 |
| 100 bytes | 184 B | 2 |
| 500 bytes | 585 B | 5 |
| Apresentação (certificado) | 563 B | 5 (uma vez por contato) |

- Preenchimento opcional (padrão 128 B no relé, para esconder o tamanho; zero no SMS, para caber).
- **Fragmentação** (`fragment`/`Reassembler`): 7 bytes de cabeçalho por parte, junta fora de ordem, ignora repetidas e descarta incompletas.
- Tipos: conversa, apresentação, recibo de leitura, apagar para todos, lista de contatos, pedido/resposta de entrada, renovação, proposta e aceite de vínculo.

## 5. Relé anônimo

Caixas postais com **id aleatório de 128 bits** e uma chave pública de **recebimento** registrada na criação (quem cria prova a posse). API HTTP:

| Pedido | Quem pode | O que faz |
|---|---|---|
| `PUT /q/:id` | Quem prova a chave (assinatura) | Cria a caixa |
| `POST /q/:id/m` | **Qualquer um que conheça o id** | Deposita um quadro (≤ 16 KB, ≤ 200 por caixa) |
| `GET /q/:id/m`, `/n` | Dono (assinatura) | Lê quadros / conta |
| `DELETE /q/:id/m/:msg` | Dono | **Confirma a leitura: apaga** |
| `DELETE /q/:id` | Dono | Apaga a caixa |

Assinatura: Ed25519 sobre `método ‖ caminho ‖ hora ‖ hash do corpo`; janela de ±5 min contra repetição; assinatura de um caminho não vale em outro. **Sem contas, sem registro de requisições, sem coluna de remetente.** Mensagens vencem em 7 dias; caixas sem uso por 60 dias são apagadas.

Quem conhece o id de uma caixa pode depositar quadros, mas **só quem tem certificado válido é aceito** pelo app. Isso é testado simulando um vazamento (o atacante conhece a caixa e a chave da vítima): nada chega ao usuário.

### Duas implementações, um contrato
- **Node + SQLite** (`packages/relay/src/node-server.ts`): para VPS ou máquina própria.
- **Cloudflare Workers + Durable Objects** (`src/worker.ts`): uma Durable Object por caixa, com SQLite próprio e alarme para apagar o que venceu. É a que você escolheu como primeira opção.

A lógica é a mesma (`core.ts`). O mesmo teste de contrato HTTP e os mesmos cenários do nó rodam contra as duas, inclusive contra o Worker no workerd (`npm run test:worker -w @sigilo/relay`).

**Limites do Worker.** O Worker limita por IP a *criação* de caixas (20/min) e o total de pedidos (1500/min), pelo recurso de rate limiting da Cloudflare. Medi que pedidos a ids inexistentes **ainda criam um banco vazio** na Durable Object (no emulador local, 3 arquivos por id), por isso o limite de criação importa; o custo disso em produção eu não consigo medir daqui.

## 6. Transportes e prioridade

O app escolhe o meio **mais privado disponível**; o quadro é o mesmo em todos (`TransportManager`).

| Ordem | Meio | Rastro | Estado |
|---|---|---|---|
| 1 | **Proximidade** (Bluetooth / Wi-Fi Direct) | Nenhum fora dos dois aparelhos | Interface pronta; **módulo nativo não escrito** |
| 2 | **Relé** (internet) | O relé vê IP e horário | **Pronto e testado** |
| 3 | **SMS de dados** (só Android) | A operadora registra quem e quando | Interface e política prontas; **módulo nativo não escrito** |

**SMS só com permissão.** Ele deixa registro na operadora, então só é usado se o usuário autorizou *aquele contato* e informou o número. Se for a única opção, o envio fica na fila e o app recebe `needsConsent: 'sms'` para perguntar. Em aparelho sem SMS (iPhone), a opção nem aparece. Quando nenhum meio está disponível, a mensagem espera numa **fila cifrada pelo cofre** e sai quando houver um. Mensagem que chega duas vezes por dois meios aparece uma vez.

## 7. Ciclo de vida da mensagem

1. Ana cifra para o Bruno e deposita na caixa dele. **O texto só existe na memória da Ana** (e, se o envio falhar, na fila cifrada).
2. Bruno, com o app aberto, consulta a caixa. Sem a senha, ele só sabe **quantas** mensagens esperam (`pendingCount`, usando uma chave que não lê conteúdo).
3. Com a senha, ao abrir a conversa, o nó decifra, **apaga a mensagem da caixa** e envia um **recibo** à Ana. A partir daí o texto só existe na memória de quem exibe.
4. Ana recebe o recibo, e o texto dela some da memória: o que fica é "lida e apagada".
5. Trancar o cofre apaga o texto da memória; as mensagens não lidas **continuam cifradas na caixa**.
6. **Apagar para todos** funciona enquanto a mensagem não foi lida.

## 8. O que falta e o que não consegui testar

**Falta construir**
- **Módulo nativo de SMS** (Android, SMS de dados).
- **Módulo nativo de Bluetooth.** Android↔iPhone exige protocolo próprio, e o iPhone é limitado em segundo plano.
- **Notificações:** por decisão sua, não há push. O app consulta o relé enquanto está aberto. No Worker, o custo de consultas frequentes importa (veja `IMPLANTACAO.md`).
- **Recuperação da chave do administrador:** a chave da autoridade existe só no aparelho dele. Falta backup protegido e delegação para mais de um administrador.
- Vários aparelhos para a mesma pessoa.

**Não testei em aparelho** nada que dependa de celular: SMS, Bluetooth, Keychain/Keystore, **leitura de QR code pela câmera** (o desenho do QR e o fluxo por texto foram testados no navegador), **a digital** (a guarda da chave pelo hardware e a janela de biometria do sistema), bloqueio de captura de tela e o desempenho do scrypt no Hermes. Os testes automáticos usam transportes simulados para SMS.

## 9. Limites honestos do desenho

- **Metadados:** o relé vê IP, horário e tamanho; a operadora vê números. Quem não quer isso deve usar a proximidade.
- **Defasagem de revogação** de até 30 dias para quem não receber o aviso.
- **Administrador que perde a chave da autoridade perde a rede.**
- **Quem conhece o id de uma caixa pode enchê-la** (até 200 quadros) até o dono ler. Não lê nada, mas incomoda.
- Sem sigilo futuro completo (não há *double ratchet*): a chave de identidade do destinatário abre as mensagens destinadas a ele que ainda estiverem na caixa; a mitigação é apagar na leitura.
