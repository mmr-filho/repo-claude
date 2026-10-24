#!/usr/bin/env python3
"""
Gera os dados do módulo Transparência a partir de arquivos públicos do PNTP (Atricon) e do Siconfi.

Saída (pasta --saida):
  municipios.json   prefeituras para escolher, com o resultado oficial mais recente, e metadados
  criterios.json    critérios da matriz-alvo para prefeituras: pesos, itens e orientação da Cartilha
  m/<ibge>.json     um por município: resultados oficiais por ciclo e situação em cada critério da matriz-alvo

Entradas (veja o README):
  --ciclo ANO=avaliacoes_pntp_ANO.xlsx         uma por ciclo (índice, nível, link do portal de cada ente)
  --respostas ANO=respostas_pntp_ANO_TO.xlsx   respostas critério a critério do ciclo mais recente
  --matriz ANO=matriz.xlsx                     matriz de critérios do ciclo-alvo (a mais recente publicada)
  --cartilha cartilha.txt                      Cartilha do ciclo-alvo convertida com `pdftotext -layout`
  --cartilha-url URL                           (opcional) endereço do PDF, para os links de página
  --entes entes.json                           https://apidatalake.tesouro.gov.br/ords/siconfi/tt/entes

A situação de cada critério da matriz-alvo vem das respostas validadas do ciclo mais recente, ligadas pelo
texto do critério (a numeração muda de um ciclo para outro). Critérios sem correspondente ficam "a conferir".

Requer pandas e openpyxl.
"""
import argparse
import difflib
import json
import os
import re
import sys
import unicodedata
from datetime import date

import pandas as pd

UF_NOME = 'Tocantins'
UF_SIGLA = 'TO'

# Fórmula do índice (Cartilha PNTP 2026, "Fórmula para cálculo do índice")
PESO_CLASSE = {'Essencial': 2, 'Obrigatória': 1.5, 'Recomendada': 1}
ITENS = {  # código: (nome na base, peso)
    'D': ('Disponibilidade', 30),
    'A': ('Atualidade', 30),
    'S': ('Série Histórica', 20),
    'G': ('Gravação de Relatórios', 10),
    'F': ('Filtros de Pesquisa', 10),
}
COD_ITEM = {nome: cod for cod, (nome, _) in ITENS.items()}
PESO_DIMENSAO = {
    'informacoes prioritarias': 2, 'informacoes institucionais': 2, 'receita': 4, 'despesa': 4,
    'convenios e transferencias': 1, 'recursos humanos': 3, 'diarias': 1, 'licitacoes': 3, 'contratos': 3,
    'obras': 2, 'planejamento e prestacao de contas': 4, 'sic': 2, 'acessibilidade': 1, 'ouvidoria': 1,
    'lgpd e governo digital': 1, 'renuncia de receita': 1, 'emendas parlamentares': 1, 'saude': 1,
    'educacao': 1, 'atividade finalisticas': 3,
}
SINONIMO_DIMENSAO = {
    'servico de informacao ao cidadao - sic': 'sic',
    'ouvidorias': 'ouvidoria',
    'lei geral de protecao de dados (lgpd) e governo digital': 'lgpd e governo digital',
    'renuncias de receitas': 'renuncia de receita',
    'educacao e assistencia social': 'educacao',
}
# matrizes da Cartilha que valem para a prefeitura (Poder Executivo municipal)
MATRIZES_EXECUTIVO = {'COMUM', 'COMUM (EXCETO ESTATAIS)', 'COMUM (EXCETO ESTATAIS INDEPENDENTES)', 'EXECUTIVO', 'EXECUTIVO e CONSÓRCIOS'}
# justificativas que não dizem nada além de "não atende"
VAZIAS = {'nao apresentou justificativa', 'nao disponibiliza', 'nao atende', 'nao localizado', 'nao encontrado',
          'nao divulga', 'nao possui', 'nao ha', 'nao consta', 'nao foi localizado', 'nao foi encontrado'}
ORDEM_ITEM = list(ITENS)


def par(txt):
    k, _, v = txt.partition('=')
    if not k.isdigit() or not v:
        raise argparse.ArgumentTypeError(f'esperado ANO=arquivo, recebi {txt!r}')
    return int(k), v


def sem_acento(s):
    return unicodedata.normalize('NFD', str(s)).encode('ascii', 'ignore').decode().lower().strip()


def chave_dim(nome):
    k = re.sub(r'\s+', ' ', sem_acento(nome))
    k = SINONIMO_DIMENSAO.get(k, k)
    if k not in PESO_DIMENSAO:
        raise SystemExit(f'dimensão sem peso conhecido: {nome!r}; atualize PESO_DIMENSAO com a Cartilha')
    return k


def id_crit(x):
    return str(x).strip().rstrip('.')


def chave_crit(c):
    return [int(p) for p in c.split('.')]


def numero(x):
    """Índice/percentual como número, ou None quando a base traz '-' ou vazio."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if v != v else round(v, 4)


def resposta_final(r):
    """Revisão vale mais que validação, que vale mais que a autoavaliação (como no Avalia)."""
    a = r['resposta_revisao']
    a = a.where(a.notna(), r['resposta_validacao'])
    a = a.where(a.notna(), r['resposta_avaliacao'])
    return a.astype(bool)


def pontos(criterios):
    """
    criterios: {id: (chave da dimensão, classe, [códigos de itens aplicáveis])}
    Devolve {id: (pontos do critério no índice, em pontos percentuais; {item: fração do critério})}.
    Cada dimensão vale seu peso; dentro dela, os critérios dividem esse peso conforme a classe; dentro do
    critério, os itens dividem conforme seu peso (os que não se aplicam são rateados entre os demais).
    """
    dims = {c[0] for c in criterios.values()}
    total = sum(PESO_DIMENSAO[d] for d in dims)
    soma_classe = {d: sum(PESO_CLASSE[c[1]] for c in criterios.values() if c[0] == d) for d in dims}
    out = {}
    for cid, (d, classe, itens) in criterios.items():
        p = 100 * PESO_DIMENSAO[d] / total * PESO_CLASSE[classe] / soma_classe[d]
        base = sum(ITENS[i][1] for i in itens)
        out[cid] = (p, {i: ITENS[i][1] / base for i in itens})
    return out


def normaliza_texto(t):
    return re.sub(r'[^a-z0-9 ]+', ' ', sem_acento(t)).split()


PALAVRAS_VAZIAS = set('a o e de da do das dos em no na nos nas com para por ao aos as os que se sua seu suas seus '
                      'divulga identifica publica demonstra possui ha sobre informacoes'.split())


def semelhanca(a, b):
    """De 0 a 1: textos parecidos, ou um contido no outro (critério desdobrado ou detalhado de um ciclo para outro)."""
    ta, tb = normaliza_texto(a), normaliza_texto(b)
    r = difflib.SequenceMatcher(None, ' '.join(ta), ' '.join(tb)).ratio()
    sa, sb = set(ta) - PALAVRAS_VAZIAS, set(tb) - PALAVRAS_VAZIAS
    if len(sa) < 2 or len(sb) < 2:
        return r
    comum = len(sa & sb)
    return max(r, 0.95 * max(comum / len(sa), comum / len(sb)))


def le_matriz(caminho):
    m = pd.read_excel(caminho, sheet_name=0).iloc[:, :10]
    m.columns = ['matriz', 'dim', 'id', 'texto', 'classe', 'D', 'A', 'S', 'G', 'F']
    m = m.dropna(subset=['id'])
    for c in ('matriz', 'dim', 'texto', 'classe'):
        m[c] = m[c].astype(str).str.strip()
    m['id'] = m['id'].map(id_crit)
    m = m[m['matriz'].isin(MATRIZES_EXECUTIVO)]
    if m['id'].duplicated().any():
        raise SystemExit('critério repetido na matriz para a prefeitura')
    crit = {}
    for _, r in m.iterrows():
        itens = [i for i in ORDEM_ITEM if not str(r[i]).strip().lower().startswith('não se aplica')]
        crit[r['id']] = {'id': r['id'], 'dim': r['dim'], 'dimk': chave_dim(r['dim']), 'texto': re.sub(r'\s+', ' ', r['texto']),
                         'classe': r['classe'], 'itens': itens}
    return crit


def le_cartilha(caminho, ids):
    """Fundamentação, itens exigidos, orientação e página de cada critério, a partir do texto da Cartilha."""
    linhas = open(caminho, encoding='utf-8').read().split('\n')
    ini = next(i for i, l in enumerate(linhas) if l.strip() == 'V. CRITÉRIOS')
    paginas, pendente = {}, None
    for l in linhas[:ini]:  # sumário: o número da página fica no fim da última linha de cada entrada
        m = re.match(r'^\s*(\d{1,2}\.\d{1,2})\.?\s', l)
        if m:
            pendente = m.group(1)
        f = re.search(r'\s(\d{1,3})\s*$', l)
        if pendente and f:
            paginas.setdefault(pendente, int(f.group(1)))
            pendente = None
    cab = re.compile(r'^(\d{1,2}\.\d{1,2})\.?\s+(\S.*)$')
    blocos, atual = [], None
    for i in range(ini, len(linhas)):
        s = linhas[i].strip()
        m = cab.match(s)
        if m and any(linhas[j].strip().startswith('➢') for j in range(i + 1, min(i + 10, len(linhas)))):
            atual = {'id': m.group(1), 'linhas': [m.group(2)]}
            blocos.append(atual)
        elif atual is not None:
            atual['linhas'].append(linhas[i])
    rotulo_item = re.compile(r'^(Disponibilidade|Atualidade|Série histórica|Gravação de relatórios|Filtro de pesquisa)\s*:\s*(.*)$', re.I)
    lixo = re.compile(r'^(Acesso rápido\s+\d+|Menu de critérios|Figura \d+\s*[-–].*|\d{1,2}\.\s+[A-ZÁÉÍÓÚÂÊ].*)$')
    out = {}
    for b in blocos:
        if b['id'] not in ids or b['id'] in out:
            continue
        titulo, campos, paras, atual_p = [], {}, [], None
        fase, campo = 'titulo', None
        for l in b['linhas']:
            s = l.strip()
            if fase == 'titulo':
                if s.startswith('➢'):
                    fase = 'campos'
                else:
                    titulo.append(s)
                    continue
            if fase == 'campos':
                if s.startswith('➢'):
                    campo, _, v = s.lstrip('➢ ').partition(':')
                    campos[campo.strip()] = v.strip()
                    continue
                if s and campo:
                    campos[campo.strip()] += ' ' + s
                    continue
                if not s:
                    fase = 'texto'
                continue
            if not s:
                atual_p = None
                continue
            if lixo.match(s):
                continue
            m = rotulo_item.match(s)
            if m:
                atual_p = [m.group(1).capitalize(), m.group(2)]
                paras.append(atual_p)
            elif atual_p is None and paras and re.match(r'^[a-zà-ú(,;]', s):
                atual_p = paras[-1]  # parágrafo que continua depois da quebra de página
                atual_p[1] += ' ' + s
            elif atual_p is None:
                atual_p = [None, s]
                paras.append(atual_p)
            else:
                atual_p[1] += ' ' + s
        limpa = lambda t: re.sub(r'\s+', ' ', t).strip()
        pega = lambda prefixo: next((limpa(v) for k, v in campos.items() if k.lower().startswith(prefixo)), None)
        out[b['id']] = {
            'fund': pega('fundamenta'),
            'orientacao': [[r, limpa(t)] for r, t in paras if limpa(t) or r],
            'pagina': paginas.get(b['id']),
        }
    return out


def mapeia(alvo, antigos):
    """Liga cada critério da matriz-alvo ao critério do ciclo anterior com o texto mais parecido, na mesma dimensão."""
    mapa = {}
    for cid, c in alvo.items():
        cands = [(semelhanca(a['texto'], c['texto']), aid) for aid, a in antigos.items() if a['dimk'] == c['dimk']]
        nota, aid = max(cands, default=(0, None))
        mapa[cid] = (aid, round(nota, 2)) if nota >= 0.6 else (None, round(nota, 2))
    return mapa


def nota_do_tribunal(rows):
    """A justificativa mais informativa do avaliador (revisão ou validação) para os itens que não atendem."""
    textos = []
    for col in ('justificativa_revisao', 'justificativa_validacao'):
        for t in rows[col].dropna():
            t = re.sub(r'\s+', ' ', str(t)).strip()
            if len(t) >= 25 and sem_acento(t).rstrip('. ') not in VAZIAS and t not in textos:
                textos.append(t)
    if not textos:
        return None
    t = max(textos, key=len)
    return t if len(t) <= 700 else t[:697].rsplit(' ', 1)[0] + '…'


def primeiro_link(rows, cols):
    for col in cols:
        for u in rows[col].dropna():
            u = str(u).strip()
            if re.match(r'^https?://', u):
                return u
    return None


def principal(a):
    ent = {e['cod_ibge']: e for e in json.load(open(a.entes, encoding='utf-8'))['items']
           if e.get('uf') == UF_SIGLA and e.get('esfera') == 'M'}
    if len(ent) != 139:
        print(f'aviso: {len(ent)} municípios no Siconfi (esperado 139 para o {UF_SIGLA})', file=sys.stderr)

    ciclos = sorted(dict(a.ciclo))
    oficiais = {}
    for ano, caminho in sorted(a.ciclo):
        df = pd.read_excel(caminho)
        df = df[(df['UF'] == UF_NOME) & (df['Esfera'] == 'Municipal')]
        for k, poder in (('pref', 'Executivo'), ('cam', 'Legislativo')):
            t = df[df['Poder'] == poder].set_index('ibge')
            if t.index.duplicated().any():
                raise SystemExit(f'{ano}: mais de uma avaliação por município ({k})')
            oficiais[(ano, k)] = t
    ciclo_atual = ciclos[-1]
    ano_resp, arq_resp = a.respostas
    ano_alvo, arq_matriz = a.matriz

    # ---- respostas do ciclo mais recente (só prefeituras)
    r = pd.read_excel(arq_resp)
    r = r[r['entidade_nome'].astype(str).str.startswith('Prefeitura')].copy()
    r['ok'] = resposta_final(r)
    r['cod'] = r['item_avaliacao'].map(COD_ITEM)
    r['crit'] = r['criterio_texto'].astype(str).str.extract(r'^\s*(\d+\.\d+)')[0]
    if r['cod'].isna().any() or r['crit'].isna().any():
        raise SystemExit('item ou critério desconhecido nas respostas; o formato da base mudou')
    antigos = {}
    for cid, g in r.groupby('crit'):
        antigos[cid] = {'texto': re.sub(r'^\s*\d+\.\d+\s*', '', re.sub(r'\s+', ' ', g['criterio_texto'].iloc[0])).strip(),
                        'dim': g['dimensao_texto'].iloc[0].strip(), 'dimk': chave_dim(g['dimensao_texto'].iloc[0]),
                        'classe': g['exigibilidade'].astype(str).str.strip().iloc[0]}

    # ---- conferência da fórmula: reproduz o índice oficial do ciclo das respostas
    difs = []
    for ibge, g in r.groupby('ibge'):
        estrutura = {c: (antigos[c]['dimk'], antigos[c]['classe'], sorted(set(x['cod']), key=ORDEM_ITEM.index)) for c, x in g.groupby('crit')}
        pts = pontos(estrutura)
        fr = g.groupby(['crit', 'cod'])['ok'].mean()
        indice = sum(p * sum(sh * fr[(c, i)] for i, sh in partes.items()) for c, (p, partes) in pts.items()) / 100
        oficial = numero(oficiais[(ano_resp, 'pref')].loc[ibge, 'Índice de Transparência'])
        if oficial is not None:
            difs.append((abs(indice - oficial) * 100, ent.get(ibge, {}).get('ente', ibge)))
    print(f'fórmula x índice oficial {ano_resp}: erro médio {sum(d for d, _ in difs) / len(difs):.2f} ponto; '
          f'{sum(d <= 0.05 for d, _ in difs)} de {len(difs)} prefeituras dentro de 0,05 ponto')
    for d, nome in sorted(difs, reverse=True)[:3]:
        if d > 0.05:
            print(f'  {nome}: diferença de {d:.2f} ponto')

    # ---- matriz-alvo, ligação com o ciclo anterior e orientação da Cartilha
    alvo = le_matriz(arq_matriz)
    mapa = mapeia(alvo, antigos)
    cartilha = le_cartilha(a.cartilha, set(alvo)) if a.cartilha else {}
    sem_orient = sorted(set(alvo) - set(cartilha), key=chave_crit)
    if a.cartilha and sem_orient:
        print(f'aviso: sem orientação da Cartilha para {sem_orient}', file=sys.stderr)
    pts_alvo = pontos({c: (x['dimk'], x['classe'], x['itens']) for c, x in alvo.items()})
    print(f'matriz {ano_alvo}: {len(alvo)} critérios para prefeituras; ligação com {ano_resp}:')
    for cid in sorted(alvo, key=chave_crit):
        aid, nota = mapa[cid]
        if aid != cid or nota < 0.9:
            print(f'  {cid:6} <- {aid or "(novo)":6} semelhança {nota:.2f}  {alvo[cid]["texto"][:70]}')

    catalogo = []
    for cid in sorted(alvo, key=chave_crit):
        x, (aid, _) = alvo[cid], mapa[cid]
        catalogo.append({
            'id': cid, 'dim': x['dim'], 'texto': x['texto'], 'classe': x['classe'], 'itens': x['itens'],
            'pontos': round(pts_alvo[cid][0], 3),
            'origem': aid, 'classe_antes': antigos[aid]['classe'] if aid else None,
            **cartilha.get(cid, {'fund': None, 'orientacao': [], 'pagina': None}),
        })

    # ---- um arquivo por município
    os.makedirs(os.path.join(a.saida, 'm'), exist_ok=True)
    indice_mun = []
    for ibge in sorted(ent):
        e = ent[ibge]
        g = r[r['ibge'] == ibge]
        por_item = {k: x for k, x in g.groupby(['crit', 'cod'])}
        situacao, estimativa, dims = [], 0.0, {}
        for cid in sorted(alvo, key=chave_crit):
            c, (aid, _) = alvo[cid], mapa[cid]
            p, partes = pts_alvo[cid]
            obtido, itens, falhas = 0.0, [], []
            for i in c['itens']:
                x = por_item.get((aid, i)) if aid else None
                if x is None:  # sem resposta comparável: conta como não atendido (estimativa conservadora)
                    itens.append([i, None, None])
                    continue
                obtido += p * partes[i] * x['ok'].mean()
                if not x['ok'].all():
                    itens.append([i, int((~x['ok']).sum()), len(x)])
                    falhas.append(x[~x['ok']])
            estimativa += obtido
            d = dims.setdefault(c['dim'], [0.0, 0.0])
            d[0] += obtido
            d[1] += p
            if p - obtido > 1e-9:
                f = pd.concat(falhas) if falhas else None
                situacao.append({
                    'id': cid, 'ganho': round(p - obtido, 2), 'itens': itens,
                    'nota': nota_do_tribunal(f) if f is not None else None,
                    'link': primeiro_link(f, ('link_revisao', 'link_validacao', 'link_avaliacao')) if f is not None else None,
                    'print': primeiro_link(f, ('imagem_revisao', 'imagem_validacao')) if f is not None else None,
                })

        def ciclos_de(k):
            out = {}
            for ano in ciclos:
                t = oficiais[(ano, k)]
                if ibge in t.index:
                    l = t.loc[ibge]
                    out[str(ano)] = {'i': numero(l['Índice de Transparência']), 'n': str(l['Nível de Transparência']),
                                     'e': numero(l['% das Essenciais'])}
            return out

        def portal(k):
            t = oficiais[(ciclo_atual, k)]
            u = t.loc[ibge, 'Link Site Principal'] if ibge in t.index else None
            u = u.strip() if isinstance(u, str) else ''
            if re.match(r'^[\w-]+(\.[\w-]+)+(/\S*)?$', u):  # a base às vezes traz o endereço sem o esquema
                u = 'https://' + u
            return u if re.match(r'^https?://\S+$', u) else None

        m = {
            'ibge': ibge, 'nome': e['ente'], 'pop': e.get('populacao'), 'cnpj': e.get('cnpj'),
            'portal': portal('pref'), 'ciclos': ciclos_de('pref'),
            'camara': {'portal': portal('cam'), 'ciclos': ciclos_de('cam')},
            'estimativa': round(estimativa / 100, 4) if len(g) else None,
            'dimensoes': [[d, round(v[0], 2), round(v[1], 2)] for d, v in dims.items()],
            'pendencias': situacao if len(g) else None,
        }
        with open(os.path.join(a.saida, 'm', f'{ibge}.json'), 'w', encoding='utf-8') as fh:
            json.dump(m, fh, ensure_ascii=False, separators=(',', ':'))
        atual = m['ciclos'].get(str(ciclo_atual), {})
        indice_mun.append({'ibge': ibge, 'nome': e['ente'], 'pop': e.get('populacao'), 'n': atual.get('n'), 'i': atual.get('i')})

    meta = {
        'uf': UF_SIGLA, 'gerado_em': date.today().isoformat(), 'ciclos': ciclos, 'ciclo_atual': ciclo_atual,
        'ciclo_respostas': ano_resp, 'ciclo_alvo': ano_alvo,
        'fontes': [
            {'nome': 'PNTP: base de dados (Atricon)', 'url': 'https://pntp.atricon.org.br/dados-abertos/'},
            {'nome': f'Cartilha e matriz de critérios PNTP {ano_alvo}', 'url': 'https://pntp.atricon.org.br/dados-abertos/'},
            {'nome': 'Siconfi: entes (Tesouro Nacional)', 'url': 'https://apidatalake.tesouro.gov.br/ords/siconfi/tt/entes'},
        ],
    }
    with open(os.path.join(a.saida, 'municipios.json'), 'w', encoding='utf-8') as fh:
        json.dump({'meta': meta, 'municipios': indice_mun}, fh, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(a.saida, 'criterios.json'), 'w', encoding='utf-8') as fh:
        json.dump({'ano': ano_alvo, 'cartilha_url': a.cartilha_url, 'itens': {k: {'nome': v[0], 'peso': v[1]} for k, v in ITENS.items()},
                   'criterios': catalogo}, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(indice_mun)} municípios em {a.saida}')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--ciclo', action='append', type=par, required=True)
    p.add_argument('--respostas', type=par, required=True)
    p.add_argument('--matriz', type=par, required=True)
    p.add_argument('--cartilha')
    p.add_argument('--cartilha-url', help='endereço do PDF da Cartilha, para os links "Cartilha, p. N"')
    p.add_argument('--entes', required=True)
    p.add_argument('--saida', required=True)
    principal(p.parse_args())
