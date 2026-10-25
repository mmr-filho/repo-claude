#!/usr/bin/env python3
"""
Copia para o index.html as regras do CSS do mm.api.br que o módulo realmente usa.

O site entrega o CSS inline na própria página (a política de segurança só aceita style-src 'unsafe-inline'),
então o módulo leva um recorte dele. Rode de novo quando o visual do site mudar:

  curl -sL https://mm.api.br/login -o login.html
  python3 tools/extrai_css_base.py login.html                                   # este módulo
  python3 tools/extrai_css_base.py login.html ../transferencias                 # outro módulo (pasta)

Mantém uma regra se algum de seus seletores só usa classes que aparecem no index.html ou nos .js da pasta.
"""
import os
import re
import sys

AQUI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INICIO, FIM = '/* mm-base:início */', '/* mm-base:fim */'


def regras(css):
    """Divide o CSS em (prelúdio, corpo) no nível de cima, respeitando chaves aninhadas e strings."""
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
    saida, prof, ini_prel, ini_corpo, asp, prel = [], 0, 0, 0, None, ''
    for i, ch in enumerate(css):
        if asp:
            if ch == asp:
                asp = None
        elif ch in '"\'':
            asp = ch
        elif ch == '{':
            if prof == 0:
                prel, ini_corpo = css[ini_prel:i].strip(), i + 1
            prof += 1
        elif ch == '}':
            prof -= 1
            if prof == 0:
                saida.append((prel, css[ini_corpo:i]))
                ini_prel = i + 1
        elif ch == ';' and prof == 0:
            ini_prel = i + 1
    return saida


def seletores(prel):
    """Separa a lista de seletores nas vírgulas de fora de parênteses e colchetes."""
    partes, atual, nivel = [], '', 0
    for ch in prel:
        if ch in '([':
            nivel += 1
        elif ch in ')]':
            nivel -= 1
        if ch == ',' and nivel == 0:
            partes.append(atual.strip())
            atual = ''
        else:
            atual += ch
    partes.append(atual.strip())
    return [p for p in partes if p]


def filtra(css, usadas):
    out = []
    for prel, corpo in regras(css):
        if prel.startswith('@keyframes'):
            if prel.split()[1] in usadas_keyframes:
                out.append(f'{prel}{{{corpo}}}')
        elif prel.startswith('@media') or prel.startswith('@supports'):
            interno = filtra(corpo, usadas)
            if interno.strip():
                out.append(f'{prel}{{\n{interno}\n}}')
        elif prel.startswith('@'):
            continue
        else:
            ok = [s for s in seletores(prel) if set(re.findall(r'\.(-?[_a-zA-Z][\w-]*)', s)) <= usadas and '#' not in s]
            if ok:
                out.append(f'{",".join(ok)}{{{corpo.strip()}}}')
    return '\n'.join(out)


usadas_keyframes = {'blink'}

if __name__ == '__main__':
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    if len(sys.argv) == 3:
        AQUI = os.path.abspath(sys.argv[2])
    html = open(sys.argv[1], encoding='utf-8').read()
    css = re.search(r'<style>(.*?)</style>', html, re.S).group(1)
    todas = set(re.findall(r'\.(-?[_a-zA-Z][\w-]*)', re.sub(r'/\*.*?\*/', '', css, flags=re.S)))
    arquivos = ['index.html'] + sorted(f for f in os.listdir(AQUI) if f.endswith('.js'))
    texto = ''.join(open(os.path.join(AQUI, f), encoding='utf-8').read() for f in arquivos)
    texto = re.sub(re.escape(INICIO) + '.*?' + re.escape(FIM), '', texto, flags=re.S)  # não contar o recorte anterior
    usadas = (set(re.findall(r'[A-Za-z][\w-]*', texto)) & todas)
    recorte = filtra(css, usadas)
    destino = os.path.join(AQUI, 'index.html')
    pagina = open(destino, encoding='utf-8').read()
    novo = re.sub(re.escape(INICIO) + '.*?' + re.escape(FIM), lambda _: f'{INICIO}\n{recorte}\n{FIM}', pagina, flags=re.S)
    open(destino, 'w', encoding='utf-8').write(novo)
    print(f'{len(usadas)} classes em uso, {len(recorte):,} caracteres de CSS do site em {destino}')
