'use client';

import { SISTEMA_INFO, type FiltroConciliacao, type ResumoConciliacao, type SistemaOficial } from '@omnisaude/shared';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, Stat } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { ListaBairrosConciliacao } from './conciliacao-bairros';
import { ListaDivergentesConciliacao, ListaSoNoOficial, ListaSoNoOmnisaude, ListaSugestoesConciliacao } from './conciliacao-listas';
import { percentualVinculado, rotuloSistema, semPagina, textoCobertura } from './conciliacao-regras';
import { SeletorAgravo, useOpcoesDeAgravo } from './diagrama-seletores';

type ListaConciliacao = 'sugestoes' | 'so-oficial' | 'so-omnisaude' | 'divergentes' | 'bairros';

const n = (x: number) => x.toLocaleString('pt-BR');

/** Números da conciliação, por sistema, e o que as importações aplicadas cobrem. */
function ResumoDaConciliacao({ r }: { r: ResumoConciliacao }) {
  const pct = percentualVinculado(r);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Registros oficiais" value={n(r.registros)} hint="individuais, sem os excluídos" />
        <Stat label="Vinculados" value={n(r.vinculados)} hint={pct === null ? undefined : `${pct.toLocaleString('pt-BR')}% dos registros`} tone="good" />
        <Stat label="Só no oficial" value={n(r.soOficial)} tone={r.soOficial ? 'warn' : 'default'} />
        <Stat label="Só no OmniSaúde" value={n(r.soOmnisaude)} tone={r.soOmnisaude ? 'warn' : 'default'} />
        <Stat label="Divergentes" value={n(r.divergentes)} tone={r.divergentes ? 'warn' : 'default'} />
        <Stat label="Sugestões" value={n(r.sugestoes)} />
        <Stat label="Bairros sem correspondência" value={n(r.bairrosSemCorrespondencia)} tone={r.bairrosSemCorrespondencia ? 'warn' : 'default'} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Por sistema" />
          {r.porSistema.length ? (
            <Table>
              <THead>
                <tr>
                  <TH>Sistema</TH>
                  <TH className="text-right">Registros</TH>
                  <TH className="text-right">Vinculados</TH>
                  <TH className="text-right">Só no oficial</TH>
                  <TH className="text-right">Só no OmniSaúde</TH>
                </tr>
              </THead>
              <TBody>
                {r.porSistema.map((s) => (
                  <TR key={s.sistema}>
                    <TD className="text-sm">{rotuloSistema(s.sistema)}</TD>
                    <TD className="text-right tabular-nums">{n(s.registros)}</TD>
                    <TD className="text-right tabular-nums">{n(s.vinculados)}</TD>
                    <TD className="text-right tabular-nums">{n(s.soOficial)}</TD>
                    <TD className="text-right tabular-nums">{n(s.soOmnisaude)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <CardBody className="text-sm text-slate-500">Nenhuma importação aplicada ainda.</CardBody>
          )}
        </Card>
        <Card>
          <CardHeader
            title="Cobertura das importações aplicadas"
            description={r.ultimaImportacao ? `Última: ${rotuloSistema(r.ultimaImportacao.sistema)}, aplicada em ${fmtDateTime(r.ultimaImportacao.aplicadoEm)}.` : 'Nenhuma importação aplicada.'}
          />
          <CardBody>
            {r.cobertura.length ? (
              <ul className="list-inside list-disc space-y-1 text-sm text-slate-700">
                {r.cobertura.map((c, i) => (
                  <li key={`${c.sistema}-${c.de}-${i}`}>{textoCobertura(c)}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">Sem cobertura: a lista &quot;só no OmniSaúde&quot; fica vazia até a primeira importação aplicada.</p>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

/** Filtro das listas (uma linha acima delas; vale para todas, menos a de bairros). */
function FiltroDasListas({ filtro, onAplicar }: { filtro: FiltroConciliacao; onAplicar: (f: FiltroConciliacao) => void }) {
  const { opcoes } = useOpcoesDeAgravo();
  const [rascunho, setRascunho] = useState<FiltroConciliacao>(filtro);
  const sistemas = Object.keys(SISTEMA_INFO) as SistemaOficial[];
  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.5fr)_auto] lg:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        onAplicar(semPagina({ ...rascunho, busca: rascunho.busca?.trim() || undefined }));
      }}
    >
      <Field label="Sistema" htmlFor="conc-sistema">
        <Select id="conc-sistema" value={rascunho.sistema ?? ''} onChange={(e) => setRascunho({ ...rascunho, sistema: (e.target.value || undefined) as SistemaOficial | undefined })}>
          <option value="">Todos</option>
          {sistemas.map((s) => (
            <option key={s} value={s}>
              {SISTEMA_INFO[s].label}
            </option>
          ))}
        </Select>
      </Field>
      <SeletorAgravo id="conc-agravo" valor={rascunho.grupo ?? ''} opcoes={opcoes} vazio="Todos" onChange={(grupo) => setRascunho({ ...rascunho, grupo: grupo || undefined })} />
      <Field label="Notificados de" htmlFor="conc-de">
        <Input id="conc-de" type="date" value={rascunho.de ?? ''} onChange={(e) => setRascunho({ ...rascunho, de: e.target.value || undefined })} />
      </Field>
      <Field label="até" htmlFor="conc-ate">
        <Input id="conc-ate" type="date" value={rascunho.ate ?? ''} onChange={(e) => setRascunho({ ...rascunho, ate: e.target.value || undefined })} />
      </Field>
      <Field label="Número, nome ou CNS" htmlFor="conc-busca">
        <Input id="conc-busca" value={rascunho.busca ?? ''} maxLength={60} onChange={(e) => setRascunho({ ...rascunho, busca: e.target.value })} />
      </Field>
      <Button type="submit" variant="secondary">
        <Search className="h-4 w-4" /> Filtrar
      </Button>
    </form>
  );
}

/**
 * Conciliação dos registros oficiais com as notificações do OmniSaúde: resumo, sugestões, só no oficial, só no
 * OmniSaúde, divergentes e bairros sem correspondência, com vincular, desvincular, "não é o mesmo caso", preencher o
 * número oficial e adicionar apelido ao bairro. As listas nominais ficam na auditoria a cada leitura.
 */
export function AbaConciliacao({ podeEditarTerritorio }: { podeEditarTerritorio: boolean }) {
  const resumo = useApi<ResumoConciliacao>('/vigilancia/conciliacao/resumo');
  const [lista, setLista] = useState<ListaConciliacao>('sugestoes');
  const [filtro, setFiltro] = useState<FiltroConciliacao>({});
  const chave = JSON.stringify(filtro);
  const mudou = () => void resumo.reload();
  const r = resumo.data;
  const rotulo = (texto: string, valor: number | undefined) => (valor === undefined ? texto : `${texto} (${n(valor)})`);

  return (
    <div className="space-y-4">
      {resumo.loading && !r ? <Spinner /> : resumo.error ? <Alert tone="error">{resumo.error}</Alert> : r ? <ResumoDaConciliacao r={r} /> : null}

      <Card>
        <CardBody className="space-y-2">
          <FiltroDasListas filtro={filtro} onAplicar={setFiltro} />
          <p className="text-xs text-slate-500">O filtro vale para as listas abaixo, menos a de bairros.</p>
        </CardBody>
      </Card>

      <Tabs
        value={lista}
        onValueChange={(v) => setLista(v as ListaConciliacao)}
        tabs={[
          { value: 'sugestoes', label: rotulo('Sugestões', r?.sugestoes) },
          { value: 'so-oficial', label: rotulo('Só no oficial', r?.soOficial) },
          { value: 'so-omnisaude', label: rotulo('Só no OmniSaúde', r?.soOmnisaude) },
          { value: 'divergentes', label: rotulo('Divergentes', r?.divergentes) },
          { value: 'bairros', label: rotulo('Bairros sem correspondência', r?.bairrosSemCorrespondencia) },
        ]}
      >
        <Card>
          <TabPanel value="sugestoes">
            <ListaSugestoesConciliacao key={chave} filtro={filtro} onMudou={mudou} />
          </TabPanel>
          <TabPanel value="so-oficial">
            <ListaSoNoOficial key={chave} filtro={filtro} onMudou={mudou} />
          </TabPanel>
          <TabPanel value="so-omnisaude">
            <ListaSoNoOmnisaude key={chave} filtro={filtro} onMudou={mudou} />
          </TabPanel>
          <TabPanel value="divergentes">
            <ListaDivergentesConciliacao key={chave} filtro={filtro} onMudou={mudou} />
          </TabPanel>
          <TabPanel value="bairros">
            <ListaBairrosConciliacao podeEditarTerritorio={podeEditarTerritorio} onMudou={mudou} />
          </TabPanel>
        </Card>
      </Tabs>
    </div>
  );
}
