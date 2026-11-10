'use client';

import { descreverReceita, ROTULO_STATUS_SEMANA, semanaEpidemiologica, type EixoDiagrama, type NivelTerritorio, type RespostaCongelarCanal, type RespostaDiagrama } from '@omnisaude/shared';
import { Download, Snowflake } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, saveBlob } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { nomeDoAgravo } from './diagrama-agravos';
import { anosDoSeletor, consultaDiagrama, descricaoDoGrafico, linhasDoDiagrama, receitaDoGrafico, semanasAcimaDoLs, textoSemanas, TOM_STATUS, ultimaSemanaCompleta } from './diagrama-dados';
import { DiagramaGrafico } from './diagrama-grafico';
import { DiagramaReceita } from './diagrama-receita';
import { nomeDoTerritorio, SeletorAgravo, SeletorTerritorio, useOpcoesDeAgravo, useTerritorios } from './diagrama-seletores';
import { DiagramaPopulacaoUsada, DiagramaTabelaSemanas } from './diagrama-tabela';
import { PopulacaoEstimativas } from './populacao-estimativas';

interface FiltroDiagrama {
  grupo: string;
  nivel: NivelTerritorio;
  territorio: string | null;
  ano: number;
  eixo: EixoDiagrama;
}

const ROTULO_EIXO: Record<EixoDiagrama, string> = { EPIDEMIOLOGICO: 'Ano epidemiológico (SE 1 a 52/53)', SAZONAL: 'Ano sazonal (SE 27 a SE 26)' };

/** Congelar o canal: a versão calculada agora passa a valer para o ano (a anterior fica guardada, inativa). */
function CongelarCanal({ aberto, onFechar, filtro, d, onCongelado }: { aberto: boolean; onFechar: () => void; filtro: FiltroDiagrama; d: RespostaDiagrama; onCongelado: () => void }) {
  const toast = useToast();
  const anos = d.canais.map((c) => c.ano);
  const [ano, setAno] = useState(filtro.ano);
  const [nota, setNota] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const canal = d.canais.find((c) => c.ano === ano);
  return (
    <Dialog
      open={aberto}
      onOpenChange={(o) => !o && onFechar()}
      title="Congelar o canal"
      description="O canal calculado agora vira a versão que vale para o ano. A versão anterior fica guardada, inativa. Mudanças depois (receita, população, anos excluídos, importações) só entram quando congelar de novo."
      footer={
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setErro(null);
            try {
              const r = await api.post<RespostaCongelarCanal>('/vigilancia/diagrama/congelar', {
                grupo: filtro.grupo,
                nivel: filtro.nivel,
                territorio: filtro.nivel === 'MUNICIPIO' ? null : filtro.territorio,
                ano,
                nota: nota.trim() || null,
              });
              toast.success(`Canal de ${r.ano} congelado: versão ${r.versao}${r.anterior ? ` (a versão ${r.anterior.versao} ficou inativa)` : ''}.`);
              setNota('');
              onFechar();
              onCongelado();
            } catch (err) {
              setErro(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Snowflake className="h-4 w-4" /> Congelar
        </Button>
      }
    >
      <div className="space-y-3">
        {anos.length > 1 && (
          <Field label="Ano do canal" htmlFor="dg-congelar-ano">
            <Select id="dg-congelar-ano" value={ano} onChange={(e) => setAno(Number(e.target.value))}>
              {anos.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {canal && (
          <p className="text-sm text-slate-700">
            {canal.congelado ? `Hoje vale a versão ${canal.congelado.versao}, congelada em ${fmtDateTime(canal.congelado.calculadoEm)}.` : 'O canal deste ano ainda não foi congelado.'} A nova versão usa a receita gravada
            do agravo: {descreverReceita(d.configuracao.receita)}.
          </p>
        )}
        <Field label="Nota (opcional)" htmlFor="dg-congelar-nota" hint="Ex.: canal aprovado na reunião do comitê de 05/02/2026.">
          <Textarea id="dg-congelar-nota" rows={3} maxLength={1000} value={nota} onChange={(e) => setNota(e.target.value)} />
        </Field>
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}

/** O gráfico, os avisos, a tabela por semana e a população usada. */
function PainelDoDiagrama({ d, filtro, podeConfigurar, recarregar }: { d: RespostaDiagrama; filtro: FiltroDiagrama; podeConfigurar: boolean; recarregar: () => void }) {
  const toast = useToast();
  const linhas = useMemo(() => linhasDoDiagrama(d), [d]);
  const receita = receitaDoGrafico(d);
  const ultima = ultimaSemanaCompleta(linhas);
  const acima = semanasAcimaDoLs(linhas);
  const [congelar, setCongelar] = useState(false);
  const [baixando, setBaixando] = useState(false);
  const avisos = [
    ...d.avisos,
    ...(receita.misturada ? ['Os dois anos do eixo sazonal usam receitas diferentes (um canal foi congelado com outra receita): compare com cuidado.'] : []),
    ...(d.semSemanaSintomas ? [`${d.semSemanaSintomas.toLocaleString('pt-BR')} caso(s) sem a semana do início dos sintomas: contados pela semana da notificação.`] : []),
    ...(d.bairrosSemCorrespondencia && d.territorio.nivel !== 'MUNICIPIO'
      ? [`${d.bairrosSemCorrespondencia.toLocaleString('pt-BR')} nome(s) de bairro dos registros oficiais sem correspondência no território: esses casos ficam fora do bairro até ganharem apelido (aba Conciliação).`]
      : []),
  ];

  async function baixarCsv() {
    setBaixando(true);
    try {
      const { blob, fileName } = await api.download(`/vigilancia/diagrama.csv${consultaDiagrama(filtro)}`);
      saveBlob(blob, fileName ?? `diagrama-${filtro.grupo}-${filtro.ano}.csv`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBaixando(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={`${d.agravo} · ${d.territorio.nome} · ${d.eixo === 'SAZONAL' ? `${d.ano}/${d.ano + 1}` : d.ano}`}
          description={ROTULO_EIXO[d.eixo]}
          actions={
            <>
              <Button size="sm" variant="secondary" onClick={baixarCsv} loading={baixando}>
                <Download className="h-4 w-4" /> CSV para o Excel{d.eixo === 'SAZONAL' ? ` (canal de ${d.ano})` : ''}
              </Button>
              {podeConfigurar && (
                <Button size="sm" onClick={() => setCongelar(true)}>
                  <Snowflake className="h-4 w-4" /> Congelar o canal
                </Button>
              )}
            </>
          }
        />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-700">
            <span>
              Última semana completa:{' '}
              {ultima ? (
                <>
                  <span className="font-medium tabular-nums">SE {ultima.rotulo}</span> <Badge tone={TOM_STATUS[ultima.status]}>{ROTULO_STATUS_SEMANA[ultima.status]}</Badge>
                </>
              ) : (
                'sem dado'
              )}
            </span>
            <span>
              Semanas completas acima do limite superior: <span className="font-medium tabular-nums">{acima}</span>
            </span>
            {d.semanasIncompletas.length > 0 && <span>Incompletas (atraso de notificação): {textoSemanas(d.semanasIncompletas)}</span>}
          </div>
          {avisos.length > 0 && (
            <Alert tone="warn" title="Avisos">
              <ul className="list-inside list-disc space-y-0.5">
                {avisos.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </Alert>
          )}
          <DiagramaGrafico linhas={linhas} unidade={receita.unidade} metodo={receita.metodo} k={receita.k} descricao={descricaoDoGrafico(d, receita.unidade)} />
        </CardBody>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader title="Valores por semana" description="Os mesmos números do gráfico, arredondados como o ARRED do Excel. O CSV traz os valores de cada ano de referência." />
          <DiagramaTabelaSemanas linhas={linhas} unidade={receita.unidade} metodo={receita.metodo} k={receita.k} />
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Canal" />
            <CardBody className="space-y-3 text-sm text-slate-700">
              {d.canais.map((c) => (
                <div key={c.ano} className="space-y-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                    Canal de {c.ano}
                    {c.congelado ? <Badge tone="blue">Congelado, versão {c.congelado.versao}</Badge> : <Badge tone="slate">Prévia calculada agora</Badge>}
                  </p>
                  {c.congelado && (
                    <p className="text-xs text-slate-600">
                      Congelado em {fmtDateTime(c.congelado.calculadoEm)}
                      {c.congelado.calculadoPor ? ` por ${c.congelado.calculadoPor}` : ''}
                      {c.congelado.nota ? `. Nota: ${c.congelado.nota}` : ''}
                    </p>
                  )}
                  <p>Anos de referência: {c.canal.anosReferencia.length ? c.canal.anosReferencia.join(', ') : 'nenhum'}.</p>
                  <p className="text-xs text-slate-600">{descreverReceita(c.canal.receita)}.</p>
                </div>
              ))}
              {d.configuracao.anosExcluidos.length > 0 && <p className="text-xs text-slate-600">Anos excluídos da referência: {d.configuracao.anosExcluidos.map((a) => `${a.ano} (${a.motivo})`).join('; ')}.</p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="População e cobertura por ano" />
            <DiagramaPopulacaoUsada populacao={d.populacao} cobertura={d.cobertura} unidade={receita.unidade} />
          </Card>
        </div>
      </div>
      {podeConfigurar && (
        <CongelarCanal key={`${filtro.grupo}-${filtro.nivel}-${filtro.territorio}-${filtro.ano}-${filtro.eixo}`} aberto={congelar} onFechar={() => setCongelar(false)} filtro={filtro} d={d} onCongelado={recarregar} />
      )}
    </div>
  );
}

/** O resultado vale para o filtro atual (enquanto o novo carrega, o anterior fica esmaecido). */
function mesmoFiltro(d: RespostaDiagrama, f: FiltroDiagrama) {
  return d.grupo === f.grupo && d.ano === f.ano && d.eixo === f.eixo && d.territorio.nivel === f.nivel && (f.nivel === 'MUNICIPIO' || d.territorio.id === f.territorio);
}

/** Diagrama de controle por agravo e território, com a receita, a população e o canal congelado. */
export function AbaDiagrama({ podeConfigurar }: { podeConfigurar: boolean }) {
  const session = useSession();
  const tz = session.me?.tenant.timeZone ?? 'America/Sao_Paulo';
  const anoAtual = useMemo(() => semanaEpidemiologica(new Date(), tz).ano, [tz]);
  const { opcoes } = useOpcoesDeAgravo();
  const [filtro, setFiltro] = useState<FiltroDiagrama>({ grupo: 'dengue', nivel: 'MUNICIPIO', territorio: null, ano: anoAtual, eixo: 'EPIDEMIOLOGICO' });
  const [secao, setSecao] = useState('diagrama');
  const pronto = !!filtro.grupo && (filtro.nivel === 'MUNICIPIO' || !!filtro.territorio);
  const d = useApi<RespostaDiagrama>(pronto ? `/vigilancia/diagrama${consultaDiagrama(filtro)}` : null);
  const territorios = useTerritorios(filtro.nivel);
  const nomeTerritorio = nomeDoTerritorio(territorios, filtro.nivel, filtro.territorio);
  const atual = d.data && mesmoFiltro(d.data, filtro) ? d.data : null;
  const anterior = d.data && !atual && d.loading ? d.data : null;
  const mostrado = atual ?? anterior;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <SeletorAgravo id="dg-agravo" valor={filtro.grupo} opcoes={opcoes} onChange={(grupo) => setFiltro({ ...filtro, grupo })} />
          <SeletorTerritorio prefixo="dg" nivel={filtro.nivel} territorio={filtro.territorio} territorios={territorios} onChange={(t) => setFiltro({ ...filtro, ...t })} />
          <Field label="Ano" htmlFor="dg-ano">
            <Select id="dg-ano" value={filtro.ano} onChange={(e) => setFiltro({ ...filtro, ano: Number(e.target.value) })}>
              {anosDoSeletor(anoAtual).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Eixo" htmlFor="dg-eixo">
            <Select id="dg-eixo" value={filtro.eixo} onChange={(e) => setFiltro({ ...filtro, eixo: e.target.value as EixoDiagrama })}>
              {(Object.keys(ROTULO_EIXO) as EixoDiagrama[]).map((e) => (
                <option key={e} value={e}>
                  {ROTULO_EIXO[e]}
                </option>
              ))}
            </Select>
          </Field>
        </CardBody>
      </Card>

      <Tabs
        value={secao}
        onValueChange={setSecao}
        tabs={[
          { value: 'diagrama', label: 'Diagrama' },
          { value: 'receita', label: 'Receita do agravo' },
          { value: 'populacao', label: 'População' },
        ]}
      >
        <TabPanel value="diagrama">
          {!pronto ? (
            <Alert tone="info">Escolha {filtro.nivel === 'BAIRRO' ? 'o bairro' : 'a localidade'} para ver o diagrama.</Alert>
          ) : d.error && !d.loading ? (
            <Alert tone="error">{d.error}</Alert>
          ) : !mostrado ? (
            d.loading ? (
              <Spinner label="Calculando o canal…" />
            ) : (
              <Card>
                <EmptyState title="Sem diagrama" />
              </Card>
            )
          ) : (
            <div className={anterior ? 'pointer-events-none opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={!!anterior}>
              <PainelDoDiagrama d={mostrado} filtro={filtro} podeConfigurar={podeConfigurar && !!atual} recarregar={() => void d.reload()} />
            </div>
          )}
        </TabPanel>
        <TabPanel value="receita">
          <DiagramaReceita
            key={filtro.grupo}
            grupo={filtro.grupo}
            nomeAgravo={atual?.agravo ?? nomeDoAgravo(opcoes, filtro.grupo)}
            ano={filtro.ano}
            anoAtual={anoAtual}
            configuracao={atual?.configuracao ?? null}
            podeConfigurar={podeConfigurar}
            onSalvo={() => void d.reload()}
          />
        </TabPanel>
        <TabPanel value="populacao">
          <PopulacaoEstimativas nivel={filtro.nivel} territorio={filtro.territorio} nomeTerritorio={nomeTerritorio} podeConfigurar={podeConfigurar} onMudou={() => void d.reload()} />
        </TabPanel>
      </Tabs>
    </div>
  );
}
