# Indicadores do cofinanciamento da APS (componente de qualidade)

A tela **Indicadores APS** apura, por equipe e competência, os 15 indicadores do componente de qualidade do
cofinanciamento federal da Atenção Primária (Portaria GM/MS 3.493/2024, alterada pelas Portarias 6.907/2025 e
7.799/2025), mostra o resultado do quadrimestre, a nota final, a classificação, quem falta em cada boa prática e
a projeção do repasse.

## Base normativa usada

| Documento | O que define | Onde está no sistema |
|---|---|---|
| Nota Técnica nº 8/2026-DEAPS/SAPS/MS (revoga a NT 6/2025) | média dos meses do quadrimestre; pontos por conceito (Regular 0,25, Suficiente 0,50, Bom 0,75, Ótimo 1,00); pesos; faixas da nota final (> 7,5 Ótimo; 5 a 7,5 Bom; > 2,5 e < 5 Suficiente; ≤ 2,5 Regular) | `packages/shared/src/aps-indicadores.ts` |
| Notas metodológicas C1 a C7, B1 a B6, M1 e M2 (versões de 2026) | numerador, denominador, boas práticas e pontos, parâmetros, códigos CBO, CID-10, CIAP-2, SIGTAP e de vacinas | idem (fichas) e `apps/api/src/modules/indicators/indicators-calc.ts` (apuração) |
| Portaria GM/MS 7.799/2025, anexo XCIX-B | valor mensal por classificação e modalidade da equipe | `VALOR_QUALIDADE` |

As fichas técnicas completas, com os links das notas metodológicas, estão na aba **Fichas técnicas** da tela.

## Como a apuração funciona

- **Vínculo**: pessoa vinculada à equipe = cadastrada em domicílio cuja equipe (INE) é a avaliada. Para o
  cofinanciamento oficial o Ministério usa as regras da Nota Técnica 30/2025 (atendimentos e cadastro); aqui o
  vínculo é o do cadastro domiciliar.
- **Mês**: cada indicador é calculado por mês do quadrimestre, com corte no fim do mês (ou agora, no mês
  corrente). O resultado do quadrimestre é a média dos meses com resultado.
- **C2 e C3** avaliam a coorte que fechou o acompanhamento no mês: crianças que completaram dois anos e
  gestações cujo puerpério (42 dias) terminou. Nos meses sem coorte não há resultado, como na NT 8/2026.
- **Gestação**: identificada pelas condições do cadastro (linha de cuidado gestante ou CID-10/CIAP-2 da nota).
  A **DUM é a data de início da condição**; sem desfecho registrado, a gestação encerra em 294 dias. O
  desfecho é registrado em *Paciente › Condições › Encerrar* (data do parto/desfecho). Aborto registrado
  exclui a gestação.
- **Diabetes e hipertensão**: condições ativas com os códigos da nota (ou a linha de cuidado). Condição
  encerrada sai do denominador a partir da data do desfecho.
- **Consultas**: registros SOAP/evolução assinados por médicos (CBO 2231, 2251, 2252, 2253) ou enfermeiros
  (2235). PA, peso e altura vêm da classificação de risco/acolhimento (mesmo dia). Exames contam quando
  solicitados ou com resultado na janela. Vacinas pelo código do imunobiológico ou pelo nome.
- **C1**: demanda programada = atendimento com agendamento; sem agendamento conta como espontânea.
- **Nota estimada**: indicadores sem população ou sem fonte não entram na nota; a nota é reescalada para 10 e
  marcada como estimada na tela.
- **Projeção do repasse**: valor mensal pela classificação e modalidade da equipe (definida em
  *Administração › Equipes*), total do próximo quadrimestre (4 parcelas) e quanto aumenta se a equipe subir
  um nível.

As **visitas domiciliares do ACS/TACS** (C2-D, C3-E e J, C4-D, C5-D, C6-C) são apuradas a partir das visitas
com desfecho "realizada" e CBO 5151xx registradas no app do ACS (`docs/ACS.md`); para eAP a pontuação
continua integral, como na nota.

## O que ainda não é apurado (e de onde virá)

| Boa prática / indicador | Pontos em jogo | Fonte prevista |
|---|---|---|
| Escovação supervisionada (B4), atividades coletivas (M1), ações coletivas compartilhadas e compartilhamento do cuidado (M2) | — | grupos e atividade coletiva (APS-7) |
| Primeira consulta odontológica, tratamento concluído e procedimentos da eSB (B1 a B6) | — | a apuração lê a produção SIGTAP e o odontograma; a tela de atendimento odontológico chega depois |

Na tela, cada boa prática mostra se é *apurada no sistema*, *apurada em parte* ou *sem fonte ainda*.

## Conferência manual

O teste `apps/api/test/indicators.test.ts` monta uma equipe de teste com registros conhecidos e confere os
números contra o cálculo manual (C1 a C7, nota final, classificação e valor). Para conferir uma equipe real:
abra a equipe na tela, veja numerador/denominador de cada mês e a lista *Quem falta* com os pontos de cada
pessoa; a soma dos pontos dividida pelo número de pessoas avaliadas é o resultado do mês.

## Limitações conhecidas

- O Siaps usa as regras oficiais de vínculo (NT 30/2025) e dados de todo o país; aqui só entram registros do
  próprio sistema. Os números servem para gestão e busca ativa, não substituem o resultado do Ministério.
- Pessoas trans são consideradas pelo sexo do cadastro (C7).
- eSB com carga horária de 20h vinculada a eSF deveria ter o denominador de B1 dividido por 2; a modalidade
  de carga horária da eSB ainda não é cadastrada.
