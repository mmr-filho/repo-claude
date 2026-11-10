'use client';

import { ROTULO_FONTE_POPULACAO, type EstimativaPopulacao, type FontePopulacao, type ListaPopulacao, type NivelTerritorio, type RespostaPopulacao } from '@omnisaude/shared';
import { ClipboardPaste, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { corpoDaPopulacao, errosDoLote, gruposDePopulacao, lerPopulacaoColada, NOTA_MAXIMA, VERSAO_MAXIMA } from './populacao-colar';

const FONTES = Object.keys(ROTULO_FONTE_POPULACAO) as FontePopulacao[];

/** Colar "ano;população" para o território escolhido, com a fonte, a versão e uma nota. */
function ColarPopulacao({ nivel, territorio, nomeTerritorio, onGravado }: { nivel: NivelTerritorio; territorio: string | null; nomeTerritorio: string; onGravado: () => void }) {
  const toast = useToast();
  const [texto, setTexto] = useState('');
  const [fonte, setFonte] = useState<FontePopulacao>(nivel === 'MUNICIPIO' ? 'IBGE_DOU' : 'CENSO_2022');
  const [versao, setVersao] = useState('');
  const [nota, setNota] = useState('');
  const [gravando, setGravando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const lido = useMemo(() => lerPopulacaoColada(texto, fonte), [texto, fonte]);
  const errosLote = errosDoLote({ versao, nota });
  const pode = lido.linhas.length > 0 && !lido.erros.length && !errosLote.length;

  async function gravar() {
    setGravando(true);
    setErro(null);
    try {
      const r = await api.put<RespostaPopulacao>('/vigilancia/populacao', { ...corpoDaPopulacao(lido.linhas, { nivel, territorioId: territorio }, { fonte, versao, nota }) });
      toast.success(`População gravada: ${r.criadas} nova(s) e ${r.atualizadas} atualizada(s).`);
      setTexto('');
      onGravado();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setGravando(false);
    }
  }

  return (
    <Card>
      <CardHeader title={`Colar estimativas: ${nomeTerritorio}`} description='Uma linha por ano, "ano;população" (cópia de planilha também serve). A mesma chave (ano, fonte e versão) é atualizada.' />
      <CardBody className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Fonte" htmlFor="pop-fonte">
            <Select id="pop-fonte" value={fonte} onChange={(e) => setFonte(e.target.value as FontePopulacao)}>
              {FONTES.map((f) => (
                <option key={f} value={f}>
                  {ROTULO_FONTE_POPULACAO[f]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Versão" htmlFor="pop-versao" hint={`Ex.: 2025 (a série da RIPSA é revista todo ano). Até ${VERSAO_MAXIMA} caracteres.`}>
            <Input id="pop-versao" value={versao} maxLength={VERSAO_MAXIMA} onChange={(e) => setVersao(e.target.value)} />
          </Field>
          <Field label="Nota (opcional)" htmlFor="pop-nota" hint={`Até ${NOTA_MAXIMA} caracteres.`}>
            <Input id="pop-nota" value={nota} maxLength={NOTA_MAXIMA} onChange={(e) => setNota(e.target.value)} />
          </Field>
        </div>
        <Field label="Ano;população" htmlFor="pop-texto">
          <Textarea id="pop-texto" rows={6} className="font-mono" placeholder={'2021;1.234.567\n2022;1.240.001\n2023;1.251.230'} value={texto} onChange={(e) => setTexto(e.target.value)} />
        </Field>
        {fonte === 'CENSO_2022' && (
          <p className="text-xs text-slate-500">O Censo 2022 só vale para o ano de 2022. Bairro e localidade sem estimativa anual usam a proporção do Censo 2022 sobre a estimativa do município.</p>
        )}
        {texto.trim() && (
          <p className="text-sm text-slate-700">
            {lido.linhas.length} linha(s) prontas{lido.erros.length ? `, ${lido.erros.length} com problema` : ''}.
          </p>
        )}
        {(lido.erros.length > 0 || errosLote.length > 0) && (
          <Alert tone="warn" title="Corrija antes de gravar">
            <ul className="list-inside list-disc">
              {errosLote.map((e) => (
                <li key={e}>{e}</li>
              ))}
              {lido.erros.slice(0, 20).map((e) => (
                <li key={`${e.linha}-${e.erro}`}>
                  Linha {e.linha}
                  {e.texto ? ` ("${e.texto}")` : ''}: {e.erro}
                </li>
              ))}
              {lido.erros.length > 20 && <li>E mais {lido.erros.length - 20} linha(s).</li>}
            </ul>
          </Alert>
        )}
        {erro && <Alert tone="error">{erro}</Alert>}
        <div className="flex justify-end">
          <Button onClick={gravar} loading={gravando} disabled={!pode}>
            <ClipboardPaste className="h-4 w-4" /> Gravar {lido.linhas.length || ''} estimativa(s)
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * Estimativas de população do território (por fonte e versão) e a edição pela vigilância (`vigilancia.consolidacao`):
 * colar "ano;população" e remover uma linha.
 */
export function PopulacaoEstimativas({
  nivel,
  territorio,
  nomeTerritorio,
  podeConfigurar,
  onMudou,
}: {
  nivel: NivelTerritorio;
  territorio: string | null;
  nomeTerritorio: string;
  podeConfigurar: boolean;
  onMudou: () => void;
}) {
  const toast = useToast();
  const pronto = nivel === 'MUNICIPIO' || !!territorio;
  const caminho = pronto ? `/vigilancia/populacao?nivel=${nivel}${nivel !== 'MUNICIPIO' && territorio ? `&territorio=${territorio}` : ''}` : null;
  const lista = useApi<ListaPopulacao>(caminho);
  const grupos = useMemo(() => gruposDePopulacao(lista.data ?? []), [lista.data]);
  const [remover, setRemover] = useState<EstimativaPopulacao | null>(null);
  const [removendo, setRemovendo] = useState(false);

  if (!pronto) return <Alert tone="info">Escolha {nivel === 'BAIRRO' ? 'o bairro' : 'a localidade'} para ver e editar a população.</Alert>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={`População: ${nomeTerritorio}`}
          description="A incidência de cada ano usa a população daquele ano, da mesma fonte e versão em todos os anos, inclusive o ano em análise. Ano em análise sem estimativa: repete o último ano da mesma fonte."
        />
        {lista.loading && !lista.data ? (
          <Spinner />
        ) : lista.error ? (
          <CardBody>
            <Alert tone="error">{lista.error}</Alert>
          </CardBody>
        ) : !grupos.length ? (
          <EmptyState
            title="Sem estimativa de população"
            description={
              nivel === 'MUNICIPIO'
                ? 'Sem população, o canal só pode ser calculado em número de casos.'
                : 'Sem estimativa do território, o sistema usa a proporção do Censo 2022 sobre a estimativa do município, quando houver as duas.'
            }
          />
        ) : (
          <CardBody className="space-y-5">
            {grupos.map((g) => (
              <div key={`${g.fonte}|${g.versao}`}>
                <p className="mb-1 text-sm font-medium text-slate-800">
                  {ROTULO_FONTE_POPULACAO[g.fonte]}
                  {g.versao ? `, versão ${g.versao}` : ''}
                </p>
                <Table>
                  <THead>
                    <tr>
                      <TH>Ano</TH>
                      <TH className="text-right">População</TH>
                      <TH>Nota</TH>
                      <TH>Atualizada em</TH>
                      {podeConfigurar && <TH />}
                    </tr>
                  </THead>
                  <TBody>
                    {g.linhas.map((e) => (
                      <TR key={e.id}>
                        <TD className="tabular-nums">{e.ano}</TD>
                        <TD className="text-right tabular-nums">{e.populacao.toLocaleString('pt-BR')}</TD>
                        <TD className="text-xs text-slate-600">{e.nota ?? ''}</TD>
                        <TD className="text-xs text-slate-600">{fmtDateTime(e.atualizadoEm)}</TD>
                        {podeConfigurar && (
                          <TD className="text-right">
                            <Button variant="ghost" size="sm" aria-label={`Remover a população de ${e.ano}`} onClick={() => setRemover(e)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TD>
                        )}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            ))}
          </CardBody>
        )}
      </Card>

      {podeConfigurar && (
        <ColarPopulacao
          key={`${nivel}-${territorio ?? ''}`}
          nivel={nivel}
          territorio={territorio}
          nomeTerritorio={nomeTerritorio}
          onGravado={() => {
            void lista.reload();
            onMudou();
          }}
        />
      )}

      <Dialog
        open={remover !== null}
        onOpenChange={(o) => !o && setRemover(null)}
        title={remover ? `Remover a população de ${remover.ano}` : 'Remover'}
        description={
          remover
            ? `${ROTULO_FONTE_POPULACAO[remover.fonte]}${remover.versao ? `, versão ${remover.versao}` : ''}: ${remover.populacao.toLocaleString('pt-BR')} habitantes. O canal congelado guarda a população que usou.`
            : undefined
        }
        footer={
          <Button
            variant="danger"
            loading={removendo}
            onClick={async () => {
              if (!remover) return;
              setRemovendo(true);
              try {
                await api.delete(`/vigilancia/populacao/${remover.id}`);
                toast.success('Estimativa removida.');
                setRemover(null);
                void lista.reload();
                onMudou();
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setRemovendo(false);
              }
            }}
          >
            Remover
          </Button>
        }
      >
        <p className="text-sm text-slate-700">A remoção fica na auditoria. A incidência dos diagramas não congelados muda na hora.</p>
      </Dialog>
    </div>
  );
}
