#!/usr/bin/env python3
"""
Incorpora o resultado oficial de um ciclo a partir da lista exportada do Radar da Transparência (painel "Avaliações
das entidades", filtro UF = TO, botão "Baixar CSV"), para quando o resultado já saiu mas a base aberta com as
respostas critério a critério ainda não.

Grava em dados/m/<ibge>.json o índice, o nível e o percentual de essenciais do ciclo (prefeitura e câmara) e, em
dados/municipios.json, passa o ciclo a ser o "atual". O plano de ação continua usando as respostas do ciclo da base
aberta (meta.ciclo_respostas). Antes de gravar, confere os ciclos anteriores da lista contra os dados da base aberta.
Só biblioteca padrão.

  python3 tools/radar_ciclo.py --ano 2026 --csv lista-2026.csv

Rode de novo depois de cada build_dados.py (que reescreve dados/m/), até a base aberta do ciclo sair. A lista usada
fica copiada em dados/radar/.
"""
import argparse
import csv
import json
import os
import re
import shutil
import sys
from datetime import date

AQUI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NIVEIS = {'Diamante', 'Ouro', 'Prata', 'Elevado', 'Intermediário', 'Básico', 'Inicial', 'Inexistente', 'Não Avaliado'}
RADAR = 'https://radardatransparencia.atricon.org.br/'


def numero(s):
    s = (s or '').strip().replace('%', '')
    if not s:
        return None
    if ',' in s and '.' in s:  # 1.234,56
        s = s.replace('.', '').replace(',', '.')
    return float(s.replace(',', '.'))


def registro(linha, ano):
    i, e, n = numero(linha.get(f'indice_{ano}')), numero(linha.get(f'essenciais_{ano}')), (linha.get(f'nivel_{ano}') or '').strip()
    if i is None and not n:
        return None
    if n and n not in NIVEIS:
        raise ValueError(f'nível desconhecido "{n}" em {linha.get("entidade")}')
    if i is not None and not 0 <= i <= 100 or e is not None and not 0 <= e <= 100:
        raise ValueError(f'percentual fora de 0 a 100 em {linha.get("entidade")}')
    return {'i': round(i / 100, 4) if i is not None else None, 'n': n or None, 'e': round(e / 100, 4) if e is not None else None}


def url(s):
    s = (s or '').strip()
    if re.match(r'^[\w-]+(\.[\w-]+)+(/\S*)?$', s):
        s = 'https://' + s
    return s if re.match(r'^https?://\S+$', s) else None


def principal(a):
    dados = os.path.join(AQUI, 'dados')
    idx_arq = os.path.join(dados, 'municipios.json')
    idx = json.load(open(idx_arq, encoding='utf-8'))
    meta = idx['meta']
    with open(a.csv, encoding='utf-8-sig', newline='') as fh:
        linhas = list(csv.DictReader(fh, delimiter=';'))
    faltam = {'ibge', 'poder', 'esfera', f'indice_{a.ano}', f'nivel_{a.ano}', f'essenciais_{a.ano}'} - set(linhas[0] if linhas else [])
    if faltam:
        sys.exit(f'a lista não tem as colunas {sorted(faltam)}: o formato do Radar mudou?')
    tipo = {('Executivo', 'Municipal'): 'pref', ('Legislativo', 'Municipal'): 'cam'}
    por = {}
    for l in linhas:
        k = tipo.get((l['poder'].strip(), l['esfera'].strip()))
        if k and (l.get('uf') or 'TO').strip() == meta['uf']:
            por[(int(l['ibge']), k)] = l

    conferidos, divergencias, gravados, portais = 0, [], 0, 0
    municipios = {m['ibge']: m for m in idx['municipios']}
    novos = {}
    for ibge in municipios:
        arq = os.path.join(dados, 'm', f'{ibge}.json')
        m = json.load(open(arq, encoding='utf-8'))
        for k, alvo in (('pref', m), ('cam', m.get('camara'))):
            l = por.get((ibge, k))
            if l is None or alvo is None:
                continue
            for ano, antigo in alvo['ciclos'].items():  # a lista do Radar repete os ciclos anteriores: confere
                r = registro(l, ano) if f'indice_{ano}' in l and int(ano) != a.ano else None
                if r is None or antigo.get('i') is None:
                    continue
                conferidos += 1
                if abs((r['i'] or 0) - antigo['i']) > 0.00015 or r['n'] != antigo.get('n'):
                    divergencias.append(f'{m["nome"]} ({k}) {ano}: base {antigo} × Radar {r}')
            r = registro(l, a.ano)
            if r:
                alvo['ciclos'][str(a.ano)] = r
                gravados += 1
            # a coluna "site" às vezes aponta uma página interna (contratos, licitações): só preenche o portal que
            # faltava, com a raiz do site, porque a sonda verifica a página inicial
            site = url(l.get('site'))
            if site and not alvo.get('portal'):
                alvo['portal'] = re.match(r'^https?://[^/]+', site).group(0) + '/'
                portais += 1
        novos[ibge] = m
    print(f'{conferidos} resultados de ciclos anteriores conferidos com a base aberta; divergências: {len(divergencias)}')
    for d in divergencias[:20]:
        print('  ' + d)
    if conferidos and len(divergencias) > 0.02 * conferidos and not a.forcar:
        sys.exit('divergências demais: confira se é a lista certa (UF, ciclo) ou use --forcar')
    sem = [m['nome'] for ibge, m in novos.items() if str(a.ano) not in m['ciclos']]
    if sem:
        print(f'sem resultado de {a.ano} na lista: {", ".join(sem)}')

    for ibge, m in novos.items():
        with open(os.path.join(dados, 'm', f'{ibge}.json'), 'w', encoding='utf-8') as fh:
            json.dump(m, fh, ensure_ascii=False, separators=(',', ':'))
        atual = m['ciclos'].get(str(a.ano), {})
        municipios[ibge].update({'n': atual.get('n'), 'i': atual.get('i')})
    meta['ciclos'] = sorted(set(meta['ciclos']) | {a.ano})
    meta['ciclo_atual'] = max(meta['ciclos'])
    meta['radar'] = {'ano': a.ano, 'importado_em': date.today().isoformat(), 'arquivo': f'radar/lista-{a.ano}-{meta["uf"]}.csv'}
    fonte = {'nome': f'Radar da Transparência: resultado do ciclo {a.ano} (lista exportada do painel)', 'url': RADAR}
    meta['fontes'] = [f for f in meta['fontes'] if not f['nome'].startswith('Radar da Transparência')] + [fonte]
    with open(idx_arq, 'w', encoding='utf-8') as fh:
        json.dump(idx, fh, ensure_ascii=False, separators=(',', ':'))
    os.makedirs(os.path.join(dados, 'radar'), exist_ok=True)
    destino = os.path.join(dados, meta['radar']['arquivo'])
    if os.path.abspath(a.csv) != os.path.abspath(destino):
        shutil.copyfile(a.csv, destino)
    print(f'{gravados} resultados de {a.ano} gravados (prefeituras e câmaras); {portais} endereços de portal que faltavam preenchidos; '
          f'ciclo atual: {meta["ciclo_atual"]}, respostas: {meta["ciclo_respostas"]}')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--ano', type=int, required=True)
    p.add_argument('--csv', required=True, help='lista exportada do Radar (separador ";")')
    p.add_argument('--forcar', action='store_true', help='grava mesmo com divergências nos ciclos anteriores')
    principal(p.parse_args())
