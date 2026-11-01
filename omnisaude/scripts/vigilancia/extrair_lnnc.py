#!/usr/bin/env python3
"""
Extrai a Lista Nacional de Notificação Compulsória (Anexo 1 do Anexo V da PRC GM/MS nº 4/2017) do HTML
compilado da BVS, nas redações indicadas, e grava um JSON com o hash da fonte.

Uso: python3 scripts/vigilancia/extrair_lnnc.py <prc0004_03_10_2017.html> <saida.json>

A tabela tem as colunas Nº, Doença ou agravo, Imediata (até 24 horas) para MS, SES e SMS, e Semanal.
Itens com subitens usam células mescladas (rowspan) no número. O extrator monta a grade completa
(rowspan/colspan) e lê cada marca 'X' célula por célula.
"""
import hashlib, html, json, re, sys
from html.parser import HTMLParser


class Tabelas(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tabelas = []  # lista de (inicio, linhas); linha = lista de (texto, rowspan, colspan)
        self.pilha = []
        self.celula = None
        self.linha = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'table':
            self.pilha.append([])
        elif tag == 'tr' and self.pilha:
            self.linha = []
        elif tag in ('td', 'th') and self.pilha is not None and self.linha is not None:
            self.celula = {'t': [], 'rs': int(a.get('rowspan') or 1), 'cs': int(a.get('colspan') or 1)}
        elif tag == 'br' and self.celula is not None:
            self.celula['t'].append(' ')

    def handle_endtag(self, tag):
        if tag in ('td', 'th') and self.celula is not None and self.linha is not None:
            texto = re.sub(r'\s+', ' ', ''.join(self.celula['t'])).strip()
            self.linha.append((texto, self.celula['rs'], self.celula['cs']))
            self.celula = None
        elif tag == 'tr' and self.linha is not None and self.pilha:
            self.pilha[-1].append(self.linha)
            self.linha = None
        elif tag == 'table' and self.pilha:
            t = self.pilha.pop()
            self.tabelas.append(t)

    def handle_data(self, data):
        if self.celula is not None:
            self.celula['t'].append(data)


def grade(linhas):
    """Expande rowspan/colspan numa matriz de textos."""
    ocup = {}
    out = []
    for r, linha in enumerate(linhas):
        c = 0
        row = []
        for texto, rs, cs in linha:
            while (r, c) in ocup:
                row.append(ocup.pop((r, c)))
                c += 1
            for k in range(cs):
                row.append(texto)
                for j in range(1, rs):
                    ocup[(r + j, c + k)] = texto
                c += 1
        while (r, c) in ocup:
            row.append(ocup.pop((r, c)))
            c += 1
        out.append(row)
    return out


def tabela_da_redacao(raw, ato):
    """HTML da tabela do Anexo 1 cujo título traz 'Redação dada pela PRT GM/MS nº <ato>' logo abaixo."""
    for m in re.finditer(r'ANEXO 1 DO ANEXO V', raw):
        cabeca = raw[m.start():m.start() + 800]
        ini = raw.find('<table', m.start())
        if ato in cabeca and ini != -1 and ini - m.start() < 1500:
            fim = raw.find('</table>', ini) + len('</table>')
            return raw[ini:fim]
    raise SystemExit(f'Título do Anexo 1 na redação {ato} não encontrado')


def extrair(raw, ato):
    p = Tabelas()
    p.feed(tabela_da_redacao(raw, ato))
    g = grade(p.tabelas[-1])
    linhas = []
    for row in g:
        if len(row) < 6:
            continue
        num, nome, ms, ses, sms, sem = [x.strip() for x in row[:6]]
        if not re.match(r'^\d+$', num):
            continue
        linhas.append({'numero_bruto': num, 'nome': nome, 'MS': ms.upper() == 'X', 'SES': ses.upper() == 'X', 'SMS': sms.upper() == 'X', 'SEMANAL': sem.upper() == 'X', 'celulas': [ms, ses, sms, sem]})
    return linhas


if __name__ == '__main__':
    fonte, saida = sys.argv[1], sys.argv[2]
    dados = open(fonte, 'rb').read()
    raw = dados.decode('latin-1')
    res = {'fonte': 'https://bvsms.saude.gov.br/bvs/saudelegis/gm/2017/prc0004_03_10_2017.html', 'sha256': hashlib.sha256(dados).hexdigest(), 'redacoes': {}}
    for ato in ('11.211', '10.175'):
        res['redacoes'][ato] = extrair(raw, ato)
    json.dump(res, open(saida, 'w'), ensure_ascii=False, indent=1)
    for ato, ls in res['redacoes'].items():
        print(ato, 'linhas:', len(ls), 'itens:', len({l['numero_bruto'] for l in ls}))
