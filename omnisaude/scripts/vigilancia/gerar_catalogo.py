#!/usr/bin/env python3
"""
Gera o catálogo nacional de notificação compulsória (packages/shared/src/vigilancia/lnnc-nacional.ts) a partir
do compilado oficial da PRC GM/MS nº 4/2017 publicado pela BVS.

Uso:
  curl -o prc4.html https://bvsms.saude.gov.br/bvs/saudelegis/gm/2017/prc0004_03_10_2017.html
  python3 scripts/vigilancia/gerar_catalogo.py prc4.html AAAA-MM-DD   # data da consulta
  npx prettier --write --single-quote --print-width 220 --trailing-comma all packages/shared/src/vigilancia/lnnc-nacional.ts

As marcas MS, SES, SMS e Semanal vêm célula por célula do texto oficial (extrair_lnnc.py). O que este script
acrescenta é a curadoria: chave estável, grupo, contexto (caso, óbito, gestante, anomalia), critério e marco
do prazo, sigilo, notificação única por pessoa e notas normativas. A curadoria é revisada em PR.
"""
import json, os, re, sys, unicodedata

sys.path.insert(0, os.path.dirname(__file__))
from extrair_lnnc import extrair  # noqa: E402
import hashlib  # noqa: E402

VERSOES = [
    {
        'ato_num': '11.211',
        'id': 'PRT-GM-MS-11211-2026',
        'act': 'Portaria GM/MS nº 11.211, de 13 de maio de 2026',
        'publishedIn': 'DOU de 14/05/2026, edição 89, seção 1, p. 1120',
        'actUrl': 'https://www.in.gov.br/web/dou/-/portaria-gm/ms-n-11.211-de-13-de-maio-de-2026-705371404',
        'validFrom': '2026-05-14',
        'validTo': None,
        'notes': 'O art. 8º remete por erro material ao "Anexo 1 do Anexo X"; o título do Anexo I e o compilado da BVS citam o Anexo 1 do Anexo V. O art. 2º, I, fala em notificação imediata da caxumba, mas o Anexo I a marca como semanal (ver item 48).',
    },
    {
        'ato_num': '10.175',
        'id': 'PRT-GM-MS-10175-2026',
        'act': 'Portaria GM/MS nº 10.175, de 23 de janeiro de 2026',
        'publishedIn': 'DOU de 26/01/2026',
        'actUrl': 'https://www.in.gov.br/en/web/dou/-/portaria-gm/ms-n-10.175-de-23-de-janeiro-de-2026-683062951',
        'validFrom': '2026-01-26',
        'validTo': '2026-05-13',
        'notes': 'Redação anterior, substituída pela PRT GM/MS nº 11.211/2026. Versões ainda mais antigas do Anexo 1 entram com a série histórica.',
    },
]


def norm(s):
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return re.sub(r'\s+', ' ', s.lower()).strip()


# (padrão no nome normalizado, atributos). A primeira regra que casa vale. Grupos com mais de um contexto:
# dengue, zika, chikungunya, oropouche, malaria, covid, esavi, tetano.
REGRAS = [
    (r'material biologico', dict(key='acidente-trabalho-biologico')),
    (r'acidente de trabalho', dict(key='acidente-trabalho')),
    (r'animal peconhento', dict(key='acidente-animal-peconhento')),
    (r'transmissor da raiva', dict(key='atendimento-antirrabico', sinanCode='W64')),
    (r'^anomalias congenitas', dict(key='anomalias-congenitas', once=True)),
    (r'botulismo', dict(key='botulismo')),
    (r'cancer relacionado', dict(key='cancer-trabalho', once=True)),
    (r'colera', dict(key='colera')),
    (r'coqueluche', dict(key='coqueluche', sinanCode='A379')),
    (r'^covid-19$', dict(key='covid-19', group='covid')),
    (r'dengue - casos', dict(key='dengue', group='dengue', context='CASO')),
    (r'dengue - obitos', dict(key='dengue-obito', group='dengue', context='OBITO')),
    (r'dermatose', dict(key='dermatoses-ocupacionais')),
    (r'difteria', dict(key='difteria')),
    (r'disturbio de voz', dict(key='disturbio-voz-trabalho', once=True)),
    (r'chagas aguda', dict(key='chagas-aguda')),
    (r'chagas cronica', dict(key='chagas-cronica', once=True)),
    (r'creutzfeldt', dict(key='dcj', once=True)),
    (r'falciforme', dict(key='doenca-falciforme', once=True)),
    (r'haemophilus', dict(key='haemophilus-invasiva')),
    (r'meningococica', dict(key='meningites')),
    (r'disseminacao intencional', dict(key='disseminacao-intencional')),
    (r'febris hemorragicas', dict(key='febres-hemorragicas')),
    (r'virus zika em gestante', dict(key='zika-gestante', group='zika', context='GESTANTE')),
    (r'obito com suspeita de doenca pelo virus zika', dict(key='zika-obito', group='zika', context='OBITO')),
    (r'sindrome congenita associada', dict(key='zika-congenita', group='zika', context='ANOMALIA_CONGENITA')),
    (r'doenca aguda pelo virus zika', dict(key='zika', group='zika', context='CASO')),
    (r'esporotricose', dict(key='esporotricose', sinanCode='B42')),
    (r'esquistossomose', dict(key='esquistossomose')),
    (r'evento de saude publica', dict(key='esp')),
    (r'evento supostamente atribuivel', dict(key='esavi', group='esavi')),
    (r'eventos adversos graves', dict(key='eventos-adversos-vacinacao', group='esavi')),
    (r'febre amarela', dict(key='febre-amarela')),
    (r'chikungunya em areas sem transmissao', dict(key='chikungunya-sem-transmissao', group='chikungunya', context='OUTRO')),
    (r'obito com suspeita de febre de chikungunya', dict(key='chikungunya-obito', group='chikungunya', context='OBITO')),
    (r'febre de chikungunya', dict(key='chikungunya', group='chikungunya', context='CASO')),
    (r'nilo ocidental', dict(key='nilo-ocidental-arboviroses')),
    (r'oropouche - casos', dict(key='oropouche', group='oropouche', context='CASO', sinanCode='A930')),
    (r'oropouche - obitos', dict(key='oropouche-obito', group='oropouche', context='OBITO')),
    (r'oropouche em gestante', dict(key='oropouche-gestante', group='oropouche', context='GESTANTE')),
    (r'oropouche - anomalias', dict(key='oropouche-anomalia', group='oropouche', context='ANOMALIA_CONGENITA')),
    (r'febre maculosa', dict(key='febre-maculosa')),
    (r'febre tifo', dict(key='febre-tifoide')),
    (r'hanseniase', dict(key='hanseniase', once=True)),
    (r'hantavirose', dict(key='hantavirose')),
    (r'hepatites virais', dict(key='hepatites-virais', once=True)),
    (r'hepatite b em gestante', dict(key='hepatite-b-gestacao', context='GESTANTE')),
    (r'^hiv/aids', dict(key='aids', sensitive=True, once=True)),
    (r'hiv em gestante', dict(key='hiv-gestacao', sensitive=True, context='GESTANTE')),
    (r'imunodeficiencia humana \(hiv\)$', dict(key='hiv', sensitive=True, once=True)),
    (r'htlv em gestante', dict(key='htlv-gestacao', context='GESTANTE')),
    (r'linfotropico', dict(key='htlv', once=True)),
    (r'novo subtipo viral', dict(key='influenza-novo-subtipo')),
    (r'intoxicacao exogena', dict(key='intoxicacao-exogena')),
    (r'leishmaniose tegumentar', dict(key='lta')),
    (r'leishmaniose visceral', dict(key='leishmaniose-visceral')),
    (r'leptospirose', dict(key='leptospirose')),
    (r'ler/dort', dict(key='ler-dort', once=True)),
    (r'extra-amazonica', dict(key='malaria-extra-amazonica', group='malaria', context='OUTRO')),
    (r'malaria na regiao amazonica', dict(key='malaria', group='malaria', context='CASO')),
    (r'monkeypox', dict(key='mpox')),
    (r'^obito: a. infantil', dict(key='obito-infantil-materno')),
    (r'parotidite', dict(key='caxumba')),
    (r'perda auditiva', dict(key='perda-auditiva-trabalho', once=True)),
    (r'pneumoconioses', dict(key='pneumoconioses-trabalho', once=True)),
    (r'^peste$', dict(key='peste')),
    (r'poliomielite/ paralisia', dict(key='polio-pfa')),
    (r'poliovirus selvagem', dict(key='poliomielite')),
    (r'paralisia flacida aguda$', dict(key='pfa')),
    (r'raiva humana', dict(key='raiva-humana')),
    (r'sindrome da rubeola congenita', dict(key='rubeola-congenita')),
    (r'exantematicas', dict(key='sarampo-rubeola')),
    (r'^sifilis', dict(key='sifilis', sensitive=True)),
    (r'sim-a\)', dict(key='sim-a')),
    (r'sim-p\)', dict(key='sim-p')),
    (r'\(srag\)', dict(key='srag-coronavirus')),
    (r'sindrome gripal por covid-19 confirmada', dict(key='sg-covid-confirmada', group='covid', notifyOn='CONFIRMACAO', deadlineStart='CONFIRMACAO')),
    (r'sindrome gripal suspeita de covid-19', dict(key='sg-covid-suspeita', group='covid')),
    (r'tetano acidental', dict(key='tetano-acidental', group='tetano', context='CASO')),
    (r'tetano neonatal', dict(key='tetano-neonatal', group='tetano', context='OUTRO')),
    (r'^tetano:', dict(key='tetano', group='tetano')),
    (r'toxoplasmose', dict(key='toxoplasmose-gestacional-congenita')),
    (r'transtornos mentais', dict(key='transtornos-mentais-trabalho', once=True)),
    (r'tuberculose', dict(key='tuberculose', once=True)),
    (r'varicela - caso grave', dict(key='varicela-grave', group='varicela')),
    (r'^varicela$', dict(key='varicela', group='varicela')),
    (r'violencia domestica', dict(key='violencia', sensitive=True)),
    (r'violencia sexual e tentativa de suicidio', dict(key='violencia-sexual-suicidio', sensitive=True)),
]

NOTAS = {
    ('11.211', 'caxumba'): 'Em revisão normativa: o art. 2º, I, da PRT GM/MS nº 11.211/2026 fala em notificação imediata à SES, à SMS e ao MS, mas o Anexo I marca a caxumba como semanal. O Ministério informou pelo Fala.BR que vale o Anexo (fonte secundária); não há retificação no DOU até 01/11/2026. A SES ou a SMS podem sobrepor com uma versão local.',
}


def curar(versao, linha):
    nome = re.sub(r'^[a-z]\.\s*', '', linha['nome'])
    n = norm(nome)
    for padrao, attrs in REGRAS:
        if re.search(padrao, n):
            a = dict(attrs)
            break
    else:
        raise SystemExit(f'Sem curadoria para {versao} item {linha["numero_bruto"]}: {linha["nome"]}')
    imediata = linha['MS'] or linha['SES'] or linha['SMS']
    sub = re.match(r'^([a-z])\.\s', linha['nome'])
    nota = NOTAS.get((versao, a['key']))
    return {
        'key': a['key'],
        'group': a.get('group', a['key']),
        'item': int(linha['numero_bruto']),
        'subitem': sub.group(1) if sub else None,
        'name': nome.strip(),
        'context': a.get('context', 'CASO'),
        'immediateMs': linha['MS'],
        'immediateSes': linha['SES'],
        'immediateSms': linha['SMS'],
        'weekly': linha['SEMANAL'],
        'notifyOn': a.get('notifyOn', 'SUSPEITA'),
        'deadlineStart': a.get('deadlineStart', 'ATENDIMENTO' if imediata else 'CONHECIMENTO'),
        'sensitive': a.get('sensitive', False),
        'once': a.get('once', False),
        'normativeStatus': 'EM_REVISAO' if nota else 'VIGENTE',
        'normativeNote': nota,
        'sinanCode': a.get('sinanCode'),
    }


def main():
    fonte, consultado = sys.argv[1], sys.argv[2]
    dados = open(fonte, 'rb').read()
    raw = dados.decode('latin-1')
    sha = hashlib.sha256(dados).hexdigest()
    saida = []
    for v in VERSOES:
        linhas, vistos = [], set()
        for l in extrair(raw, v['ato_num']):
            chave = (l['numero_bruto'], l['nome'], tuple(l['celulas']))
            if chave in vistos:  # célula mesclada repetida no HTML (ex.: item 19 da 10.175)
                continue
            vistos.add(chave)
            linhas.append(curar(v['ato_num'], l))
        chaves = [c['key'] for c in linhas]
        dup = {k for k in chaves if chaves.count(k) > 1}
        if dup:
            raise SystemExit(f'Chaves repetidas na {v["ato_num"]}: {dup}')
        for c in linhas:
            if c['weekly'] == (c['immediateMs'] or c['immediateSes'] or c['immediateSms']):
                raise SystemExit(f'Linha sem periodicidade única: {c}')
        saida.append({k: v[k] for k in ('id', 'act', 'publishedIn', 'actUrl', 'validFrom', 'validTo', 'notes')} | {
            'sourceUrl': 'https://bvsms.saude.gov.br/bvs/saudelegis/gm/2017/prc0004_03_10_2017.html',
            'sourceSha256': sha,
            'consultedAt': consultado,
            'conditions': linhas,
        })
        print(v['ato_num'], 'linhas:', len(linhas), 'itens:', len({c['item'] for c in linhas}))
    destino = os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'shared', 'src', 'vigilancia', 'lnnc-nacional.ts')
    os.makedirs(os.path.dirname(destino), exist_ok=True)
    corpo = json.dumps(saida, ensure_ascii=False, indent=2)
    with open(destino, 'w') as f:
        f.write('// Gerado por scripts/vigilancia/gerar_catalogo.py a partir do compilado da PRC GM/MS nº 4/2017 (BVS).\n')
        f.write('// Não edite à mão: ajuste a curadoria no script e gere de novo.\n')
        f.write("import type { VersaoNacionalLnnc } from './catalogo';\n\n")
        f.write('export const LNNC_NACIONAL: VersaoNacionalLnnc[] = ' + corpo + ';\n')
    print('gravado', os.path.normpath(destino))


if __name__ == '__main__':
    main()
