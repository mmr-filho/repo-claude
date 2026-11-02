# Território georreferenciado e mapa de casos (PLT-3)

Entrega da semana 25. Território único para o agente comunitário (ACS), o agente de combate às endemias (ACE, semana
26), a vigilância sanitária (semana 30) e a vigilância epidemiológica: **localidade → bairro → quarteirão → imóvel**.
A posição do imóvel liga-o ao quarteirão; o raio do bloqueio parte da residência do caso e devolve os quarteirões
atingidos.

## Base normativa e técnica (conferida em 02/11/2026)

| Tema | Regra adotada | Fonte |
|---|---|---|
| Localidade | Código numérico de até 8 dígitos, único no município; categorias (cidade, vila, povoado, fazenda, sítio...) e zona (urbana, rural, periurbana) | Programa Nacional de Controle da Dengue (PNCD), reconhecimento geográfico |
| Bairro | Sublocalidade dentro da localidade; o oficial vem da lei municipal; apelidos ligam o nome escrito no cadastro ao bairro oficial | PNCD |
| Quarteirão | Numerado a partir de 1 em cada localidade (padrão); há municípios que recomeçam em cada bairro: a regra é configurável. Numeração suplementar como 12-A | PNCD |
| Imóvel | Sequência dentro do quarteirão (ex.: 40-1 para o anexo do 40) | PNCD |
| Raio do bloqueio | 150 m a partir da residência do caso (padrão configurável de 50 a 1.000 m); 300 m é o raio de ação em torno de foco, não do caso | Diretrizes Nacionais para Prevenção e Controle das Arboviroses Urbanas (2025) |
| Base de endereços | CNEFE do Censo 2022 (IBGE): endereços com coordenada e nível de precisão (NV_GEO_COORD 1 a 6) | IBGE |
| Sigilo do mapa de casos | Notificação compulsória com identificação sigilosa | Lei 6.259/1975, art. 10 (redação da Lei 14.289/2022); art. 7º do Anexo V da PRC 4/2017 |
| Geocodificação | Só local, dentro do sistema: nenhum endereço de paciente sai para serviço externo. O Nominatim (OpenStreetMap) proíbe dados pessoais e os termos do Google exigem exibir no mapa deles | LGPD; políticas de uso dos serviços |

O e-SUS APS não tem quarteirão (só microárea e o tipo de imóvel); o IBGE não publica bairros do Tocantins nem
polígonos de quadra. Por isso a malha vem do município (planejamento urbano, endemias) ou é desenhada no editor.

## O que foi entregue

### Modelo de dados (migração `0025_territorio`)

- `localities` (código único entre as ativas), `neighborhoods` (nome único na localidade, apelidos), `blocks`
  (quarteirão: contorno GeoJSON normalizado, caixa envolvente, centro e área), `address_points` (CNEFE) e
  `territory_imports` (prévia e aplicação de cada arquivo).
- O imóvel (`households`) ganha quarteirão, sequência do reconhecimento geográfico, zona, **precisão da posição**,
  fonte, acurácia em metros e data. As posições que já existiam são marcadas como GPS em campo (fonte `legado`).
- A notificação guarda a precisão da posição da residência no retrato da ficha.
- Geometria calculada no próprio código (`packages/shared/src/territorio/geo.ts`): o PostGIS exige superusuário no
  PlanetScale. Distâncias em metros pela latitude local, suficientes na escala de um município.

### Precisão da posição

| Precisão | De onde vem | Serve ao bloqueio |
|---|---|---|
| GPS em campo | aparelho do ACS/ACE (acurácia convertida para 95%: até 20 m aceita, até 50 m com alerta, acima pede nova leitura) | sim |
| Marcado no mapa | clique no mapa do território | sim |
| Endereço (base do IBGE) | CNEFE níveis 1 a 3 (rua e número, ou quadra e lote) | sim |
| Face de quadra | CNEFE nível 4 | com aviso |
| Logradouro, localidade/bairro, setor, CEP, município | rua sem o número, centro do bairro etc. | só depois de confirmar em campo |

Uma posição nova só substitui a atual se for de precisão igual ou melhor: a geocodificação nunca desfaz um GPS.
Só as quatro primeiras ligam o imóvel ao quarteirão (tolerância de 15 m da borda, para o ponto na calçada) e só
elas vão para os geo campos 1 e 2 da ficha de notificação.

- Leitura do GPS com precisão pior que 50 m (rede, ambiente fechado) não vira a posição do imóvel, no cadastro do
  domicílio e na visita do ACS; o app só manda coordenada quando há leitura nova no aparelho.
- Endereço corrigido sem leitura nova apaga a posição que tinha vindo do endereço antigo (base do IBGE, centro de
  rua ou de bairro); GPS e marcação no mapa ficam.
- A visita do ACS com GPS num imóvel sem posição, ou com posição aproximada (rua ou bairro), grava a posição como
  GPS em campo e liga o imóvel ao quarteirão; o app avisa quando a posição é aproximada.
- A ficha de cadastro domiciliar do e-SUS leva latitude e longitude só com precisão do imóvel (as quatro primeiras);
  ligar ou desligar o quarteirão não altera o cadastro e não reenvia a ficha.
- No mapa de casos vale a residência registrada na ficha (a notificada); sem ela, o domicílio atual do paciente,
  seguindo a unificação de cadastros duplicados.

### Importação da malha

- **Formatos**: GeoJSON (com ou sem o `crs` antigo, com ou sem BOM) e shapefile compactado (.zip com .shp, .dbf,
  .prj e .cpg), até 10 MB enviados e 150 MB descompactados (zip acima disso é recusado sem abrir). Sistemas aceitos:
  WGS 84 e SIRGAS 2000 em graus e SIRGAS 2000 / UTM das zonas 17S a 25S (Gurupi está na 22S, EPSG:31982),
  reprojetados no servidor. SAD 69 e Córrego Alegre são recusados (exigem as grades de transformação do IBGE),
  venham na .prj ou no `crs` do GeoJSON (EPSG 4618, 29187 a 29195, 22521 a 22525...): o arquivo deve ser
  reprojetado para SIRGAS 2000 no QGIS antes. Coordenada fora do Brasil, arquivo em metros sem sistema e shapefile
  sem .prj (sem escolher o sistema na tela) são recusados.
- **Prévia sem efeito**: lê, valida cada feição (anel fechado, sem autointerseção, sem vértice repetido, com área,
  sentido corrigido, furos dentro do contorno; lascas de recorte e furos minúsculos saem com aviso) e sugere qual
  coluna é o número, o nome, a localidade e o bairro. Só "Aplicar" muda o território.
- **Aplicação**: localidades por código, bairros por nome ou apelido, quarteirões por localidade (+ bairro, na
  numeração por bairro) + número, este em forma única ("012" é o 12 e "12A" é o 12-A, como no editor); o código da
  localidade também ("0001" é o 1). O bairro do quarteirão vem da coluna, do bairro fixo ou do contorno do bairro;
  se o arquivo não diz, fica o que o quarteirão já tinha. Número repetido no arquivo, número inválido, bairro
  repetido e quarteirões sobrepostos são listados. Opção "malha completa" desativa os quarteirões que não vieram,
  mas só se nenhuma feição teve erro. Uma importação por vez (trava no banco; quem salva no editor durante uma
  importação recebe aviso para tentar de novo), e a aplicação interrompida pela queda do servidor pode ser refeita
  depois de 20 minutos. Ao fim, **todos os imóveis com posição são religados ao quarteirão**.
- **CNEFE**: o CSV do município (ou o .zip do IBGE) substitui a base de endereços daquele município.

### Editor de quarteirões

Desenho e edição do contorno no mapa (Leaflet-Geoman com aderência aos vértices vizinhos), número conforme a regra
da instituição, recusa de sobreposição com quarteirão existente (com folga de 20 cm para o vértice encaixado no
lado do vizinho) e de contorno que se cruza, controle de versão (quem
salva por cima de uma edição mais nova recebe conflito) e desativação com motivo. Salvar religa os imóveis do
entorno.

### Geocodificação local

"Localizar pelo endereço" tenta, em ordem: rua e número no CNEFE → quadra e lote (endereço "S/N, QD 12 LT 7") →
rua sem número (mediana da rua, se os pontos estão concentrados) → centro do bairro ou da localidade (pelo nome ou
apelido). Candidatos são filtrados pelo município, CEP e bairro; imóvel de outro município não recebe posição daqui,
e nome de bairro que existe em duas localidades não posiciona ninguém. Os pendentes são percorridos por ordem, em
lotes de até 20 mil que a tela encadeia, sem repetir sempre os mesmos. Tudo roda no servidor do OmniSaúde; cada
execução é auditada.

### Telas

- **Território** (menu; gestão e vigilância epidemiológica editam; o ACS consulta e marca a posição do imóvel;
  enfermagem e núcleo de vigilância consultam): resumo (imóveis sem posição, fora de quarteirão e percentual que
  serve ao bloqueio), mapa com quarteirões, rótulos e imóveis coloridos pela precisão, ferramenta de raio, desenho
  e edição; localidades e bairros; importação; pendências (sem posição, fora de quarteirão, posição que não serve
  ao bloqueio, com "Marcar no mapa"); configuração (numeração e raio).
- **Vigilância > Mapa de casos** (só vigilância epidemiológica e núcleo de vigilância): casos do período sem nome,
  cor por agravo, contorno tracejado quando a posição pede confirmação em campo, quarteirões com mais casos; clicar
  num caso traça o raio e lista os quarteirões atingidos.
- **Ficha da notificação**: cartão "Quarteirões no raio do bloqueio" (base da ordem de bloqueio da semana 26).

### Sigilo e acesso

- O ACS marca a posição só dos imóveis da sua equipe e microárea (e dos ainda sem equipe da sua unidade) e vê só
  esses na fila de pendências; a sequência do reconhecimento geográfico é de quem edita o território.
- O ACS também não muda a posição de imóvel fora da sua área pela edição do domicílio ou pela sincronização do app
  (o cadastro é atualizado; a posição, não).
- Localidade com quarteirões ativos não é extinta (sem eles, os bairros saem junto); bairro com quarteirões ativos
  não é desativado; bairro novo só em localidade ativa e sem o nome (sem acento) ou apelido de outro bairro ativo.

- O mapa de casos não mostra nome nem endereço; agravo sigiloso só entra para quem pode abrir a ficha (os demais
  aparecem apenas como contagem), e cada consulta é auditada com as sigilosas exibidas.
- As camadas do território não trazem moradores: só o ponto do imóvel, o endereço e a precisão.
- O fundo do mapa vem do OpenStreetMap, que recebe só as coordenadas dos ladrilhos visíveis.

## Como foi verificado

- Testes da biblioteca (`packages/shared/test/territorio.test.ts`): ponto no polígono com buraco, distância à borda,
  área, sentido, autointerseção, sobreposição, normalização, regras de numeração e de GPS.
- Testes da API (`apps/api/test/territorio.test.ts`), contra PostgreSQL real: **importar a malha GeoJSON liga cada
  domicílio ao seu quarteirão**; **um raio de 150 m devolve os quarteirões atingidos** (e 50 m só o do ponto);
  shapefile em UTM 22S com .prj reprojetado; recusa sem .prj, SAD69 e metros sem sistema; editor (sobreposição,
  número repetido, contorno cruzado, versão); posição por mapa e GPS; geocodificação pelo CNEFE; mapa de casos
  recusado para médica e ACS; quarteirões do caso; configuração e resumo.
- No navegador (build de produção, mapa do OpenStreetMap): a gestora cadastra a localidade e dois bairros (um com
  apelido), importa 30 quarteirões e vê os 11 imóveis ligados, traça o raio de 150 m (8 quarteirões), desenha o
  quarteirão 31, importa uma amostra do CNEFE, localiza 2 imóveis pelo endereço (um por endereço, outro só pela rua,
  que vai para "posição que não serve ao bloqueio") e marca o segundo no mapa (100% servindo ao bloqueio). A
  vigilância abre o mapa de casos, clica num caso de dengue e vê os quarteirões a até 150 m; a ficha mostra o mesmo
  cartão. A médica não vê a aba nem o menu (API devolve 403).

## Pontos de atenção

- A malha real (bairros e quarteirões) é da instituição; sem ela, o território é desenhado no editor.
- Imóveis sem posição não entram no quarteirão nem no raio; a fila de pendências mostra quantos são.
- Distâncias com aproximação plana local (erro desprezível na escala de 150 m a 1 km).
- A base do CNEFE tem 2022 como referência: loteamentos novos não estão nela.
- O mapa de casos traz até 5.000 notificações por consulta (aviso na tela para encurtar o período).
