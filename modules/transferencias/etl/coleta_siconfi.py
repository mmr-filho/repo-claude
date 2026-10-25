#!/usr/bin/env python3
"""
Camada 1 (ETL): coleta no Siconfi (Tesouro Nacional) os dados abertos de cada prefeitura do Tocantins e grava
dados/perfil/perfil_municipio_<ibge>.json, a entrada do motor de regras.

Por prefeitura:
  - RREO Anexo 14: percentuais aplicados em MDE (25%), FUNDEB na remuneração (70%) e saúde (15%);
  - RGF Anexo 5 do fim do ano anterior: disponibilidade de caixa por grupo de vinculação;
  - MSC orçamentária (classe 6, conta 6.2.1.2 "receita realizada"): o que entrou, por fonte de recursos e por
    natureza de receita, no ano anterior inteiro e no ano corrente até o último mês entregue;
  - MSC patrimonial (classe 1, contas 1.1.1.1 "caixa e equivalentes"): saldo em caixa por fonte nesse mesmo mês.

Só biblioteca padrão. Uma prefeitura leva ~10 consultas; as 139, alguns minutos.

  python3 etl/coleta_siconfi.py --ano 2026                 # todas
  python3 etl/coleta_siconfi.py --ano 2026 --ibge 1721000  # uma
"""
import argparse
import concurrent.futures
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date

AQUI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = 'https://apidatalake.tesouro.gov.br/ords/siconfi/tt/'
UA = {'User-Agent': 'mm.api.br-transferencias/1.0'}
VERSAO = 1


def consulta(recurso, tentativas=5, **params):
    """Todas as páginas de um recurso da API (a API devolve no máximo 5.000 linhas por página)."""
    itens, offset = [], 0
    while True:
        q = dict(params, offset=offset) if offset else params
        url = API + recurso + '?' + urllib.parse.urlencode(q)
        for n in range(tentativas):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                    pagina = json.load(r)
                break
            except Exception as e:  # rede instável ou limite de acesso: espera e tenta de novo
                if n == tentativas - 1:
                    raise RuntimeError(f'{recurso} {params}: {e}') from e
                time.sleep(3 * 2 ** n)
        itens += pagina.get('items', [])
        if not pagina.get('hasMore'):
            return itens
        offset += len(pagina['items'])


def entes_to():
    itens = consulta('entes')
    return sorted(({'ibge': int(e['cod_ibge']), 'nome': e['ente'], 'populacao': int(e.get('populacao') or 0)}
                   for e in itens if e.get('uf') == 'TO' and e.get('esfera') == 'M'), key=lambda e: e['nome'])


# --- RREO Anexo 14 ---------------------------------------------------------------------------------------------
LINHAS_14 = {
    'MinimoAnualDasReceitasDeImpostosNaManute': 'mde',
    'MinimoAnualDoFUNDEBNaRemuneracao': 'fundeb70',
    'AplicacaoTotalDasDespesasComAcoesEServic': 'asps',
}
COLUNAS_14 = {'% Aplicado Até o Bimestre': 'aplicado_pct', '% Mínimo a Aplicar no Exercício': 'minimo_pct',
              'Valor Apurado Até o Bimestre': 'valor'}


def rreo_14(ibge, ano, periodos):
    for p in periodos:
        for tipo in ('RREO', 'RREO Simplificado'):
            itens = consulta('rreo', an_exercicio=ano, nr_periodo=p, co_tipo_demonstrativo=tipo,
                             no_anexo='RREO-Anexo 14', id_ente=ibge)
            if not itens:
                continue
            r = {'ano': ano, 'bimestre': p, 'simplificado': tipo != 'RREO'}
            for i in itens:
                chave = next((v for k, v in LINHAS_14.items() if str(i['cod_conta']).startswith(k)), None)
                col = COLUNAS_14.get(i['coluna'])
                if chave and col:
                    r.setdefault(chave, {})[col] = i['valor']
                if str(i['cod_conta']).startswith('ReceitaCorrenteLiquidaDemonstrativo'):
                    r['rcl'] = i['valor']
            return r
    return None


# --- RGF Anexo 5 -----------------------------------------------------------------------------------------------
COLUNAS_5 = {'DISPONIBILIDADE DE CAIXA BRUTA': 'bruta', 'DISPONIBILIDADE DE CAIXA LÍQUIDA (ANTES': 'liquida',
             'DISPONIBILIDADE DE CAIXA LÍQUIDA (APÓS': 'liquida_apos_rp'}


def rgf_5(ibge, ano):
    for periodicidade, periodo, tipo in (('Q', 3, 'RGF'), ('S', 2, 'RGF Simplificado'), ('S', 2, 'RGF')):
        itens = consulta('rgf', an_exercicio=ano, in_periodicidade=periodicidade, nr_periodo=periodo,
                         co_tipo_demonstrativo=tipo, no_anexo='RGF-Anexo 05', co_esfera='M', co_poder='E', id_ente=ibge)
        if not itens:
            continue
        linhas = defaultdict(dict)
        for i in itens:
            col = next((v for k, v in COLUNAS_5.items() if str(i['coluna']).upper().startswith(k)), None)
            if col:
                linhas[i['conta'].strip()][col] = i['valor']
        return {'ano': ano, 'periodicidade': periodicidade, 'periodo': periodo, 'simplificado': tipo != 'RGF',
                'linhas': dict(linhas)}
    return None


# --- MSC -------------------------------------------------------------------------------------------------------
def fonte3(f):
    """'1540' e '2540' (recursos do exercício e de exercícios anteriores) são a mesma fonte, 540."""
    f = str(f or '')
    return f[1:] if len(f) == 4 else f or '-'


def receitas(itens):
    """Receita realizada (conta 621200000), em reais: crédito menos débito, por fonte e por natureza."""
    por_fonte, por_natureza = defaultdict(float), defaultdict(lambda: defaultdict(float))
    for i in itens:
        if i['conta_contabil'] != '621200000':
            continue
        v = i['valor'] * (1 if i['natureza_conta'] == 'C' else -1)
        f = fonte3(i['fonte_recursos'])
        por_fonte[f] += v
        nat = str(i.get('natureza_receita') or '')
        if nat[:2] in ('17', '24'):  # transferências correntes e de capital
            por_natureza[nat][f] += v
    return ({k: round(v, 2) for k, v in sorted(por_fonte.items()) if abs(v) >= 0.01},
            {n: {k: round(v, 2) for k, v in sorted(fs.items()) if abs(v) >= 0.01} for n, fs in sorted(por_natureza.items())})


def caixa(itens):
    """Caixa e equivalentes (contas 1.1.1.1), débito menos crédito, por fonte (exercício corrente + anteriores)."""
    saldo = defaultdict(float)
    for i in itens:
        if str(i['conta_contabil']).startswith('1111'):
            saldo[fonte3(i['fonte_recursos'])] += i['valor'] * (1 if i['natureza_conta'] == 'D' else -1)
    return {k: round(v, 2) for k, v in sorted(saldo.items()) if abs(v) >= 0.01}


def msc(recurso, ibge, ano, mes, classe):
    return consulta(recurso, id_ente=ibge, an_referencia=ano, me_referencia=mes, co_tipo_matriz='MSCC',
                    classe_conta=classe, id_tv='ending_balance')


def ultimo_mes_msc(ibge, ano, ate):
    for mes in range(ate, 0, -1):
        itens = msc('msc_orcamentaria', ibge, ano, mes, 6)
        if itens:
            return mes, itens
    return None, []


def faixa(pop):
    for limite, nome in ((5000, 'até 5 mil'), (10000, '5 a 10 mil'), (20000, '10 a 20 mil'), (50000, '20 a 50 mil'),
                         (100000, '50 a 100 mil')):
        if pop <= limite:
            return nome
    return 'acima de 100 mil'


def perfil(ente, ano, mes_max):
    ibge, ant = ente['ibge'], ano - 1
    p = {'versao': VERSAO, 'ibge': ibge, 'nome': ente['nome'], 'uf': 'TO', 'populacao': ente['populacao'],
         'faixa_populacional': faixa(ente['populacao']), 'consultado_em': date.today().isoformat(), 'fonte': API,
         'rreo14': {}, 'rgf5': None, 'receitas': {}, 'caixa': None, 'faltas': []}
    for a, periodos in ((ant, [6]), (ano, [6, 5, 4, 3, 2, 1])):
        r = rreo_14(ibge, a, periodos)
        if r:
            p['rreo14'][str(a)] = r
        else:
            p['faltas'].append(f'RREO Anexo 14 de {a}')
    p['rgf5'] = rgf_5(ibge, ant)
    if not p['rgf5']:
        p['faltas'].append(f'RGF Anexo 5 de {ant}')
    itens = msc('msc_orcamentaria', ibge, ant, 12, 6)
    if itens:
        f, n = receitas(itens)
        p['receitas'][str(ant)] = {'meses': 12, 'por_fonte': f, 'por_natureza': n}
    else:
        p['faltas'].append(f'MSC de dezembro de {ant}')
    mes, itens = ultimo_mes_msc(ibge, ano, mes_max)
    if mes:
        f, n = receitas(itens)
        p['receitas'][str(ano)] = {'meses': mes, 'por_fonte': f, 'por_natureza': n}
        p['caixa'] = {'ano': ano, 'mes': mes, 'por_fonte': caixa(msc('msc_patrimonial', ibge, ano, mes, 1))}
    else:
        p['faltas'].append(f'MSC de {ano}')
    return p


def principal(a):
    destino = os.path.join(AQUI, 'dados', 'perfil')
    os.makedirs(destino, exist_ok=True)
    todos = entes_to()
    entes = [e for e in todos if e['ibge'] in a.ibge] if a.ibge else todos
    print(f'{len(entes)} prefeituras do Tocantins', file=sys.stderr)
    falhas = []

    def um(ente):
        p = perfil(ente, a.ano, a.mes)
        with open(os.path.join(destino, f'perfil_municipio_{ente["ibge"]}.json'), 'w', encoding='utf-8') as fh:
            json.dump(p, fh, ensure_ascii=False, separators=(',', ':'))
        return ente, p

    with concurrent.futures.ThreadPoolExecutor(a.paralelas) as ex:
        for n, fut in enumerate(concurrent.futures.as_completed([ex.submit(um, e) for e in entes]), 1):
            try:
                ente, p = fut.result()
                print(f'{n:3d} {ente["nome"]}: MSC até o mês {p["caixa"]["mes"] if p["caixa"] else "-"};'
                      f' faltas: {", ".join(p["faltas"]) or "nenhuma"}', file=sys.stderr)
            except RuntimeError as e:
                falhas.append(str(e))
                print(f'{n:3d} falha: {e}', file=sys.stderr)
    with open(os.path.join(AQUI, 'dados', 'municipios.json'), 'w', encoding='utf-8') as fh:
        json.dump({'consultado_em': date.today().isoformat(), 'ano': a.ano,
                   'municipios': [{'ibge': e['ibge'], 'nome': e['nome'], 'populacao': e['populacao'],
                                   'faixa': faixa(e['populacao'])} for e in todos]},
                  fh, ensure_ascii=False, separators=(',', ':'))
    print(f'pronto: {destino}; falhas: {len(falhas)}', file=sys.stderr)
    return 1 if falhas else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--ano', type=int, default=date.today().year)
    ap.add_argument('--mes', type=int, default=date.today().month, help='último mês da MSC a tentar (desce até achar uma entregue)')
    ap.add_argument('--ibge', type=int, nargs='*')
    ap.add_argument('--paralelas', type=int, default=4)
    sys.exit(principal(ap.parse_args()))
