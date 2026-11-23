#!/usr/bin/env python3
"""
Camada 3 (RAG), preparação: baixa as normas de corpus/fontes.json no normas.leg.br (Senado Federal) e as fatia
preservando a hierarquia Norma > Título/Capítulo/Seção > Artigo > Parágrafo. Grava dados/rag/chunks.json.

Cada artigo vira um trecho; artigo longo é dividido nos parágrafos, e cada pedaço leva o caput como contexto.
Dispositivos revogados ou vetados ficam de fora. Portarias e manuais que não estão no normas.leg.br entram como
texto em corpus/locais/*.txt (cabeçalho com sigla, rótulo e url; veja o README).

  python3 etl/corpus.py                 # usa corpus/.cache para não baixar de novo
  python3 etl/corpus.py --renovar       # baixa tudo de novo
"""
import argparse
import glob
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date

AQUI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = 'https://normas.leg.br/api/public/normas?'
UA = {'User-Agent': 'mm.api.br-transferencias/1.0'}
MAX_TRECHO = 2200  # caracteres: acima disso o artigo é dividido nos parágrafos


def baixa(url, cache, renovar):
    nome = os.path.join(cache, re.sub(r'[^A-Za-z0-9]+', '_', url)[-150:])
    if os.path.exists(nome) and not renovar:
        return open(nome, encoding='utf-8').read()
    for n in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                texto = r.read().decode('utf-8', errors='replace')
            break
        except Exception as e:
            if n == 3:
                raise RuntimeError(f'{url}: {e}') from e
            time.sleep(3 * 2 ** n)
    with open(nome, 'w', encoding='utf-8') as fh:
        fh.write(texto)
    return texto


# Notas de alteração ("Redação dada pela Lei ...", "Incluído pela ...") saem do texto: o trecho fica só com a norma.
NOTA = re.compile(r'\s*\((?:[^()]{0,60}?\s)?(?:reda[çc][ãa]o dada|inclu[íi]d[oa]s? pel|acrescid[oa]s? pel|acrescentad[oa]s? pel|'
                  r'renumerad[oa]s? pel|revogad[oa]s? pel|vide\b|vig[êe]ncia|regulamento|produ[çc][ãa]o de efeito|express[ãa]o)'
                  r'[^()]*(?:\([^()]*\)[^()]*)*\)', re.I)
ANULADO = re.compile(r'^\(?\s*(revogad[oa]s?|vetad[oa]s?)\b.*$', re.I)


def limpa(s):
    s = re.sub(r'<[^>]+>', ' ', s or '')
    s = html.unescape(s).replace('\xa0', ' ')
    s = NOTA.sub('', s)
    return re.sub(r'\s+', ' ', s).strip()


def numero_artigo(nome):
    m = re.match(r'Art\.\s*(\d+)\s*[º°o]?\s*(-\s*[A-Z])?', nome or '')
    return (m.group(1) + (m.group(2) or '').replace(' ', '')) if m else None


def anulado(rotulo, texto):
    """'§ 2º (Revogado).' ou 'II – (VETADO);' não entram no corpus."""
    return not texto or bool(ANULADO.match(texto.strip(' .;:')))


# --- texto estruturado (JSON-LD do normas.leg.br) ----------------------------------------------------------------
def tipo(n):
    t = n.get('legislationType')
    return (t.get('@id') if isinstance(t, dict) else str(t or '')).rsplit(':', 1)[-1]


def filhos(n):
    hp = n.get('hasPart')
    return [hp] if isinstance(hp, dict) else [x for x in (hp or []) if isinstance(x, dict)]


def vigente(n):
    vs = n.get('workExample')
    vs = [vs] if isinstance(vs, dict) else [v for v in (vs or []) if isinstance(v, dict)]
    em_vigor = [v for v in vs if v.get('legislationLegalForce') != 'NotInForce']
    return max(em_vigor, key=lambda v: v.get('legislationDate') or '') if em_vigor else None


AGRUPADORES = {'parte', 'livro', 'titulo', 'capitulo', 'secao', 'subsecao'}


def artigos_estruturados(raiz):
    saida = []

    def dispositivo(m, linhas, nome_art):
        v = vigente(m)
        if v is None:
            return
        t, txt, nm = tipo(m), limpa(v.get('text')), limpa(v.get('name'))
        if t == 'caput':
            linhas.append(('caput', f'{nome_art} {txt}'.strip()))
        elif not anulado(nm, txt):
            linhas.append((t, f'{nm} {txt}'.strip()))
        else:
            return
        for c in filhos(m):
            dispositivo(c, linhas, nome_art)

    def percorre(n, caminho):
        t, v = tipo(n), vigente(n)
        if t in AGRUPADORES:
            if v is None:
                return
            rot = ' – '.join(x for x in (limpa(v.get('name')), limpa(v.get('text'))) if x)
            for c in filhos(n):
                percorre(c, caminho + [rot])
        elif t == 'artigo':
            if v is None:
                return
            nome = limpa(v.get('name')).rstrip('.') + '.'
            linhas = []
            for c in filhos(n):
                dispositivo(c, linhas, nome)
            if linhas and not anulado(nome, linhas[0][1][len(nome):]):
                saida.append({'numero': numero_artigo(nome), 'caminho': caminho, 'linhas': linhas, 'url': n['@id']})
        else:
            for c in filhos(n):
                percorre(c, caminho)

    for n in filhos(raiz):
        for p in filhos(n):
            if tipo(p) == 'articulacao':
                percorre(p, [])
    return saida


# --- texto compilado em HTML (Câmara/Senado) ou texto local ------------------------------------------------------
NIVEIS = [(re.compile(r'^(PARTE|LIVRO)\s', re.I), 0), (re.compile(r'^T[ÍI]TULO\s', re.I), 1),
          (re.compile(r'^CAP[ÍI]TULO\s', re.I), 2), (re.compile(r'^SE[ÇC][ÃA]O\s', re.I), 3),
          (re.compile(r'^SUBSE[ÇC][ÃA]O\s', re.I), 4)]
ROTULO_DISP = re.compile(r'^(§\s*\d+\s*[º°o]?(?:-[A-Z])?|Par[áa]grafo [úu]nico\.?|[IVXLCDM]+\s*[-–—]|[a-z]\))\s*(.*)$')


def linhas_html(t):
    t = re.sub(r'<(script|style)\b[^>]*>.*?</\1>', '', t, flags=re.S | re.I)
    t = re.sub(r'<(strike|s|del)\b[^>]*>.*?</\1>', '', t, flags=re.S | re.I)  # texto riscado = revogado
    return [limpa(p) for p in re.findall(r'<p\b[^>]*>(.*?)</p>', t, flags=re.S | re.I)]


def artigos_de_linhas(linhas, url):
    saida, caminho, atual, pendente = [], [], None, None
    for ln in linhas:
        if not ln:
            continue
        if re.match(r'^(Bras[íi]lia|Este texto não substitui)', ln):
            break
        nivel = next((nv for rx, nv in NIVEIS if rx.match(ln)), None)
        if nivel is not None:
            caminho = [c for c in caminho if c[1] < nivel] + [(ln, nivel)]
            pendente = nivel
            continue
        num = numero_artigo(ln)
        if num:
            pendente = None
            m = re.match(r'(Art\.\s*\d+\s*[º°o]?\s*(?:-\s*[A-Z])?\s*\.?)\s*(.*)$', ln)
            nome, txt = re.sub(r'[\s.]+$', '', re.sub(r'\s+', ' ', m.group(1))) + '.', m.group(2)
            atual = None if anulado(nome, txt) else {'numero': num, 'caminho': [c[0] for c in caminho],
                                                      'linhas': [('caput', f'{nome} {txt}'.strip())], 'url': url}
            if atual:
                saida.append(atual)
            continue
        if pendente is not None and caminho:  # título do capítulo/seção na linha seguinte ao rótulo
            caminho[-1] = (f'{caminho[-1][0]} – {ln}', caminho[-1][1])
            pendente = None
            continue
        if atual:
            m = ROTULO_DISP.match(ln)
            if m and anulado(m.group(1), m.group(2)):
                continue
            atual['linhas'].append(('paragrafo' if ln.startswith(('§', 'Par')) else 'inciso', ln))
    for a in saida:
        a['caminho'] = [c for c in a['caminho']]
    return saida


# --- trechos ---------------------------------------------------------------------------------------------------
def rotulo_de(txt, primeiro=False):
    m = ROTULO_DISP.match(txt)
    if primeiro or not m:
        return 'caput'
    r = re.sub(r'\s+', ' ', m.group(1)).rstrip('.').rstrip(' -–—')
    return r if r.startswith(('§', 'Par')) or r.endswith(')') else 'inciso ' + r


def faixa_de(rotulos):
    if len(rotulos) == 1:
        return rotulos[0]
    return f'{rotulos[0]} e {rotulos[1]}' if len(rotulos) == 2 else f'{rotulos[0]} a {rotulos[-1]}'


def divide(g):
    """Grupo longo demais (caput ou parágrafo com muitos incisos): parte nos incisos; a cabeça vira contexto."""
    if len('\n'.join(g)) <= MAX_TRECHO:
        return [g]
    pedacos, atual = [], [g[0]]
    for x in g[1:]:
        if len(atual) > 1 and len('\n'.join(atual + [x])) > MAX_TRECHO * 0.8:
            pedacos.append(atual)
            atual = []
        atual.append(x)
    return pedacos + [atual]


def incisos(pedaco, g):
    """'incisos IV a VII' de um pedaço; se ele começa numa alínea, conta o inciso a que ela pertence."""
    nomes = [r[len('inciso '):] for r in map(rotulo_de, pedaco) if r.startswith('inciso ')]
    if not rotulo_de(pedaco[0]).startswith('inciso '):
        antes = [r[len('inciso '):] for r in map(rotulo_de, g[1:g.index(pedaco[0])]) if r.startswith('inciso ')]
        nomes = antes[-1:] + nomes
    if not nomes:
        return 'continuação'
    return f'inciso {nomes[0]}' if len(nomes) == 1 else f'incisos {nomes[0]} a {nomes[-1]}'


def trechos(norma, art):
    curto = norma['rotulo'].split(' (')[0]
    base = {'sigla': norma['sigla'], 'norma': norma['rotulo'], 'artigo': art['numero'], 'caminho': art['caminho'],
            'url': art['url']}
    corpo = '\n'.join(t for _, t in art['linhas'])
    rid = f"{norma['sigla']}-art{art['numero']}"
    if len(corpo) <= MAX_TRECHO:
        return [dict(base, id=rid, rotulo=f"{curto}, art. {art['numero']}", dispositivo='', texto=corpo, contexto='')]
    grupos, g = [], []
    for t, txt in art['linhas']:
        if t == 'paragrafo' and g:
            grupos.append(g)
            g = []
        g.append(txt)
    grupos.append(g)
    juntos = []
    for g in grupos:  # junta parágrafos curtos vizinhos
        if juntos and len('\n'.join(juntos[-1] + g)) <= MAX_TRECHO * 0.7:
            juntos[-1] += g
        else:
            juntos.append(g)
    caput = art['linhas'][0][1]
    saida = []
    for k, g in enumerate(juntos):
        for n, pedaco in enumerate(divide(g)):
            if n == 0:  # começa no caput ou num parágrafo: rótulo pelos parágrafos que contém
                rots = [rotulo_de(x, k == 0 and i == 0) for i, x in enumerate(pedaco) if i == 0 or x.startswith(('§', 'Par'))]
                ctx = '' if k == 0 else caput[:400]
            else:  # continuação de um grupo longo: rótulo pelos incisos, cabeça do grupo como contexto
                rots = [f'{rotulo_de(g[0], k == 0)}, {incisos(pedaco, g)}']
                ctx = (caput[:400] + '\n' if k else '') + (g[0][:400] if k else '')
                ctx = ctx.strip() or caput[:400]
            disp = faixa_de(rots)
            saida.append(dict(base, id=f'{rid}-{len(saida) + 1}', rotulo=f"{curto}, art. {art['numero']}, {disp}",
                              dispositivo=disp, texto='\n'.join(pedaco), contexto=ctx))
    return saida


def principal(a):
    cache = os.path.join(AQUI, 'corpus', '.cache')
    os.makedirs(cache, exist_ok=True)
    fontes = json.load(open(os.path.join(AQUI, 'corpus', 'fontes.json'), encoding='utf-8'))['normas']
    normas, todos = [], []
    for n in fontes:
        meta = json.loads(baixa(API + urllib.parse.urlencode({'urn': n['urn'], 'tipo_documento': 'maior-detalhe'}),
                                cache, a.renovar))
        arts, origem = artigos_estruturados(meta), 'estruturado'
        if len(arts) < 3:  # sem o texto estruturado: usa a compilação em HTML (vigente; senão a original)
            enc = meta.get('encoding') or []
            enc = [enc] if isinstance(enc, dict) else enc
            enc = sorted((e for e in enc if e.get('contentUrl')), key=lambda e: e.get('version') != 'Current')
            if not enc:
                print(f'{n["sigla"]}: sem texto no normas.leg.br', file=sys.stderr)
                continue
            url = enc[0]['contentUrl'].replace('/api/binario/', '/api/public/binario/')
            arts = artigos_de_linhas(linhas_html(baixa(url, cache, a.renovar)), f'https://normas.leg.br/?urn={n["urn"]}')
            origem = 'compilação ' + ('vigente' if enc[0].get('version') == 'Current' else 'original')
        if n.get('artigos'):
            arts = [x for x in arts if x['numero'] in n['artigos']]
        ts = [t for x in arts for t in trechos(n, x)]
        todos += ts
        normas.append({'sigla': n['sigla'], 'rotulo': n['rotulo'], 'urn': n['urn'], 'texto': origem,
                       'atualizada_em': meta.get('dateModified') or meta.get('sdDatePublished'),
                       'url': f'https://normas.leg.br/?urn={n["urn"]}', 'artigos': len(arts), 'trechos': len(ts)})
        print(f'{n["sigla"]}: {len(arts)} artigos, {len(ts)} trechos ({origem})', file=sys.stderr)
    for f in sorted(glob.glob(os.path.join(AQUI, 'corpus', 'locais', '*.txt'))):
        cab, _, corpo = open(f, encoding='utf-8').read().partition('\n\n')
        meta = dict(ln.split(':', 1) for ln in cab.splitlines() if ':' in ln)
        meta = {k.strip(): v.strip() for k, v in meta.items()}
        n = {'sigla': meta['sigla'], 'rotulo': meta['rotulo']}
        arts = artigos_de_linhas([limpa(ln) for ln in corpo.splitlines()], meta.get('url', ''))
        ts = [t for x in arts for t in trechos(n, x)]
        todos += ts
        normas.append({'sigla': n['sigla'], 'rotulo': n['rotulo'], 'texto': 'arquivo local ' + os.path.basename(f),
                       'url': meta.get('url'), 'artigos': len(arts), 'trechos': len(ts)})
        print(f'{n["sigla"]}: {len(arts)} artigos, {len(ts)} trechos (local)', file=sys.stderr)
    ids = [t['id'] for t in todos]
    assert len(ids) == len(set(ids)), 'ids repetidos no corpus'
    destino = os.path.join(AQUI, 'dados', 'rag')
    os.makedirs(destino, exist_ok=True)
    with open(os.path.join(destino, 'chunks.json'), 'w', encoding='utf-8') as fh:
        json.dump({'gerado_em': date.today().isoformat(), 'normas': normas, 'chunks': todos}, fh,
                  ensure_ascii=False, indent=0)
    print(f'{len(todos)} trechos de {len(normas)} normas', file=sys.stderr)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--renovar', action='store_true')
    principal(ap.parse_args())
