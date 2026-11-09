# Agente de combate às endemias em campo e bloqueio de transmissão (VIG-3a)

Entrega da semana 26. O agente de combate às endemias (ACE) trabalha no celular sem internet: leva a zona, as
ordens de bloqueio que recebeu e o estoque de larvicida, registra cada visita ao imóvel (depósitos, focos, tubitos,
tratamento com baixa do larvicida por lote, nebulização, pendências) e sincroniza quando a rede volta, sem duplicar.
Cada notificação de dengue, chikungunya ou Zika abre ou amplia uma **ordem de bloqueio de transmissão**: casos da
mesma área e do mesmo período viram uma ordem só, sobre os quarteirões no raio de 150 m das residências. A visita
também vira a ficha de visita domiciliar e territorial do e-SUS APS.

## Base normativa e técnica (conferida em 06/11/2026)

| Tema | Regra adotada | Fonte |
|---|---|---|
| Bloqueio de transmissão | Ação imediata quando há notificação de caso suspeito; inspeção, eliminação de criadouros e controle larvário, com nebulização costal (UBV portátil) quando indicada | Diretrizes Nacionais para Prevenção e Controle das Arboviroses Urbanas (MS, 2025), § 7.1.4, p. 52 |
| Raio | No mínimo 150 m da residência do caso (cerca de nove quarteirões), começando pelo quarteirão de ocorrência; medido até a borda de cada quarteirão (semana 25) | Diretrizes de 2025, p. 52 e 84; Diretrizes de 2009, p. 83 |
| Agrupamento | Casos do mesmo período (até sete dias) e da mesma área numa ação só. Regra do sistema: residências a até duas vezes o raio (as áreas de 150 m se tocam) e datas a até 7 dias, sem encadear: antes do campo, todas as datas de uma ordem ficam a até 7 dias umas das outras; depois, a referência é o início do campo (entra o caso que começou até 7 dias depois dele). O mesmo imóvel ou a mesma pessoa agrupam mesmo sem posição, mas também só dentro dessa janela | Diretrizes de 2025, p. 52 |
| Data do caso | Início dos sintomas; sem ele, a data em que a vigilância soube do caso | Ficha de notificação (Sinan) |
| Prazo para começar | O Ministério não fixa horas ("o mais rápido possível"); a SES-MG recomenda começar de 3 a 7 dias do início dos sintomas. O sistema marca a ordem aberta há mais de 3 dias sem campo (parâmetro local) | Diretrizes de 2025, p. 52 e 137; Nota Técnica nº 1/2025 e POP 02 da SES-MG |
| Epidemia | Com a transmissão espalhada, a ação passa a ser por área: a coordenação desliga a abertura automática | Diretrizes de 2025, cap. 9; Diretrizes de 2009, p. 83 |
| Depósitos | A1 e A2 (água para consumo), B (móveis), C (fixos), D1 (pneus), D2 (lixo, sucata, entulho), E (naturais). B e E não recebem larvicida; no D2, lixo e entulho se eliminam e só a sucata de ponto estratégico pode ser tratada; A1, A2, C e D1 só como última alternativa | Manual do LIRAa (MS, 2013), Anexo C; Diretrizes de 2025, p. 38, 41 e 51 |
| Atividades | 1-LI, 2-LI+T, 3-PE, 4-T, 5-DF, 6-PVE e o bloqueio (boletim próprio); um boletim por atividade | Manual de Normas Técnicas do PNCD (FUNASA, 2001); instrutivo dos boletins de campo (SES-RS) |
| Pendência | Fechado e recusado (F e R do boletim); abandonado é o imóvel em evidente desuso | Boletins do PNCD; Lei 13.301/2016, art. 1º, § 2º, I (abandono) e III (recusa) |
| Tubitos | Um por depósito com foco, nunca misturado; cada agente numera de 1 a 999 e recomeça | Manual do LIRAa, 2013; FUNASA, 2001 |
| Larvicidas | Rotina: Bti WG 37,4% (em gramas) e disco de piriproxifeno 2% para recipientes de 40 a 500 L; fornecidos pelo Ministério (pedido pelo SIES); validade de lotes pode ser prorrogada por nota técnica | Nota Informativa nº 29/2024-CGARB (e NI 10/2025); Nota Técnica nº 54/2025-CGARB |
| Dose | Pela capacidade total do depósito (cubagem), conforme a nota técnica do produto: o sistema registra a quantidade usada, sem calcular a dose | Diretrizes de 2025, p. 51 |
| Índices | IIP = imóveis com foco ÷ imóveis inspecionados × 100; Breteau = depósitos com foco ÷ imóveis inspecionados × 100; IR = depósitos com foco ÷ depósitos inspecionados × 100; ITR = depósitos com foco do tipo ÷ total com foco × 100. Só do levantamento (LI e LI+T), pela última visita trabalhada de cada imóvel no período, com duas casas. IIP abaixo de 1% satisfatório, de 1% a menos de 4% alerta, 4% ou mais risco (a classe sai da razão exata: 4 em 101 = 3,96%, alerta) | Manual do LIRAa, 2013, p. 19-20; Diretrizes de 2009, p. 75; Nota Informativa nº 11/2026 |
| Pendência aceitável | Abaixo de 10% (meta); acima de 20% a área é sinalizada | PNCD (FUNASA, 2002), p. 7; Diretrizes de 2009, p. 141 |
| Supervisão e carga | 1 supervisor de campo para 10 ACE; 800 a 1.000 imóveis por agente, em ciclos bimestrais | Diretrizes de 2025, p. 90; Diretrizes de 2009, p. 61 e 63 |
| ACE | Atribuições (controle químico e biológico, cadastro e atualização da base de imóveis, registro conforme as normas do SUS) e supervisão pelo gestor | Lei 11.350/2006, art. 4º, com a redação da Lei 13.595/2018 |
| CBO | 5151-40 Agente de combate às endemias (definitivo; substituiu o provisório 5151-F1); não há CBO próprio de supervisor de endemias | Portaria GM/MS 535/2016; Diretriz Nacional para Atuação Integrada dos ACE e ACS (MS, 2025), p. 15 |
| Ficha do e-SUS | Ficha de visita domiciliar e territorial (tipo 8) aceita o CBO 515140; motivos do controle ambiental e vetorial: 34 ação educativa, 35 imóvel com foco, 36 ação mecânica, 37 tratamento focal (larvicida no depósito; a nebulização sozinha não é tratamento focal); recusada ou ausente vai sem motivo; imóvel que não é domicílio vai sem dado de pessoa; CPF ou CNS, não os dois; no domicílio, o responsável familiar | LEDI do e-SUS APS 8.7.0 (dicionário da FVD e tabela 7 de CBO) |
| Imóvel fechado ou recusado | O ingresso forçado (art. 1º, § 1º, IV) só vale com emergência em saúde pública declarada (ESPIN) e exige abandono, recusa ou "ausência" documentada: "duas visitas devidamente comunicadas, em dias e períodos alternados, dentro do intervalo de dez dias" (§ 2º, II). O sistema aponta a ausência quando há duas visitas com o imóvel fechado, em dias e turnos diferentes, a até 10 dias uma da outra; a comunicação prévia é documentada pela equipe fora do sistema. Fora da ESPIN vale o código de posturas do município | Lei 13.301/2016, art. 1º (texto conferido na publicação original da Câmara dos Deputados); Amparo legal à execução das ações de campo (MS, 2006); Diretrizes de 2025, Apêndice G |
| Sigilo | O agente e a supervisão não veem nome, endereço, ponto, distância nem agravo do caso: só a lista de quarteirões, com o de ocorrência marcado (o bloqueio começa por ele). Limite conhecido: a lista é calculada a partir do ponto da residência, então, cruzada com o mapa do território, ainda estreita a posição do caso dentro do quarteirão de ocorrência (ver Pontos de atenção) | Lei 6.259/1975, art. 10 (redação da Lei 14.289/2022); LGPD, art. 6º, III |

O e-SUS APS não tem campo para depósitos, focos, larvicida nem bloqueio (só os motivos 34 a 37): o boletim
detalhado fica no OmniSaúde; o SisPNCD e os sistemas estaduais não têm interface pública de integração.

## O que foi entregue

### Papéis e permissões

| Papel | Quem | Pode |
|---|---|---|
| Agente de combate às endemias (`ACE`) | CBO 515140 (a importação do CNES sugere este papel) | App de campo: pacote da zona e das ordens designadas, visitas, imóvel novo, posição do imóvel nos seus quarteirões. **Não lê prontuário** |
| Supervisor de campo (`SUPERVISOR_ENDEMIAS`) | ACE designado para a supervisão (CBO 515140 na demonstração) | Zonas, ordens (designar agentes, concluir, reabrir, recalcular), visitas, pendências, resolver baixas de larvicida; também usa o app de campo. Posiciona imóvel e vê a fila de pendências do território só nos quarteirões das zonas e das ordens ativas |
| Coordenação de endemias (`COORDENADOR_ENDEMIAS`) | Técnico responsável | Tudo da supervisão, mais configuração do bloqueio, cancelamento de ordem, cadastro de insumo, entrada e estorno de remessa e prorrogação de validade; edita o território |
| Vigilância epidemiológica e gestão | | Acompanham as ordens, zonas, visitas e a produção (`endemias.ler`); a ficha da notificação mostra a ordem do caso. A distância de cada quarteirão e o agravo aparecem só para quem tem o mapa de casos (`vigilancia.mapa`); a leitura do detalhe por quem não é da vigilância fica na trilha |

### Modelo de dados (migrações `0027_endemias`, `0028_endemias_ajustes` e `0029_inicio_do_campo_e_cadeia_de_unificacao`)

- `vector_zones` e `vector_zone_blocks`: zona de trabalho do ACE (um quarteirão fica numa zona só).
- `vector_visits`: visita ao imóvel com atividade, situação, recuperação, ciclo bimestral, contagens por tipo de
  depósito, tubitos, nebulização, ação educativa e GPS; `client_id` único (idempotência do aparelho). Índices por
  ciclo, imóvel e data e por data (`0028`), para as pendências e a produção.
- `vector_treatments`: produto, lote, quantidade e depósitos de cada tratamento, com a situação da baixa
  (`BAIXADO`, `PENDENTE`, `REGULARIZADO`, `CANCELADO`) e o motivo da pendência; índice único no movimento de estoque
  (uma baixa e um ajuste por linha, mesmo com reenvio simultâneo).
- `vector_stock_receipts`: entrada por remessa (guia do SIES ou da SES). A mesma guia não entra duas vezes no mesmo
  lote enquanto não for estornada (índice único parcial); o estorno guarda quem, quando e o motivo (`0028`).
- `households.vector_notes`: observação do imóvel do controle vetorial, separada da observação do cadastro da APS,
  que o ACE não vê (`0028`).
- `blocking_orders`, `blocking_order_cases`, `blocking_order_blocks`, `blocking_order_assignees`: a ordem, as
  notificações ligadas (uma ordem por notificação), os quarteirões no raio e os agentes designados.
- `esus_record_items`: em que ficha do e-SUS foi cada registro (atendimento, procedimento, classificação de risco,
  vacina, visita do ACS ou do ACE), carregada na migração a partir dos lotes já gerados (`0028`).
- Novos valores: papéis `ACE`, `SUPERVISOR_ENDEMIAS`, `COORDENADOR_ENDEMIAS`; local de estoque `ENDEMIAS`;
  movimentos `TRATAMENTO_FOCAL`, `ENTRADA_REMESSA` e `ESTORNO_REMESSA`; produto marcado como larvicida ou adulticida
  (não sai na dispensação da farmácia).
- `0029` só corrige dados gravados antes de duas regras da semana: a ordem com o início do campo antes da abertura
  passa a começar na abertura, e cada cadastro de uma cadeia de unificações passa a apontar para o fim dela, numa
  rodada só, qualquer que seja o tamanho da cadeia (o ciclo é reconhecido pelo caminho percorrido e fica como está,
  com a cadeia que entra nele). Rodar de novo não muda nada.

### Ordem de bloqueio

- **Abertura**: cada criação ou mudança de notificação dos grupos configurados (padrão: dengue, chikungunya e Zika;
  febre amarela é opção local) é avaliada depois do commit. Anomalia congênita, caso descartado (ou encerrado como
  descartado), residência fora do município e caso com início dos sintomas há mais de 30 dias não abrem ordem.
  Mudanças que não mexem na ordem (ciência, comunicação, número oficial, prazo vencido, confirmação, comunicação
  policial, resultado de exame) não acionam o bloqueio.
- **Uma ordem para casos próximos**: a notificação entra na ordem ativa que tenha um caso a até duas vezes o raio e a
  até 7 dias (ou do mesmo imóvel ou da mesma pessoa, também dentro dos 7 dias); senão, abre uma ordem nova, numerada no
  ano (`1/2026`). Antes do campo, com ela todas as datas da ordem precisam continuar a até 7 dias umas das outras (sem
  cadeia). Depois que o campo começa, a âncora passa a ser o início do campo: a ordem recebe quem agrupa com ela ou mora
  num quarteirão que ela cobre, desde que os sintomas não tenham começado mais de 7 dias depois do início do campo (a
  visita feita antes disso não serve ao caso novo, que abre outra ordem). A data corrigida para trás de um caso que
  fica na ordem não fecha a ordem ao vizinho novo. O início do campo é a visita mais antiga da ordem, nunca antes da
  abertura (visita do dia da abertura feita antes da hora dela, ou relógio do aparelho atrasado).
- **Trava**: uma trava no banco serializa as decisões (duas notificações simultâneas não abrem duas ordens). O
  gatilho só trava se o retrato do caso mudou, e relê a notificação dentro da trava; com a trava ocupada, tenta de
  novo por cerca de 1,5 s e desiste, e a varredura completa depois.
- **União de ordens**: quando o retrato de um caso muda (posição, data, imóvel, agravo) e ele passa a agrupar com
  outra ordem ativa, as duas viram uma só, se ao menos uma não tem visitas. A sem visitas vai para a outra (se nenhuma
  tem, a mais nova vai para a mais antiga), com todos os casos ativos e os agentes designados à mão; a de origem é
  cancelada como "unificada a outra ordem" e aponta para o destino. Duas ordens com campo não se unem. Sem campo nas
  duas, a ordem unida continua num período só (até 7 dias, sem cadeia); com o destino em campo, cada caso da origem
  precisa ter começado até 7 dias depois do início do campo.
- **Data corrigida**: se a data nova de um caso estica a própria ordem além de 7 dias, ele sai dela e é avaliado como
  caso novo, enquanto a ordem não tem visitas (com sintomas há mais de 30 dias, ou com a abertura automática desligada,
  ele só sai, sem abrir outra ordem); com campo, ele fica (o trabalho feito vale).
- **Caso reaberto** (descarte desfeito, encerramento reaberto) volta à própria ordem, se ela continua ativa. A
  reclassificação (outra notificação da mesma pessoa ou do mesmo imóvel) entra na ordem em campo, dentro da janela.
- **Imóvel do caso**: só quando a posição da ficha é desse imóvel (cadastro, ou ficha a até 100 m do domicílio
  atual); quem mudou de casa fica com a residência notificada. Caso sem posição agrupa pelo domicílio atual.
- **Quarteirões**: a união dos quarteirões a até 150 m (até a borda) de cada residência ativa. Antes do trabalho de
  campo a lista acompanha os casos; depois de começar, só cresce. São designados sozinhos só os titulares (com
  lotação de campo e usuário ativos) das zonas dos quarteirões que acabam de entrar, com registro na trilha; quem a
  supervisão tirou não volta sozinho.
- **Residência sem posição boa** (rua sem número, centro do bairro, CEP): a ordem fica "aguardando a localização"
  até a vigilância marcar o imóvel ou chegar o GPS de uma visita (ACS ou ACE). Face de quadra e centro do quarteirão
  entram com aviso "conferir o imóvel".
- **Reavaliação na hora**: posicionar o imóvel (mapa do território, cadastro do domicílio, GPS da visita do ACS ou do
  ACE), geocodificar, religar imóveis à malha (vincular, editar ou desativar quarteirão, importar malha), incluir ou
  tirar alguém de uma família e unificar cadastros reavaliam na hora os casos dos moradores, também em ordem em campo. O aviso roda depois do
  commit, e uma falha dele nunca derruba a gravação (a varredura completa). A unificação trava, num comando só e na
  ordem dos ids, os dois cadastros e os já unificados no duplicado, e relê os dois depois da trava (duas unificações no
  mesmo cadastro não se sobrescrevem); a que o banco desfaz por impasse é repetida até 3 vezes e responde como as
  outras (feita, cadastro não encontrado ou conflito).
- **Caso descartado** sai da ordem; ordem sem caso e sem visita é cancelada; com visita, fica para a supervisão
  decidir.
- **Situação**: aguardando localização, aberta, em campo (na primeira visita sincronizada; o início é a visita mais
  antiga, nunca antes da abertura), concluída (com justificativa se ficou imóvel sem visita ou pendente) ou cancelada (só a coordenação).
  Concluída pode ser reaberta. O recálculo só passa de "aguardando" a "aberta" e de volta, com a linha da ordem
  travada: visita, conclusão e cancelamento que chegam no meio dele não se perdem. Concluir, reabrir e cancelar também
  travam a linha, e a visita que chega nesse instante espera e vê a situação final; o progresso e a justificativa da
  conclusão contam as visitas que entraram até ali. A conclusão que esperou um cancelamento responde "A ordem mudou
  enquanto você concluía; abra de novo", sem pedir justificativa.
- **Progresso**: por quarteirão, os imóveis ativos que estão nele hoje e a última visita de cada um na ordem.
- **Lista**: as ativas vêm com as atrasadas primeiro e depois da mais antiga para a mais nova, até 500.
- **Varredura a cada 5 minutos**: refaz o que o gatilho não conseguiu, com as mesmas regras (30 dias, sem anomalia
  congênita), das mais recentes para as mais antigas; reavalia primeiro quem aguarda a localização e os casos cujo
  imóvel tem uma posição que o retrato do caso não reflete (também em campo; a comparação é pela posição, não pela hora
  do aparelho); ordens abertas sem quarteirão, as mais novas primeiro.
- **Tempo real**: o aviso de mudança da ordem vai só para quem trabalha com endemias (ler, supervisionar ou campo),
  nunca para painel de TV nem para a recepção.
- **Configuração** (coordenação): abertura automática, janela de agrupamento, agravos e alerta de ordem sem início.

### App de campo do ACE (`/campo-ace`, sem internet)

- **Pacote**: zona (quarteirões e imóveis com a situação no ciclo bimestral e a observação do controle vetorial),
  ordens designadas (quarteirões com o de ocorrência marcado e os imóveis já trabalhados nelas), o catálogo de
  insumos ativos (com ou sem saldo) e os lotes com saldo no depósito de endemias da unidade (havendo mais de um, vale
  o mais antigo), guardados no aparelho. Sem o ponto, a distância nem o agravo do caso. É baixado ao abrir a tela e
  depois de um envio completo, se tiver mais de 30 min, e sempre pelo botão Sincronizar.
- **Visita**: atividade (LI+T, LI, T, bloqueio, PE, DF, PVE), data e hora, situação (trabalhado, fechado,
  recusado, abandonado), tabela de depósitos A1 a E (inspecionados, com foco, eliminados, tratados), tubitos
  numerados, larvicida (produto, lote, quantidade, depósitos) com o saldo estimado, nebulização intra ou
  peridomiciliar no bloqueio, ação educativa, GPS e observação. As mesmas regras da API conferem a visita antes de ela
  entrar na fila: contagens, larvas e pupas até 999, tubito de 1 a 999, até 99 amostras e 5 produtos, quantidade de
  0,001 a 100.000 no formato brasileiro (vírgula decimal; "2.5" é recusado como ambíguo), lote até 40 caracteres e
  observação até 1.000; fechado, recusado e abandonado não levam contagem.
- **Larvicida no formulário**: lista todo o catálogo; o lote sugerido é o primeiro não vencido; produto sem lote no
  pacote aceita o número do lote digitado, e a baixa fica pendente para a supervisão. O D2 em ponto estratégico
  mostra "só sucata". A aba Larvicida mostra o saldo menos o que já foi enviado e o que está na fila.
- **Tubitos**: o contador guarda o último número dado pelo botão (1 a 999, recomeça em 1), gravado junto com a
  visita; número editado à mão não mexe nele.
- **Imóvel novo** no quarteirão (tipo, sequência, endereço, GPS opcional): pode ser visitado antes de sincronizar.
  Em quarteirão desativado na malha entra com aviso para a supervisão; data do aparelho com mais de um ano vira a do
  envio, com aviso. O GPS só vira a posição do imóvel quando cai no quarteirão escolhido; fora dele, o imóvel fica no
  quarteirão escolhido, sem posição, e a supervisão recebe o aviso para posicioná-lo no mapa. O sistema reconhece o
  imóvel criado pelo ACE pelo registro da sincronização, e o quarteirão escolhido em campo fica, qualquer que seja a
  precisão da posição: a geocodificação não o tira de lá (conta em "fora do quarteirão" ou "quarteirão desativado",
  também quando a face de quadra o confirmou e a base nova traz o endereço exato noutro quarteirão); a correção do
  endereço pela recepção tira só a posição que veio do endereço; tirar a posição pelo cadastro também não tira o
  quarteirão; e a religação da malha (religar todos, importar, editar o contorno) não o move ("Religar todos" diz
  quantos ficaram no quarteirão escolhido com a posição noutro). A visita seguinte com GPS dentro dele o posiciona. Só
  uma ação explícita muda o quarteirão: marcar no mapa, ler o GPS na tela do território ou cadastrar o domicílio com
  posição; daí em diante, a posição explícita manda. Sem o número na base do IBGE, a geocodificação dá a ele o centro
  do quarteirão escolhido (o caso de um morador entra no bloqueio com "conferir o imóvel"). Em quarteirão desativado na
  malha, a geocodificação o deixa como está e diz o motivo: marcar no mapa o liga ao quarteirão novo.
- **Armazenamento no aparelho**: banco próprio no IndexedDB (`omnisaude-campo-ace`: fila, pacote, histórico e
  contador de tubitos), separado do banco do ACS (`omnisaude-campo`). Se o aparelho não grava (outra aba prendendo o
  banco, falta de espaço), o formulário diz "Não foi possível guardar no aparelho" e continua aberto: nada é dado
  como registrado. Cada gravação é toda ou nada, também quando uma parte não pode ser guardada na hora, e a falta de
  espaço tem mensagem própria. Tentar de novo, corrigir, aplicar no pacote o que o servidor aceitou e gravar o
  resultado do envio (erro, falha passageira, lote recusado inteiro) leem e regravam a fila, o histórico e o pacote
  numa transação só: o descarte feito noutra aba nesse meio-tempo vale e o registro não volta (nem conta como erro no
  aviso), e o pacote baixado noutra aba não é sobrescrito pelo antigo. Corrigir grava o registro e o contador de
  tubitos juntos; se o registro saiu da fila antes, nada é gravado e a tela avisa. A correção salva enquanto a versão
  anterior do mesmo registro estava sendo enviada não se perde em silêncio: se o servidor gravou a versão anterior, o
  registro corrigido fica na fila com o aviso "O servidor gravou a versão anterior deste registro enquanto você
  corrigia: a correção não foi enviada. Confira e descarte o registro."; se a versão anterior voltou com erro, a
  correção continua pendente e vai no próximo envio.
- **Fila presa ao usuário e à lotação**: outro usuário no mesmo aparelho não envia o trabalho alheio; cada registro
  guarda a unidade da lotação ativa e só vai com ela (os de outra lotação aparecem como "Outra lotação"). Envio e
  download do pacote ficam em fila entre as abas abertas (trava do navegador), então duas abas não mandam o mesmo
  registro e o larvicida usado sai uma vez só do pacote guardado.
- **Sincronização idempotente**: o diálogo fecha assim que o registro é guardado, e o envio segue em segundo plano,
  de 100 em 100. A visita (ou o imóvel), o registro do `clientId` e a baixa do estoque vão numa transação só; o
  reenvio, em sequência ou simultâneo (resposta perdida, duas abas), volta como "já estava no servidor". Cada visita
  aceita volta com a ordem de bloqueio em que ficou (ou nenhuma), também no reenvio, e o aparelho marca a casa só nessa
  ordem no pacote guardado; sem essa resposta (servidor de versão anterior), só na ordem informada. Cada
  operação é conferida sozinha: a inválida volta com o campo e o motivo, sem derrubar as outras. Falha passageira do
  servidor é repetida no próprio servidor e, se continuar, o registro fica pendente ("Última tentativa: ...");
  operação de outra lotação é recusada. Servidor fora, sessão vencida e falta de permissão interrompem o envio com a
  mensagem.
- **Corrigir**: o registro com erro reabre o formulário com os dados e regrava com o mesmo identificador (no imóvel
  novo dá para trocar o quarteirão; na visita, a data). A visita da fila sem ordem reabre com a ordem do quarteirão,
  como no roteiro: a ordem volta se a correção mudar a data ou a atividade. Aceito o imóvel novo, as visitas dele que
  tinham dado erro voltam a pendente e vão juntas. Descartar o imóvel novo descarta as visitas dele, com confirmação.
- **Recuperação**: a visita é recuperação quando a anterior do mesmo escopo (a mesma ordem; sem ordem, o mesmo
  ciclo), pela data da visita, foi pendência; quando uma visita anterior chega depois (outro agente sem rede), a
  seguinte é refeita.
- **Ordem na visita**: a ordem é lida dentro da transação da visita, com a linha travada, então a visita não entra numa
  ordem cancelada ou unificada no meio do envio. Visita de bloqueio sem ordem vai para a ordem ativa mais recente que
  tem o quarteirão e foi aberta até o dia da visita; a aberta depois não existia quando ela foi feita (a casa contaria
  como trabalhada para um caso que ainda não era conhecido), e a visita fica como bloqueio sem ordem, com o aviso. Visita feita numa ordem que foi unificada (a que estava no pacote antes da união) vai para a ordem de
  destino, se o quarteirão do imóvel está nela, com o aviso "A ordem X foi unificada à ordem Y: visita gravada nela"; se
  o destino já foi concluído, a visita entra nele do mesmo jeito (o trabalho foi feito antes), como na ordem concluída
  informada direto. Só a visita de bloqueio entra na ordem: a de outra atividade com a ordem informada fica sem ela
  ("Só a visita de bloqueio entra na ordem N/AAAA: visita gravada sem a ordem"). A visita de dia anterior ao da
  abertura da ordem informada (no fuso da prefeitura, também se essa ordem foi unificada ou cancelada depois) é
  tratada como sem ordem informada, com um aviso só: "A data da visita é anterior à abertura da ordem N/AAAA: visita
  gravada na ordem M/AAAA, já aberta no dia dela" ou "...: visita gravada como bloqueio sem ordem", seguido de "(confira
  a data da visita e o relógio do aparelho)". A do mesmo dia, antes da hora da abertura, entra, com o aviso "A hora da
  visita é anterior à abertura da ordem N/AAAA: confira a hora da visita e o relógio do aparelho".
- **Ordem no formulário**: a ordem só vai com a atividade Bloqueio, e só então aparece "Faz parte da ordem de bloqueio
  N". Com a data num dia anterior ao da abertura da ordem (no fuso do aparelho), a visita vai sem a ordem e a tela
  avisa "A data é anterior à abertura da ordem N/AAAA: a visita não vai entrar nela"; o servidor ainda pode pô-la
  numa ordem mais antiga do quarteirão, já aberta no dia dela, e o aparelho marca a casa pela ordem devolvida.
- **GPS da visita**: nunca troca o quarteirão do imóvel. Só posiciona o imóvel ainda sem posição boa, e só quando o
  ponto cai no quarteirão do próprio imóvel (dentro dele, ou na rua a até 15 m e mais perto dele que de outro); fora
  disso, a posição fica só na visita e a supervisão recebe o aviso. A leitura que chega depois de o diálogo fechar é
  descartada.
- **Sem internet**: o service worker, registrado em todas as telas autenticadas do build de produção, guarda as
  telas de campo do ACE e do ACS na instalação e a cada abertura com rede. Sem rede (ou se a rede não responde em 4 s
  numa tela de campo), abre a cópia; tela não guardada mostra o aviso com os links das telas de campo.

### Larvicida por lote

- A baixa sai do depósito de endemias da unidade do agente, no lote informado; as baixas travam os saldos na ordem
  dos lotes, então duas visitas com os mesmos lotes em ordem inversa não se travam. Sem saldo, com lote desconhecido
  ou de outro produto, a visita é gravada e a baixa fica **pendente** (o larvicida já foi usado); lote vencido na data
  da visita é baixado e marcado.
- A supervisão resolve cada pendência: baixar em outro lote, regularizar (ajuste só da diferença e a baixa, para o
  estoque físico que existia) ou cancelar (registro errado), escolhendo o depósito de endemias (obrigatório quando a
  unidade da visita não tem um).
- A coordenação cadastra o insumo, lança a remessa (guia do SIES ou da SES, sem nota fiscal; a mesma guia não entra
  duas vezes para o lote) e prorroga a validade de um lote por nota técnica (auditado). A remessa lançada errada é
  **estornada** pela coordenação, com motivo, se o lote ainda tem no depósito toda a quantidade dela (o que saiu em
  campo não volta); depois do estorno a mesma guia pode ser lançada de novo.
- O depósito de endemias da unidade nasce na primeira entrada, sem duplicar mesmo com entradas simultâneas.

### Telas da supervisão (`/endemias`)

Bloqueios (lista com cobertura e pendência, ordem com mapa dos quarteirões e progresso por quarteirão, agentes e
ações), Zonas (montar com os quarteirões livres e designar o titular), Visitas (boletins do período), Pendências
(imóveis com as tentativas e a "ausência" documentada; baixas de larvicida), Larvicidas (saldo por lote, uso em 30
dias, remessa, entradas recentes com estorno, prorrogação), Produção e índices (por agente e localidade) e
Configuração. Além disso:

- Quem não tem o mapa de casos não vê a coluna Distância nem o agravo; a lista avisa quando chega a 500 ordens.
- Designar agentes mostra também os designados que perderam a lotação de campo ("sem lotação ativa"): podem ser
  desmarcados, não marcados de novo. O titular de zona sem lotação aparece marcado, e a zona pode ser salva sem
  trocá-lo. Só o quarteirão que entra na zona precisa estar ativo: o desativado na malha que já estava nela fica, marcado
  como desativado na tabela e no diálogo da zona, até a supervisão tirá-lo.
- Concluir, reabrir e cancelar pedem o mínimo de texto da API (5 caracteres no motivo; 10 na justificativa da
  conclusão quando ficou imóvel sem visita ou pendente).
- A entrada de remessa lê a quantidade no formato brasileiro (25.000 são 25 mil) e mostra "Será lançado: ..." antes
  de confirmar.
- As pendências separam fechado, recusa e abandono; "ausência" são duas visitas com o imóvel fechado, em dias e
  turnos diferentes, em até 10 dias, e a tela lembra de conferir se as visitas foram comunicadas. A lista vai até
  2.000 imóveis, os de visita mais recente primeiro. As baixas pendentes mostram a unidade da visita e o depósito.
- A produção mostra os índices só de LI e LI+T, com duas casas, e a positividade das outras atividades (T,
  bloqueio, PE, DF, PVE) à parte, que não é índice de infestação; o resumo conta as visitas de todas as atividades,
  como o boletim. Tudo é somado no banco, sem limite de volume.

A ficha da notificação ganhou o cartão da ordem de bloqueio do caso (as arboviroses), que exige acesso à
notificação; os demais agravos mantêm o cartão dos quarteirões no raio.

### Ficha do e-SUS APS

A visita do ACE gera a ficha de visita domiciliar e territorial (tipo 8) no lote da unidade do agente, uma por
agente, CBO e dia: motivos 34 a 37 pelo trabalho feito (28 quando só houve inspeção ou nebulização), desfecho pela
situação (fechado e abandonado como ausente), tipo de imóvel, microárea do imóvel ou fora de área, posição, e no
domicílio o responsável familiar. O CBO da ficha é resolvido na exportação (o da visita, se o modelo o aceita; senão,
o da lotação ativa no papel da visita), e o INE é o da equipe em que o profissional está com esse CBO: o ACE sem
equipe vai sem INE. A ficha de visita em geral passou a seguir as regras do LEDI 8.7.0 por tipo de imóvel (pessoa,
medições e motivos aceitos), também na entrada do app do ACS. Cada registro vai a uma ficha só: o sistema guarda em
que ficha foi cada um, e gerar de novo um período já enviado leva só o que faltou (`docs/ESUS.md`).

## Demonstração

A carga de desenvolvimento (`node packages/database/dist/cli.js seed`) cria a malha da sede (36 quarteirões sobre os
domicílios de exemplo, mais comércio, terreno baldio, borracharia e escola), a zona 01 do ACE e o depósito de
endemias com Bti WG e disco de piriproxifeno. Senha `OmniSaude2026`, instituição `demo`:

| Papel | CPF |
|---|---|
| Agente de combate às endemias | 100.000.016-86 |
| Supervisora de campo | 100.000.017-67 |
| Coordenador de endemias | 100.000.018-48 |

Notifique dengue para dois vizinhos (ex.: José Carlos Pereira e Pedro Henrique Alves, como médica): a vigilância vê
a ordem 1 na ficha, a supervisora acompanha em Endemias e o ACE a encontra em Campo do ACE > Bloqueios.

## Como foi verificado

- Regras compartilhadas (`packages/shared/test/endemias.test.ts` e `endemias-indices.test.ts`): conferência da
  visita e do imóvel novo, motivos do e-SUS, ciclo, índices só de LI e LI+T com a classe pela razão exata,
  agrupamento por área e janela, CBO 515140 e permissões do ACE.
- Ficha do e-SUS (`packages/esus/test/fichas.test.ts` e `visita-regras.test.ts`): ACE sem equipe, ponto estratégico
  sem pessoa, domicílio com o CPF do responsável, fechado e recusado sem motivo, CASAI, regras por tipo de imóvel
  iguais no app do ACS e na API.
- API contra PostgreSQL real:
  - `endemias.test.ts`: duas notificações próximas geram uma única ordem; o ACE trabalha sem rede e nada duplica ao
    sincronizar; baixa pendente e regularizada; remessa sem duplicar a guia; conclusão justificada; produção; fichas
    do e-SUS válidas.
  - `endemias-bloqueio.test.ts`: união da ordem inteira, janela sem cadeia antes do campo e âncora no início do campo
    depois, data corrigida (com e sem campo), caso reaberto e reclassificado, recálculo, conclusão e cancelamento
    concorrentes com a visita, varredura com mais de 1.000 casos, designação automática, sigilo fora da vigilância,
    aviso só na sala das endemias, GPS do ACS e do ACE, cadastro do domicílio reavaliando na hora, início do campo
    nunca antes da abertura e visita sem ordem de antes do dia da abertura fora da ordem.
  - `familia-bloqueio.test.ts`: incluir ou tirar a pessoa da família (recepção e ACS) e unificar cadastros reavaliam o
    caso na hora.
  - `territorio-geocodificacao.test.ts` e `territorio-quarteirao-escolhido.test.ts`: a posição pelo endereço não tira
    o imóvel do quarteirão escolhido, o centro do quarteirão vem antes da rua sem número, a correção do endereço não
    tira o quarteirão e o quarteirão desativado tem motivo próprio.
  - `campo-pacote-grande.test.ts`: pacote do ACE com 33 mil imóveis e zonas com 33 mil quarteirões.
  - `territorio-escopo-campo.test.ts`: fila de pendências, mapa e pacote do ACE e da supervisão com mais de 32.766
    quarteirões nas zonas.
  - `endemias-campo.test.ts`: catálogo de insumos, GPS da visita e do imóvel novo que não trocam o quarteirão,
    baixas sem deadlock, falha passageira, validação por operação, outra lotação, recuperação fora de ordem, visita
    em ordem unificada, remessas simultâneas e estorno.
  - `endemias-gestao.test.ts`: índices, produção com 51 mil visitas, pendências com 20 mil visitas, ausência só com
    imóvel fechado, titular e quarteirões da zona.
  - `esus-ledger.test.ts`: o mesmo registro não sai em dois lotes; reprocessar regera só os registros da ficha.
- Web, sem navegador (`apps/web/test`, com IndexedDB simulado): banco do ACE separado e migrado, falha ao guardar,
  fila por lotação, TENTAR_DE_NOVO, Corrigir, duas abas do ACE e do ACS, registro do ACS inteiro ou nada e as regras
  das telas de gestão.
- Revisão adversarial da entrega: 59 achados (55 confirmados, 1 plausível, 3 refutados), corrigidos em seis frentes
  e conferidos por três verificadores; mais três rodadas, cada correção com o seu verificador, fecharam o que eles
  ainda acharam.
- No navegador: ver `docs/STATUS.md` (Verificação feita).

## Pontos de atenção e fora do escopo

- Os insumos e o estoque físico de larvicida, os ACE no CNES, as zonas, a malha e o código de posturas são da
  instituição (`docs/PENDENCIAS.md`).
- **Sigilo da lista de quarteirões**: como a lista é calculada a partir do ponto da residência, quem cruza a lista da
  ordem com o mapa do território consegue estreitar a posição do caso dentro do quarteirão de ocorrência (na revisão,
  a área compatível ficou entre 4% e 16% do quarteirão, na mediana). Calcular a lista a partir da borda do quarteirão
  de ocorrência revela só esse quarteirão, ao custo de cerca de 25% mais quarteirões por ordem: é decisão da
  instituição (`docs/PENDENCIAS.md`).
- A comunicação prévia das visitas, que a Lei 13.301/2016 exige para a "ausência", não é registrada no sistema.
- Desativar um quarteirão (ou importar a malha desativando os ausentes) tira dele todos os imóveis, também os criados
  pelo ACE, que saem do pacote até a religação os ligar pela posição; o quarteirão ligado assim passa a valer como o
  escolhido em campo. O imóvel cadastrado pela recepção ou pelo ACS não tem quarteirão escolhido em campo: o que veio da
  posição pelo endereço segue o endereço melhor.
- Visitas de outra atividade que tenham entrado numa ordem antes da regra "só a visita de bloqueio entra na ordem"
  (só nos testes desta semana) continuam nela; não há migração para tirá-las.
- Sem a trava entre abas (navegador antigo ou fora de HTTPS), o pacote baixado noutra aba durante um envio pode
  receber de novo o larvicida aceito, e o saldo estimado no aparelho fica menor até o próximo download. Evitar isso
  pede que o servidor diga ao aparelho quais registros o pacote já conta.
- O adulticida da nebulização não tem baixa por imóvel (o consumo é por carga da bomba): fica registrado onde houve
  nebulização; o controle do adulticida e os ciclos de UBV com intervalo entram com o laboratório (semana 28) ou
  depois.
- O índice é preliminar: "com foco" é a larva ou pupa vista em campo; a espécie (Aedes aegypti ou albopictus) vem do
  laboratório de entomologia (semana 28), que recebe os tubitos já numerados.
- Pontos estratégicos e imóveis especiais com periodicidade por risco, ovitrampas e LIRAa/LIA ficam para as semanas 28
  e para a Onda 4b; o bloqueio a partir do local provável de infecção (trabalho, escola) não é automático.
- O lote do e-SUS continua por período, como nas demais fichas: a visita sincronizada depois do envio entra sozinha no
  próximo lote gerado para um período que cubra a data dela, sem repetir as já exportadas.
- A carga de estoque física por agente (o ACE levar uma quantidade do depósito) ainda não existe: a baixa é no
  depósito da unidade. Depósitos de endemias duplicados que já existam não são unidos: vale o mais antigo.
- O cache de arquivos do service worker não apaga os arquivos de versões antigas; em muitos meses de publicações ele
  divide a cota do navegador com a fila de campo. A limpeza fica para uma próxima entrega.
