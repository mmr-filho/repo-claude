# Vacinas: sala de vacina, calendário, estoque por lote e RNDS

A tela **Vacinas** reúne a sala de vacina (cartão, aplicação e certificado), a agenda de aprazamentos, os
faltosos, o estoque de imunobiológicos por lote e o Calendário Nacional de Vacinação.

## Calendário e aprazamento

O calendário (`packages/shared/src/vacinas.ts`) cobre a rotina da criança (0 a 24 meses e reforços dos 4
anos), do adolescente (HPV, meningocócica ACWY), do adulto (hepatite B, dT em 3 doses e reforço a cada 10
anos, tríplice viral, febre amarela), da pessoa idosa (influenza e covid-19 anuais) e da gestante (dTpa a
partir da 20ª semana e influenza). Cada regra traz o componente, a dose, o código de dose do e-SUS, a idade
mínima, a idade máxima quando existe, o intervalo mínimo desde a dose anterior e a periodicidade.

O **aprazamento** parte das doses registradas (qualquer vacina com o componente conta: a penta vale para
DTP, hepatite B e Hib) e devolve, para cada regra aplicável à pessoa, se a dose está aplicada, aprazada
(com a data prevista) ou atrasada (prevista há mais de 30 dias). Doses de tríplice viral e varicela antes
dos 12 meses não contam. As doses infantis têm idade máxima (rotavírus até 3 e 7 meses; BCG, VIP, pneumo,
meningo C e hepatite A até 4 anos; penta/DTP, hepatite B e varicela até 6 anos), de modo que o adulto sem
caderneta recebe só o esquema do adulto. Quando uma dose está pendente, a seguinte é prevista a partir dela
mais o intervalo mínimo (cobra-se uma dose de cada vez). Para a gestante, a DUM é o início da condição de
gestação no cadastro.

## Sala de vacina

- O **cartão** mostra as doses registradas (lote, fabricante, validade, via, local, estratégia, unidade,
  profissional e situação na RNDS) e o aprazamento com as próximas doses.
- **Aplicar dose**: escolhe-se o lote no estoque da unidade (a sala de vacina tem prioridade), a dose, a
  estratégia, a via e o local. A dose sai do lote no mesmo ato (movimento `ADMINISTRACAO` com referência
  à vacinação); lote vencido, incompatível ou sem saldo é recusado e nada é gravado.
- **Transcrição da caderneta**: dose aplicada em outro serviço, informada com o lote da caderneta. Não
  mexe no estoque nem vai à RNDS; aparece no cartão e no certificado como transcrita.
- **Certificado de vacinação** em PDF, com todas as doses. Pode ser assinado com o certificado ICP-Brasil
  do profissional (Minha conta) e conferido em *Validar documento*; cada nova assinatura gera uma versão.

## Estoque por lote

Produtos com código de imunobiológico (`products.vaccine_code`) são vacinas. Os lotes entram pela nota
fiscal ou pela carga da farmácia e ficam no local de estoque da unidade do tipo **sala de vacina**. A tela
lista os lotes com saldo, validade e fabricante.

## RNDS (Registro de Imunobiológico Administrado)

Cada dose aplicada vai para o outbox `RNDS_IMUNIZACAO` e é enviada pelo job de integração como RIA
(perfis `BRRegistroImunobiologicoAdministrado-2.0` e `BRImunobiologicoAdministrado-2.0`) com os códigos
do imunobiológico, da dose, da via, do local de aplicação e do fabricante, mais lote e validade. A situação
(pendente, enviado, erro) aparece no cartão. Em homologação é preciso o credenciamento da RNDS
(`docs/RNDS.md`); sem ele, a demonstração usa o simulador local, que valida o bundle.

## Faltosos e aprazamentos

- **Faltosos**: pessoas vinculadas à unidade ou à equipe com doses atrasadas (uma pendência por componente).
- **Aprazamentos**: doses previstas num intervalo de datas, para organizar a agenda e os lembretes.

As doses registradas aqui alimentam a ficha de vacinação do e-SUS (`docs/ESUS.md`), a boa prática E do
indicador C2, a influenza do C6 e a HPV do C7 (`docs/INDICADORES-APS.md`) e as pendências da puericultura
(`docs/PROGRAMAS-APS.md`).

## Limites

- A rede de frio (temperatura das geladeiras) e as perdas por abertura de frasco multidose não entram nesta
  entrega.
- O calendário não cobre grupos especiais (CRIE) nem campanhas extraordinárias; a estratégia pode ser
  informada na aplicação.
