#!/usr/bin/env python3
"""
Sonda: visita a página inicial do portal de cada prefeitura e grava dados/sonda.json.

Verifica se o site responde (o critério 1.1 prejudica todos os demais: site fora do ar na avaliação zera o
índice), se usa HTTPS e se a capa tem links para o portal da transparência (1.3), o botão do Radar da
Transparência (2.9), o SIC, a ouvidoria, a LGPD e recursos de acessibilidade. São INDÍCIOS para a prefeitura
conferir, não avaliação: o tribunal olha o conteúdo, e uma página montada por script pode esconder os links.

Educada de propósito: uma visita por portal (mais o robots.txt), identificada no User-Agent, respeitando o
robots.txt, com poucas conexões simultâneas. Rode do servidor do site, uma vez por semana. Só biblioteca padrão.

  python3 tools/sonda.py                       # todos os portais de dados/m/*.json
  python3 tools/sonda.py --ibge 1721000        # um só
"""
import argparse
import concurrent.futures
import glob
import json
import os
import re
import socket
import ssl
import time
import unicodedata
import urllib.error
import urllib.request
import urllib.robotparser
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

AQUI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENTE = 'mm.api.br-transparencia-sonda/1.0 (+https://mm.api.br)'
LIMITE = 3 * 1024 * 1024  # não lê mais que isso de uma capa
SINAIS = {  # nome: expressão procurada no endereço ou no texto dos links (sem acento, minúsculo)
    'transparencia': r'transparencia',
    'radar': r'radardatransparencia|radar da transparencia',
    'sic': r'\be-?sic\b|acesso a informacao|acessoainformacao|lei de acesso',
    'ouvidoria': r'ouvidoria',
    'lgpd': r'\blgpd\b|protecao de dados|privacidade',
}
ACESSIBILIDADE = r'acessibilidade|vlibras|alto contraste|contraste'


def simples(t):
    return unicodedata.normalize('NFD', t or '').encode('ascii', 'ignore').decode().lower()


class Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links, self._href, self._texto = [], None, []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'a':
            self._href, self._texto = a.get('href') or '', [a.get('title') or '', a.get('aria-label') or '']
        elif tag == 'img' and self._href is not None:
            self._texto.append(a.get('alt') or '')

    def handle_data(self, data):
        if self._href is not None:
            self._texto.append(data)

    def handle_endtag(self, tag):
        if tag == 'a' and self._href is not None:
            self.links.append((self._href, ' '.join(self._texto)))
            self._href = None


def baixa(url, timeout):
    req = urllib.request.Request(url, headers={'User-Agent': AGENTE, 'Accept': 'text/html,*/*;q=0.5'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.geturl(), r.read(LIMITE), r.headers.get_content_charset() or 'utf-8'


def permitido(url, timeout):
    """robots.txt: sem arquivo (ou ilegível) = permitido; regra explícita contra = respeita."""
    p = urlsplit(url)
    rp = urllib.robotparser.RobotFileParser()
    try:
        _, _, corpo, cs = baixa(f'{p.scheme}://{p.netloc}/robots.txt', timeout)
        rp.parse(corpo.decode(cs, 'replace').splitlines())
    except Exception:
        return True
    return rp.can_fetch(AGENTE, url)


def motivo(e):
    if isinstance(e, urllib.error.HTTPError):
        return f'HTTP {e.code}'
    r = getattr(e, 'reason', e)
    if isinstance(r, (socket.timeout, TimeoutError)) or 'timed out' in str(r):
        return 'tempo esgotado'
    if isinstance(r, ssl.SSLError) or 'CERTIFICATE' in str(r).upper():
        return 'certificado inválido'
    if isinstance(r, socket.gaierror):
        return 'endereço não encontrado'
    return 'sem conexão'


def verifica(ibge, url, timeout):
    res = {'url': url, 'status': None, 'final': None, 'https': None, 'tempo': None, 'erro': None, 'sinais': None}
    try:
        if not permitido(url, timeout):
            res['erro'] = 'robots.txt não permite'
            return ibge, res
        t0 = time.monotonic()
        status, final, corpo, cs = baixa(url, timeout)
        res.update(status=status, final=final, https=final.startswith('https://'), tempo=round(time.monotonic() - t0, 2))
        html = corpo.decode(cs, 'replace')
        p = Links()
        p.feed(html)
        textos = [simples(urljoin(final, h) + ' ' + t) for h, t in p.links]
        if len(p.links) >= 10:
            res['leitura'] = 'links'
        else:  # capa montada por script: os links estão no código (JSON, JS), não em <a>; leitura aproximada
            res['leitura'] = 'codigo'
            textos.append(simples(html.replace('\\/', '/')))
        res['sinais'] = {k: any(re.search(rx, t) for t in textos) for k, rx in SINAIS.items()}
        res['sinais']['acessibilidade'] = bool(re.search(ACESSIBILIDADE, simples(html)))
        res['links'] = len(p.links)
    except Exception as e:  # falha aqui não prova que o site está fora do ar: pode ser a rede de quem verifica
        res['erro'] = motivo(e)
        if isinstance(e, urllib.error.HTTPError):  # o servidor respondeu, só que com erro (404, 403…)
            res['status'] = e.code
    return ibge, res


def principal(a):
    alvos = {}
    for f in glob.glob(os.path.join(AQUI, 'dados', 'm', '*.json')):
        m = json.load(open(f, encoding='utf-8'))
        if m.get('portal') and (not a.ibge or m['ibge'] in a.ibge):
            alvos[m['ibge']] = m['portal']
    destino = os.path.join(AQUI, 'dados', 'sonda.json')
    anterior = json.load(open(destino, encoding='utf-8')) if os.path.exists(destino) else {'municipios': {}}
    saida = {'verificado_em': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ'), 'agente': AGENTE,
             'municipios': anterior['municipios'] if a.ibge else {}}
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.conexoes) as ex:
        for ibge, res in ex.map(lambda kv: verifica(kv[0], kv[1], a.timeout), alvos.items()):
            saida['municipios'][str(ibge)] = res
    with open(destino, 'w', encoding='utf-8') as fh:
        json.dump(saida, fh, ensure_ascii=False, separators=(',', ':'))
    ok = sum(1 for r in saida['municipios'].values() if r['status'] and r['status'] < 400)
    print(f'{len(alvos)} portais verificados, {ok} responderam: {destino}')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--ibge', type=int, nargs='*')
    p.add_argument('--conexoes', type=int, default=6)
    p.add_argument('--timeout', type=float, default=25)
    principal(p.parse_args())
