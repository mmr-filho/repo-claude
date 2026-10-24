# Módulo Transparência (PNTP/Atricon): panorama e plano de ação por prefeitura

Para **uma prefeitura do Tocantins de cada vez**: a situação no Programa Nacional de Transparência Pública, explicada para o prefeito, e o **plano de ação** para chegar aos critérios do selo (Prata, Ouro ou Diamante). Feito para entrar no `mm.api.br` com o mesmo visual do site.

Pesquisa, regras do programa e fases: [`docs/TRANSPARENCIA-MODULO-PLANO.md`](../../docs/TRANSPARENCIA-MODULO-PLANO.md).

## Telas

| Rota | O que mostra |
|---|---|
| `#/` | Escolha do município (busca; lembra o último) |
| `#/m/<ibge>` **Panorama** | Resultado oficial, diagnóstico em uma frase, estimativa nas regras do novo ciclo, alerta dos essenciais, o que muda para essa prefeitura, onde ela perde pontos, histórico, próximos passos, câmara |
| `#/m/<ibge>/plano` **Plano de ação** | Meta (Diamante, Ouro, Prata) e etapas; cada ação com o que falta, observação do tribunal, links (página avaliada, print, Cartilha), o que a Cartilha exige, ganho e setor sugerido; agrupar por setor; marcar como concluída; CSV |
| `#/m/<ibge>/checklist` **Checklist** | Os critérios da matriz com a situação de cada um: atende, pendente, a conferir |
| `#/m/<ibge>/relatorio` **Relatório** | Versão para imprimir ou salvar em PDF |
| `#/metodologia` | Regras, essenciais, cálculo, como o plano é montado, limites |

## Rodar

Sem dependências (HTML, CSS e JS puros). Sirva a pasta por HTTP, porque a página busca os arquivos de `dados/`:

```bash
cd modules/transparencia
python3 -m http.server 8080      # abra http://localhost:8080/
```

## Dados

| Arquivo | Conteúdo |
|---|---|
| `dados/municipios.json` | As 139 prefeituras (para a escolha) e metadados dos ciclos |
| `dados/criterios.json` | Os 96 critérios da matriz 2026 que valem para a prefeitura: classe, itens, pontos no índice, de qual critério de 2025 vieram, fundamentação, orientação e página da Cartilha |
| `dados/m/<ibge>.json` | Por prefeitura: resultados oficiais 2023–2025 (prefeitura e câmara), estimativa nas regras de 2026, pontos por dimensão e cada pendência (itens que falham, ganho, observação do tribunal, link da página avaliada e do print) |

### Atualizar

Tudo vem de arquivos públicos. Para um novo ciclo, baixe os pacotes e gere de novo:

```bash
# base de cada ciclo e respostas por UF:  https://pntp.atricon.org.br/dados-abertos/
# matriz e Cartilha do ciclo-alvo:        mesma página ("Metodologia")
# entes (população, CNPJ):                https://apidatalake.tesouro.gov.br/ords/siconfi/tt/entes
pip install pandas openpyxl
pdftotext -layout Cartilha-PNTP-2026.pdf cartilha.txt          # poppler-utils
python3 build_dados.py \
  --ciclo 2023=avaliacoes_pntp_2023.xlsx --ciclo 2024=avaliacoes_pntp_2024.xlsx --ciclo 2025=avaliacoes_pntp_2025.xlsx \
  --respostas 2025=respostas_pntp_2025_TO.xlsx \
  --matriz 2026="Matriz de Critérios 2026 (Final).xlsx" \
  --cartilha cartilha.txt --cartilha-url https://cdn.atricon.org.br/2026/08/Cartilha-PNTP-2026.pdf \
  --entes entes.json --saida dados
```

O gerador:

- **confere a fórmula**: aplica a fórmula da Cartilha às respostas e compara com o índice oficial (hoje: erro médio de 0,01 ponto; 138 de 139 prefeituras idênticas, a exceção é Jaú do Tocantins, com 0,54 ponto de diferença);
- **liga os critérios entre ciclos pelo texto**, porque a numeração muda, e imprime a tabela de ligações para revisão. Para 2025 → 2026 ela foi conferida à mão: desdobramentos (6.2 → 6.2 e 6.3; 17.1 → 17.1 e 17.2), deslocamentos (6.3–6.6 → 6.4–6.7; 17.2 → 17.3) e 3 critérios novos (18.6, 19.3, 19.4);
- falha com mensagem clara se o formato da base mudar (a Atricon avisa que o esquema muda entre ciclos).

## Como o plano é montado

1. A situação de cada critério de 2026 vem das respostas **validadas** de 2025 (revisão da Atricon > validação do TCE-TO > autoavaliação).
2. A estimativa usa os **pesos de 2026** e conta como pendente o que não foi avaliado em 2025: é conservadora.
3. Etapas: **essenciais** (sem eles não há selo); o **menor caminho até a meta** (critérios de maior ganho); **critérios novos a conferir**; **demais pendências** (margem de segurança).
4. O setor responsável é uma sugestão por dimensão (`SETOR` em `transparencia.js`).

## Visual e integração com o mm.api.br

- O CSS do site é entregue inline na tela de login (a política só aceita `style-src 'unsafe-inline'`). `index.html` leva um **recorte** dele (as classes que o módulo usa, ~21 KB) entre `/* mm-base:início */` e `/* mm-base:fim */`, mais um bloco `tr-*` com o que o site ainda não tem, inclusive o estilo de impressão. Para atualizar o recorte quando o site mudar:

  ```bash
  curl -sL https://mm.api.br/login -o login.html
  python3 tools/extrai_css_base.py login.html
  ```

- Aparências: **Claro** e **Escuro** (`data-estilo="moderno"`) e **Terminal** (âmbar sobre preto), como no site. O seletor do topo é só da página de teste; no site vale a aparência da conta.
- O topo e o rodapé de `index.html` são substitutos: no site, o módulo é o conteúdo de `<main id="tr-app">` mais `transparencia.js` e a pasta `dados/`, dentro do layout dele.
- Testado no Chromium sob a **mesma política de segurança do site**: sem erros de console, nas três aparências, em tela de celular (sem rolagem horizontal) e em modo de impressão.
- Cartão sugerido para a home de módulos. Derivado das classes do CSS: **confira com a marcação real da home**, que exige login.

  ```html
  <a class="card" href="/transparencia/">
    <div class="card-top"><span class="card-sigla">TR</span><span class="card-tag">Módulo</span></div>
    <h3 class="card-nome">Transparência</h3>
    <p class="card-desc">Situação da prefeitura no PNTP (Atricon) e plano de ação até o selo.</p>
    <span class="card-foot">Atricon · Tocantins</span>
  </a>
  ```

## Limites

- O resultado oficial é o do Radar da Transparência Pública. O módulo ajuda a preparar a autoavaliação; não a substitui.
- Mostra o que o tribunal validou em 2025. Não confere se o portal mudou depois disso.
- As marcações de "concluída" ficam no navegador (`localStorage`); para o gabinete acompanhar em equipe, precisam ir para o servidor do site.
- No tema Terminal, Diamante e Elevado têm a mesma cor (âmbar); o rótulo de texto distingue.
- Em 2024, 20 prefeituras aparecem como "Inexistente" (índice 0%). Pela Cartilha, é o resultado de quem não tem sítio oficial próprio ou o tem fora do ar (critério 1.1); o motivo não foi verificado caso a caso.
