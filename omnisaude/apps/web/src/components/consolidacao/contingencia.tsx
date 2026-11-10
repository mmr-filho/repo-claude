'use client';

import type { SituacaoContingencia } from '@omnisaude/shared';
import { useState } from 'react';
import { Card, CardBody, EmptyState } from '@/components/ui/card';
import { Alert, Spinner } from '@/components/ui/misc';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useApi } from '@/lib/hooks';
import { ContingenciaPlano } from './contingencia-plano';
import type { TerritorioDaContingencia } from './contingencia-regras';
import { ContingenciaSituacao } from './contingencia-situacao';
import { SeletorTerritorio, useOpcoesDeAgravo, useTerritorios } from './diagrama-seletores';

/** A situação lida vale para o território escolhido (enquanto o novo carrega, a anterior fica esmaecida). */
const mesmoTerritorio = (s: SituacaoContingencia, t: TerritorioDaContingencia) => s.territorio.nivel === t.nivel && (t.nivel === 'MUNICIPIO' || s.territorio.id === t.territorio);

/**
 * Plano de contingência das arboviroses: estágio em vigor, sugestão da semana pelos critérios do plano, respostas
 * manuais, acionamento com justificativa e ato, checklist de ações por eixo, histórico e o plano (ver, criar do
 * modelo do MS, editar o rascunho e pôr em vigor). Leitura com `vigilancia.resumo` ou `vigilancia.painel`; as ações
 * com `vigilancia.contingencia` (`podeAgir`).
 */
export function AbaContingencia({ podeAgir }: { podeAgir: boolean }) {
  const [territorio, setTerritorio] = useState<TerritorioDaContingencia>({ nivel: 'MUNICIPIO', territorio: null });
  const [secao, setSecao] = useState('situacao');
  const territorios = useTerritorios(territorio.nivel);
  const { opcoes } = useOpcoesDeAgravo();
  const pronto = territorio.nivel === 'MUNICIPIO' || !!territorio.territorio;
  const consulta = new URLSearchParams({ nivel: territorio.nivel, ...(territorio.nivel !== 'MUNICIPIO' && territorio.territorio ? { territorio: territorio.territorio } : {}) });
  const s = useApi<SituacaoContingencia>(pronto ? `/vigilancia/contingencia?${consulta}` : null);
  const atual = s.data && mesmoTerritorio(s.data, territorio) ? s.data : null;
  const anterior = s.data && !atual && s.loading ? s.data : null;
  const mostrado = atual ?? anterior;

  return (
    <div className="space-y-4">
      <Tabs
        value={secao}
        onValueChange={setSecao}
        tabs={[
          { value: 'situacao', label: 'Situação da semana' },
          { value: 'plano', label: 'Plano' },
        ]}
      >
        <TabPanel value="situacao" className="space-y-4">
          <Card>
            <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SeletorTerritorio prefixo="ct" nivel={territorio.nivel} territorio={territorio.territorio} territorios={territorios} onChange={setTerritorio} />
            </CardBody>
          </Card>
          {!pronto ? (
            <Alert tone="info">Escolha {territorio.nivel === 'BAIRRO' ? 'o bairro' : 'a localidade'} para ver o estágio.</Alert>
          ) : s.error && !s.loading ? (
            <Alert tone="error">{s.error}</Alert>
          ) : !mostrado ? (
            s.loading ? (
              <Spinner label="Avaliando os critérios do plano…" />
            ) : (
              <Card>
                <EmptyState title="Sem dados da contingência" />
              </Card>
            )
          ) : (
            <div className={anterior ? 'pointer-events-none opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={!!anterior}>
              <ContingenciaSituacao
                key={`${mostrado.territorio.nivel}-${mostrado.territorio.id ?? 'municipio'}`}
                s={mostrado}
                podeAgir={podeAgir && !!atual}
                territorio={territorio}
                opcoes={opcoes}
                onMudou={() => void s.reload()}
              />
            </div>
          )}
        </TabPanel>
        <TabPanel value="plano">
          <ContingenciaPlano podeAgir={podeAgir} opcoes={opcoes} onVigenteMudou={() => void s.reload()} />
        </TabPanel>
      </Tabs>
    </div>
  );
}
