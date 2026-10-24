#!/usr/bin/env python3
"""
Gera dados/transparencia-to.json a partir da base aberta do PNTP (Atricon) e do cadastro de entes do Siconfi.

Entradas (todas públicas, veja o README):
  --ciclo ANO=avaliacoes_pntp_ANO.xlsx   uma por ciclo (índice, nível, link do portal de cada ente)
  --respostas ANO=respostas_pntp_ANO_TO.xlsx   respostas critério a critério (só para o ciclo atual)
  --entes entes.json                      https://apidatalake.tesouro.gov.br/ords/siconfi/tt/entes
  --matriz matriz.xlsx                    (opcional) matriz de critérios do próximo ciclo, para avisar de mudanças

Uso:
  python3 build_dados.py --ciclo 2023=a23.xlsx --ciclo 2024=a24.xlsx --ciclo 2025=a25.xlsx \
      --respostas 2025=r25_TO.xlsx --entes entes.json --matriz matriz2026.xlsx --saida dados/transparencia-to.json

Requer pandas e openpyxl.
"""
import argparse
import json
import re
import sys
from datetime import date

import pandas as pd

UF_NOME = 'Tocantins'
UF_SIGLA = 'TO'

# Regras do ciclo 2026 (Cartilha PNTP 2026, seção "Fórmula para cálculo do índice").
PESO_CLASSE = {'Essencial': 2, 'Obrigatória': 1.5, 'Recomendada': 1}
PESO_ITEM = {'D': 30, 'A': 30, 'S': 20, 'G': 10, 'F': 10}
ITEM_COD = {
    'Disponibilidade': 'D',
    'Atualidade': 'A',
    'Série Histórica': 'S',
    'Gravação de Relatórios': 'G',
    'Filtros de Pesquisa': 'F',
}
PESO_DIMENSAO = {
    'Informações Prioritárias': 2, 'Informações Institucionais': 2, 'Receita': 4, 'Despesa': 4,
    'Convênios e Transferências': 1, 'Recursos Humanos': 3, 'Diárias': 1, 'Licitações': 3, 'Contratos': 3,
    'Obras': 2, 'Planejamento e Prestação de Contas': 4, 'SIC': 2, 'Acessibilidade': 1, 'Ouvidoria': 1,
    'LGPD e Governo Digital': 1, 'Renúncia de Receita': 1, 'Emendas Parlamentares': 1, 'Saúde': 1,
    'Educação': 1, 'Atividade Finalísticas': 3,
}
# matrizes que valem para a prefeitura (Poder Executivo municipal)
MATRIZES_EXECUTIVO = {'COMUM', 'COMUM (EXCETO ESTATAIS)', 'COMUM (EXCETO ESTATAIS INDEPENDENTES)', 'EXECUTIVO', 'EXECUTIVO e CONSÓRCIOS'}
NIVEIS = ['Diamante', 'Ouro', 'Prata', 'Elevado', 'Intermediário', 'Básico', 'Inicial', 'Inexistente', 'Não Avaliado']


def par(txt):
    k, _, v = txt.partition('=')
    if not k.isdigit() or not v:
        raise argparse.ArgumentTypeError(f'esperado ANO=arquivo, recebi {txt!r}')
    return int(k), v


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


def analisa_ente(g):
    """
    Reproduz o índice a partir das respostas e devolve, para cada item que não atende, quantos pontos
    percentuais o índice ganharia se passasse a atender. O índice oficial é o da base; isto serve ao simulador.
    """
    g = g.copy()
    g['ok'] = resposta_final(g)
    g['exig'] = g['exigibilidade'].astype(str).str.strip()
    g['dim'] = g['dimensao_texto'].astype(str).str.strip()
    g['cod'] = g['item_avaliacao'].map(ITEM_COD)
    g['crit'] = g['criterio_texto'].astype(str).str.extract(r'^\s*(\d+\.\d+)')[0]
    if g['cod'].isna().any() or g['crit'].isna().any():
        raise SystemExit('item ou critério desconhecido nas respostas; o formato da base mudou')

    # um critério vale (peso da dimensão) * (peso da classe / soma dos pesos da dimensão); os itens dividem o critério
    crit = g.groupby('crit').agg(dim=('dim', 'first'), exig=('exig', 'first'), texto=('criterio_texto', 'first'))
    crit['w'] = crit['exig'].map(PESO_CLASSE)
    dims_do_ente = crit['dim'].unique()
    total_dim = sum(PESO_DIMENSAO[d] for d in dims_do_ente)
    soma_w = crit.groupby('dim')['w'].sum()

    # itens repetidos no mesmo critério (várias verificações de "disponibilidade") dividem o peso do item
    g['base'] = g['cod'].map(PESO_ITEM)
    por_tipo = g.groupby(['crit', 'cod'])['cod'].transform('size')
    soma_tipos = g.drop_duplicates(['crit', 'cod']).groupby('crit')['base'].sum()
    g['parte'] = g['base'] / por_tipo / g['crit'].map(soma_tipos)
    g['valor'] = g.apply(
        lambda r: 100 * PESO_DIMENSAO[r['dim']] / total_dim * crit.at[r['crit'], 'w'] / soma_w[r['dim']] * r['parte'],
        axis=1,
    )
    indice_replica = g.loc[g['ok'], 'valor'].sum() / 100

    # o que não atende, por critério e item: [critério, item, ganho em pontos percentuais, subitens falhando, subitens]
    ordem_item = list(PESO_ITEM)
    falhas = []
    for (c, i), x in g.groupby(['crit', 'cod']):
        if not x['ok'].all():
            falhas.append([c, i, round(x.loc[~x['ok'], 'valor'].sum(), 2), int((~x['ok']).sum()), len(x)])
    falhas.sort(key=lambda f: (chave_crit(f[0]), ordem_item.index(f[1])))
    return {'replica': indice_replica, 'falhas': falhas}, crit


def chave_crit(c):
    return [int(p) for p in c.split('.')]


def le_matriz(caminho, ano):
    """Critérios e essenciais da matriz de um ciclo para a prefeitura (colunas: matriz, dimensão, id, critério, classe)."""
    m = pd.read_excel(caminho, sheet_name=0).iloc[:, :5]
    m.columns = ['matriz', 'dimensao', 'id', 'criterio', 'classe']
    m = m.dropna(subset=['id'])
    for c in m.columns:
        m[c] = m[c].astype(str).str.strip()
    m = m[m['matriz'].isin(MATRIZES_EXECUTIVO)]
    ess = sorted(m.loc[m['classe'] == 'Essencial', 'id'], key=chave_crit)
    return {'ano': ano, 'criterios': len(m), 'essenciais': ess}


def principal(a):
    ent = {e['cod_ibge']: e for e in json.load(open(a.entes, encoding='utf-8'))['items']
           if e.get('uf') == UF_SIGLA and e.get('esfera') == 'M'}
    if len(ent) != 139:
        print(f'aviso: {len(ent)} municípios no Siconfi (esperado 139 para o {UF_SIGLA})', file=sys.stderr)

    ciclos = sorted(dict(a.ciclo))
    por_ciclo = {}
    for ano, caminho in sorted(a.ciclo):
        df = pd.read_excel(caminho)
        df = df[df['UF'] == UF_NOME]
        por_ciclo[ano] = {
            'pref': df[(df['Poder'] == 'Executivo') & (df['Esfera'] == 'Municipal')].set_index('ibge'),
            'cam': df[(df['Poder'] == 'Legislativo') & (df['Esfera'] == 'Municipal')].set_index('ibge'),
        }
        for k in ('pref', 'cam'):
            if por_ciclo[ano][k].index.duplicated().any():
                raise SystemExit(f'{ano}: mais de uma avaliação por município ({k})')
    ciclo_atual = ciclos[-1]

    # respostas do ciclo atual, só das prefeituras
    resp = dict(a.respostas)
    analises, criterios = {}, {}
    if ciclo_atual in resp:
        r = pd.read_excel(resp[ciclo_atual])
        r = r[r['entidade_nome'].astype(str).str.startswith('Prefeitura')]
        for ibge, g in r.groupby('ibge'):
            analises[int(ibge)], crit = analisa_ente(g)
            for cid, row in crit.iterrows():
                criterios.setdefault(cid, {'id': cid, 'dim': row['dim'], 'exig': row['exig'],
                                           'texto': re.sub(r'^\s*\d+\.\d+\s*', '', re.sub(r'\s+', ' ', row['texto'])).strip()})

    def ficha(linha):
        return {
            'i': numero(linha['Índice de Transparência']),
            'n': str(linha['Nível de Transparência']),
            'e': numero(linha['% das Essenciais']),
            'c': str(linha['Avaliação Certificável?']).strip() == 'Sim',
        }

    municipios = []
    divergencias, difs = [], []
    for ibge in sorted(ent):
        e = ent[ibge]
        m = {'ibge': ibge, 'nome': e['ente'], 'pop': e.get('populacao'), 'cnpj': e.get('cnpj')}
        for k in ('pref', 'cam'):
            d = {}
            for ano in ciclos:
                tab = por_ciclo[ano][k]
                if ibge in tab.index:
                    d[str(ano)] = ficha(tab.loc[ibge])
            link = por_ciclo[ciclo_atual][k]
            if ibge in link.index and isinstance(link.loc[ibge, 'Link Site Principal'], str):
                d['portal'] = link.loc[ibge, 'Link Site Principal'].strip()
            m[k] = d
        if ibge in analises:
            an = analises[ibge]
            m['falhas'] = an['falhas']
            oficial = m['pref'][str(ciclo_atual)]
            if oficial['i'] is not None:
                difs.append(abs(an['replica'] - oficial['i']) * 100)
                if difs[-1] > 0.5:
                    divergencias.append((e['ente'], oficial['i'], round(an['replica'], 4)))
        municipios.append(m)

    proximo = le_matriz(a.matriz[1], a.matriz[0]) if a.matriz else None

    saida = {
        'meta': {
            'uf': UF_SIGLA,
            'gerado_em': date.today().isoformat(),
            'ciclos': ciclos,
            'ciclo_atual': ciclo_atual,
            'proximo_ciclo': proximo,
            'fontes': [
                {'nome': 'PNTP: base de dados (Atricon)', 'url': 'https://pntp.atricon.org.br/dados-abertos/'},
                {'nome': 'Siconfi: entes (Tesouro Nacional)', 'url': 'https://apidatalake.tesouro.gov.br/ords/siconfi/tt/entes'},
                {'nome': 'Cartilha PNTP 2026 (regras do índice)', 'url': 'https://cdn.atricon.org.br/2026/08/Cartilha-PNTP-2026.pdf'},
            ],
        },
        'niveis': NIVEIS,
        'pesos': {'classe': PESO_CLASSE, 'item': PESO_ITEM, 'dimensao': PESO_DIMENSAO},
        'criterios': sorted(criterios.values(), key=lambda c: chave_crit(c['id'])),
        'municipios': municipios,
    }
    with open(a.saida, 'w', encoding='utf-8') as f:
        json.dump(saida, f, ensure_ascii=False, separators=(',', ':'))

    print(f'{len(municipios)} municípios, ciclos {ciclos}, {len(criterios)} critérios, {a.saida}')
    if difs:
        print(f'índice reproduzido x oficial: erro médio {sum(difs) / len(difs):.2f} ponto, '
              f'{sum(d <= 0.05 for d in difs)} de {len(difs)} dentro de 0,05 e {sum(d <= 0.5 for d in difs)} dentro de 0,5')
    for nome, of, rep in divergencias[:10]:
        print(f'  {nome}: oficial {of:.4f}, reproduzido {rep:.4f}')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--ciclo', action='append', type=par, required=True)
    p.add_argument('--respostas', action='append', type=par, default=[])
    p.add_argument('--entes', required=True)
    p.add_argument('--matriz', type=par)
    p.add_argument('--saida', required=True)
    principal(p.parse_args())
