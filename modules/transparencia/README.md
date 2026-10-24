# Módulo Transparência (PNTP/Atricon): prefeituras do Tocantins

Painel dos resultados do Programa Nacional de Transparência Pública para as 139 prefeituras do Tocantins, com o caminho de cada uma até o **Selo Diamante** e um simulador de nota. Feito para entrar no `mm.api.br` com o mesmo visual do site.

Plano, pesquisa e fases: [`docs/TRANSPARENCIA-MODULO-PLANO.md`](../../docs/TRANSPARENCIA-MODULO-PLANO.md).

## Telas

| Rota | O que mostra |
|---|---|
| `#/` Panorama | Selos por ciclo, quem está mais perto do Diamante, o que mais falha no estado e o aviso do próximo ciclo |
| `#/municipios` Prefeituras | As 139, com busca, filtro por nível, ordenação e **CSV** |
| `#/municipio/<ibge>` Ficha | Placar, histórico 2023–2025, câmara e **simulador**: marque critérios a corrigir e veja índice e nível projetados |
| `#/criterios` Critérios | Quantas prefeituras falham em cada critério e o ganho médio de corrigi-lo |
| `#/metodologia` Metodologia | Níveis, essenciais, pesos, fontes e limites |

## Rodar

Sem dependências (HTML, CSS e JS puros). Sirva a pasta por HTTP, porque a página busca `dados/transparencia-to.json`:

```bash
cd modules/transparencia
python3 -m http.server 8080      # abra http://localhost:8080/
```

## Atualizar os dados

Tudo vem de arquivos públicos. Para um novo ciclo (o de 2026 sai em novembro) baixe os pacotes e gere o JSON:

```bash
# base de cada ciclo: https://pntp.atricon.org.br/dados-abertos/  (avaliacoes_pntp_ANO.xlsx e respostas/respostas_pntp_ANO_TO.xlsx)
# entes: https://apidatalake.tesouro.gov.br/ords/siconfi/tt/entes
# matriz do próximo ciclo: "Matriz de critérios" na mesma página
pip install pandas openpyxl
python3 build_dados.py \
  --ciclo 2023=avaliacoes_pntp_2023.xlsx --ciclo 2024=avaliacoes_pntp_2024.xlsx --ciclo 2025=avaliacoes_pntp_2025.xlsx \
  --respostas 2025=respostas_pntp_2025_TO.xlsx \
  --entes entes.json --matriz 2026=matriz.xlsx \
  --saida dados/transparencia-to.json
```

O script confere o formato da base (para se ela mudar) e imprime quão bem o índice reproduzido bate com o oficial. A Atricon avisa que o esquema das planilhas muda entre ciclos; ao entrar o ciclo 2026, confira os nomes das colunas.

## Conferências feitas (dados de 24/10/2026)

- **Índice reproduzido x oficial** (a partir das respostas critério a critério e da fórmula da Cartilha PNTP 2026): erro médio de **0,01 ponto**; 138 das 139 prefeituras idênticas ao oficial. Exceção: Jaú do Tocantins, 99,10% oficial contra 98,56% reproduzido.
- **Regra de nível x nível oficial** (95/85/75% e 100% dos essenciais): 830 de 834 avaliações (3 ciclos, prefeituras e câmaras) coincidem. Os 4 desvios: 3 casos "Não Avaliado" (sem avaliação, índice 0) e 1 câmara com 100% rebaixada para "Elevado" pela revisão.
- Teste no Chromium sob a **mesma política de segurança do site** (`script-src 'self'`, sem CDN, sem script inline): sem erros de console, nas três aparências e em tela de celular.

## Visual e integração com o mm.api.br

- O CSS do site é entregue inline na tela de login (a política só aceita `style-src 'unsafe-inline'`). `index.html` leva um **recorte** dele (as classes que o módulo usa, ~20 KB) entre `/* mm-base:início */` e `/* mm-base:fim */`, mais um bloco `tr-*` com o que o site ainda não tem. Para atualizar o recorte quando o site mudar:

  ```bash
  curl -sL https://mm.api.br/login -o login.html
  python3 tools/extrai_css_base.py login.html
  ```

- Aparências: **Claro** e **Escuro** (`data-estilo="moderno"`) e **Terminal** (âmbar sobre preto), como no site. O seletor do topo é só da página de teste; no site vale a aparência da conta.
- O topo (`header.topbar`) e o rodapé de `index.html` são substitutos: no site, o módulo é o conteúdo de `<main id="tr-app">` mais `transparencia.js` e o JSON, dentro do layout dele.
- Cartão sugerido para a home de módulos. Derivado das classes do CSS: **confira com a marcação real da home**, que eu não vi (exige login).

  ```html
  <a class="card" href="/transparencia/">
    <div class="card-top"><span class="card-sigla">TR</span><span class="card-tag">Módulo</span></div>
    <h3 class="card-nome">Transparência</h3>
    <p class="card-desc">Selo Diamante (PNTP/Atricon) das 139 prefeituras do Tocantins.</p>
    <span class="card-foot">Atricon · ciclo 2025</span>
  </a>
  ```

## Limites

- O resultado oficial é o do Radar da Transparência Pública. Este painel o reorganiza e simula; não o substitui.
- A projeção do simulador usa as **respostas de 2025** e a fórmula da Cartilha **2026**. A matriz 2026 tem 96 critérios para prefeituras (12 essenciais) contra 91 critérios (11 essenciais) em 2025; o resultado de 2026 pode diferir.
- Só mede o que o tribunal validou. Não verifica se a informação está atual hoje (isso é a "sonda" da Fase 2 do plano).
- Em 2024, 20 prefeituras aparecem como "Inexistente" (índice 0%). Pela Cartilha, esse é o resultado de quem não tem sítio oficial próprio ou o tem fora do ar nas tentativas de avaliação (critério 1.1, que prejudica todos os demais); não verifiquei o motivo em cada caso. A variação para 2025 dessas fica muito alta.
- No tema Terminal, Diamante e Elevado têm a mesma cor (âmbar); o rótulo de texto distingue.
- O simulador usa só as respostas de 2025. As respostas de 2023 e 2024 não são lidas: dessas, o painel usa apenas índice, nível e essenciais.
