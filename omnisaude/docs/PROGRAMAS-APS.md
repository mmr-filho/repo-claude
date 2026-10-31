# Programas da APS e estratificações de risco

A tela **Programas APS** lista, por unidade ou equipe, quem está em acompanhamento em cada programa, o que
está em atraso e a próxima ação. As faltas são as mesmas boas práticas que pontuam nos indicadores do
cofinanciamento (`docs/INDICADORES-APS.md`), mais as ações programáticas que o cofinanciamento não mede.
De cada linha é possível abrir um caso de **busca ativa** (serviço social) e aplicar a **estratificação de
risco** do programa.

## Programas

| Programa | População | Faltas apuradas | Indicador | Linha de busca ativa |
|---|---|---|---|---|
| Pré-natal e puerpério | gestantes (condição de gestação; a DUM é o início da condição) e puérperas até 42 dias | captação até 12 semanas; consulta em atraso pelo intervalo da idade gestacional (30, 15 e 7 dias); classificação de risco; exames do 1º e 3º trimestres; dTpa; atendimento odontológico; consulta puerperal | C3 | GESTANTE |
| Puericultura | crianças até 2 anos | consultas previstas por idade (1ª semana, 1, 2, 4, 6, 9, 12, 18 e 24 meses); antropometria semestral; doses do calendário vacinal em atraso; M-CHAT-R entre 16 e 30 meses | C2 | CRIANCA |
| Hipertensão e diabetes | condição ativa de HAS ou DM | consulta e PA semestrais, antropometria e hemoglobina glicada anuais, avaliação do pé; estratificação do pé diabético em dia | C4, C5 | HIPERTENSAO, DIABETES |
| Pessoa idosa | 60 anos ou mais | consulta e antropometria anuais, influenza | C6 | IDOSO |
| Preventivo e mamografia | sexo feminino de 9 a 69 anos | citopatológico (25–64), mamografia (50–69), HPV (9–14), saúde sexual e reprodutiva (14–69) | C7 | MULHER |
| Bolsa Família | beneficiários marcados no cadastro: crianças até 7 anos, gestantes e mulheres de 14 a 44 | peso e altura na vigência (jan–jun, jul–dez); vacinas das crianças; pré-natal das gestantes | — | BOLSA_FAMILIA |
| SISVAN | crianças até 5 anos, gestantes, pessoas idosas e adultos com antropometria | antropometria no prazo (6 meses, 1 mês, 12 meses); estado nutricional pelo IMC (adultos e idosos) com alerta de baixo peso ou obesidade | — | SISVAN |
| Tuberculose e hanseníase | condição ativa (CID A15–A19, A30) | consulta mensal; tratamento além da previsão de alta (TB 6 meses; hanseníase PB 6 meses, MB 12 meses) | — | TUBERCULOSE, HANSENIASE |

As visitas domiciliares do ACS entram nas faltas desde o app do ACS (APS-3): no pré-natal (3 após a 1ª
consulta, cobradas a partir da 20ª semana, e 1 no puerpério), na puericultura (1ª até 30 dias e 2ª até 6
meses de vida) e, em HAS/DM e pessoa idosa, pela boa prática de visita do indicador (2 por ano com 30 dias de
intervalo). As atividades coletivas (escovação, grupos) chegam com APS-7.

## Estratificações de risco

| Instrumento | Onde se aplica | Resultado | Efeito |
|---|---|---|---|
| Risco gestacional (CAB 32 e Manual de Gestação de Alto Risco) | pré-natal, na 1ª consulta e quando mudar | alto risco (qualquer fator de encaminhamento) ou risco habitual, com os fatores de atenção marcados | aparece na lista do pré-natal; orientação de encaminhamento |
| Risco do pé diabético (Manual do pé diabético, MS 2016) | pessoas com diabetes, anual ou pelo grau | grau 0 (anual), 1 (3 a 6 meses), 2 (2 a 3 meses), 3 (1 a 2 meses) | registra o procedimento 03.01.04.009-5 na produção, o que pontua a boa prática F do indicador C4; a lista cobra a reavaliação na data prevista |
| M-CHAT-R (Robins, Fein e Barton, 2009) | crianças de 16 a 30 meses | baixo (0–2), médio (3–7, aplicar a entrevista de seguimento), alto (8–20, encaminhar); itens 2, 5 e 12 pontuam no "sim" | aparece na puericultura; a criança sem triagem na faixa etária fica com pendência |

Os instrumentos ficam em `packages/shared/src/aps-programas.ts` (critérios, itens e pontuação) e são
aplicados pela tela de programas ou pelo cadastro do paciente (card *Estratificações de risco*).

## Fontes e limites

- Consultas: registros SOAP/evolução assinados por médicos e enfermeiros. PA, peso e altura: classificação de
  risco/acolhimento. Exames: solicitados ou com resultado. Vacinas: código do imunobiológico ou nome.
- O vínculo é o do cadastro domiciliar (unidade ou equipe do domicílio).
- A lista de faltosos é um instrumento de gestão do cuidado; os registros oficiais continuam sendo as fichas
  do e-SUS e o Siaps.
- O acesso às listas nominais fica registrado na auditoria.
