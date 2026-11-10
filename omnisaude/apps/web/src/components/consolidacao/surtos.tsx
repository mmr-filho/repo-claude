'use client';

import type { SugestaoSurtoTela } from '@omnisaude/shared';
import { useState } from 'react';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useOpcoesDeAgravo } from './diagrama-seletores';
import { SurtoDetalhe } from './surto-detalhe';
import { SurtoLista } from './surto-lista';
import { SurtoNovo } from './surto-novo';
import { SurtoSugestoes } from './surto-sugestoes';

/**
 * Surtos (`vigilancia.surto`; o núcleo só alcança a unidade em que está lotado): sugestões de aglomerado (abrir o surto
 * pré-preenchido ou dispensar com motivo), notificações de surto com a ficha (campos 17 a 19, local de ocorrência,
 * investigação, bloco DTA, encerramento), a planilha de casos, as comunicações, o número do Sinan e o espelho com as
 * variáveis do dicionário.
 */
export function AbaSurtos() {
  const { opcoes } = useOpcoesDeAgravo();
  const [secao, setSecao] = useState('sugestoes');
  const [aberto, setAberto] = useState<string | null>(null);
  const [novo, setNovo] = useState<{ sugestao: SugestaoSurtoTela | null } | null>(null);
  // Muda quando um surto é criado ou alterado: a lista e as sugestões leem de novo.
  const [versao, setVersao] = useState(0);
  const mudou = () => setVersao((v) => v + 1);

  return (
    <div className="space-y-4">
      <Tabs
        value={secao}
        onValueChange={(v) => {
          setSecao(v);
          setAberto(null);
        }}
        tabs={[
          { value: 'sugestoes', label: 'Sugestões' },
          { value: 'surtos', label: 'Notificações de surto' },
        ]}
      >
        <TabPanel value="surtos">
          {aberto ? (
            <SurtoDetalhe key={aberto} id={aberto} opcoes={opcoes} onVoltar={() => setAberto(null)} onMudou={mudou} />
          ) : (
            <SurtoLista versao={versao} onAbrir={setAberto} onNovo={() => setNovo({ sugestao: null })} />
          )}
        </TabPanel>
        <TabPanel value="sugestoes">
          <SurtoSugestoes key={versao} opcoes={opcoes} onAbrir={(s) => setNovo({ sugestao: s })} />
        </TabPanel>
      </Tabs>
      {novo && (
        <SurtoNovo
          sugestao={novo.sugestao}
          opcoes={opcoes}
          onFechar={() => setNovo(null)}
          onCriado={(d) => {
            setNovo(null);
            mudou();
            setSecao('surtos');
            setAberto(d.id);
          }}
        />
      )}
    </div>
  );
}
