#!/usr/bin/env python3
"""
Coleta no Siconfi (Tesouro Nacional) as entregas de RREO e RGF de cada prefeitura e grava dados/siconfi.json.

São os relatórios dos critérios essenciais 11.5 (RGF) e 11.6 (RREO): se a prefeitura os entregou ao Tesouro,
eles existem e precisam estar também no portal. Só biblioteca padrão.

  python3 tools/coleta_siconfi.py --anos 2025 2026          # lê a lista de dados/municipios.json
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date

AQUI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = 'https://apidatalake.tesouro.gov.br/ords/siconfi/tt/extrato_entregas'
RELATORIOS = {'Relatório Resumido de Execução Orçamentária': 'rreo', 'Relatório de Gestão Fiscal': 'rgf'}


def busca(ibge, ano, tentativas=4):
    url = API + '?' + urllib.parse.urlencode({'id_ente': ibge, 'an_referencia': ano})
    for n in range(tentativas):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'mm.api.br-transparencia'}), timeout=60) as r:
                return json.load(r)['items']
        except Exception as e:  # rede instável: espera e tenta de novo
            if n == tentativas - 1:
                raise RuntimeError(f'{ibge}/{ano}: {e}') from e
            time.sleep(2 ** (n + 1))


def principal(a):
    municipios = json.load(open(os.path.join(AQUI, 'dados', 'municipios.json'), encoding='utf-8'))['municipios']
    saida = {'consultado_em': date.today().isoformat(), 'fonte': API, 'anos': a.anos, 'municipios': {}}
    falhas = []
    for m in municipios:
        entregas = {'rreo': [], 'rgf': []}
        for ano in a.anos:
            try:
                itens = busca(m['ibge'], ano)
            except RuntimeError as e:
                falhas.append(str(e))
                continue
            for i in itens:
                nome = str(i.get('entregavel', ''))
                # municípios com menos de 50 mil habitantes podem entregar as versões "Simplificado" (RGF semestral)
                tipo = next((t for n, t in RELATORIOS.items() if nome.startswith(n)), None)
                if tipo and str(i.get('instituicao', '')).startswith('Prefeitura'):
                    entregas[tipo].append({'ano': i['exercicio'], 'periodo': i['periodo'], 'periodicidade': i['periodicidade'],
                                           'simplificado': 'Simplificado' in nome, 'data': (i.get('data_status') or '')[:10]})
            time.sleep(a.pausa)
        for v in entregas.values():
            v.sort(key=lambda x: (x['ano'], x['periodo']))
        saida['municipios'][str(m['ibge'])] = entregas
    destino = os.path.join(AQUI, 'dados', 'siconfi.json')
    with open(destino, 'w', encoding='utf-8') as fh:
        json.dump(saida, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(municipios)} prefeituras, anos {a.anos}: {destino}; falhas: {len(falhas)}')
    for f in falhas[:10]:
        print('  ' + f, file=sys.stderr)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--anos', type=int, nargs='+', required=True)
    p.add_argument('--pausa', type=float, default=0.2, help='segundos entre consultas')
    principal(p.parse_args())
