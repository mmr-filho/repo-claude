'use client';

import { CRITERIO_CASO_SURTO, localDateString, MODO_TRANSMISSAO, VEICULO_TRANSMISSAO, type DetalheSurto } from '@omnisaude/shared';
import { Save, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { OpcaoAgravo } from './diagrama-agravos';
import { CamposAgravo, CamposLocal, CamposNotificacao } from './surto-campos';
import { aceitaDta, CAMPOS_DTA, corpoEdicao, formEdicao, pendenciasEdicao, type FormEdicaoSurto, type FormInvestigacao } from './surto-regras';

/**
 * Ficha do surto: os campos da notificação (17 a 19), o local de ocorrência, a investigação (data obrigatória para
 * encerrar, modo e veículo de transmissão) e o bloco resumido da ficha de DTA. Só o surto aberto se edita; a gravação
 * manda só o que mudou.
 */
export function SurtoFicha({ d, opcoes, onSalvo }: { d: DetalheSurto; opcoes: OpcaoAgravo[]; onSalvo: (novo: DetalheSurto) => void }) {
  const toast = useToast();
  const session = useSession();
  const tz = session.me?.tenant.timeZone ?? 'America/Sao_Paulo';
  const hoje = localDateString(new Date(), tz);
  const editavel = d.permissoes.editar;
  const [f, setF] = useState<FormEdicaoSurto>(() => formEdicao(d));
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const set = (patch: Partial<FormEdicaoSurto>) => setF((x) => ({ ...x, ...patch }));
  const setInv = (patch: Partial<FormInvestigacao>) => setF((x) => ({ ...x, investigacao: { ...x.investigacao, ...patch } }));
  const corpo = corpoEdicao(d, f);
  const mudou = Object.keys(corpo).length > 0;
  const pend = pendenciasEdicao(d, f, hoje);
  const dta = aceitaDta(f.categoria, f.investigacao.veiculo);

  async function salvar() {
    setBusy(true);
    setErro(null);
    try {
      const novo = await api.patch<DetalheSurto>(`/vigilancia/surtos/${d.id}`, { ...corpo });
      toast.success(`Surto ${novo.numero} atualizado.`);
      onSalvo(novo);
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {!editavel && <Alert tone="info">Surto {d.status === 'ENCERRADO' ? 'encerrado' : 'descartado'}: a ficha fica só para leitura.</Alert>}
      <Card>
        <CardHeader title="Notificação" description="Agravo e campos 17 a 19 da ficha de notificação. A unidade notificante e o instante do conhecimento não mudam depois de notificado." />
        <CardBody className="space-y-4 pt-4">
          <CamposAgravo prefixo="sf" f={f} set={set} opcoes={opcoes} disabled={!editavel} />
          <CamposNotificacao prefixo="sf" f={f} set={set} hoje={hoje} disabled={!editavel} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Local de ocorrência" description="Campos 20 a 33: onde o surto acontece (pode ser outro que a unidade notificante)." />
        <CardBody className="pt-4">
          <CamposLocal prefixo="sf-local" local={f.local} set={(patch) => set({ local: { ...f.local, ...patch } })} disabled={!editavel} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Investigação" description="Campos 24 a 26 da ficha de investigação de surto. A data da investigação é exigida para encerrar." />
        <CardBody className="grid gap-3 pt-4 md:grid-cols-3">
          <Field label="24. Data da investigação" htmlFor="sf-investigado">
            <Input id="sf-investigado" type="date" max={hoje} disabled={!editavel} value={f.investigacao.investigadoEm} onChange={(e) => setInv({ investigadoEm: e.target.value })} />
          </Field>
          <Field label="25. Modo provável de transmissão" htmlFor="sf-modo">
            <Select id="sf-modo" disabled={!editavel} value={f.investigacao.modoTransmissao} onChange={(e) => setInv({ modoTransmissao: e.target.value })}>
              <option value="">Não informado</option>
              {Object.entries(MODO_TRANSMISSAO).map(([c, n]) => (
                <option key={c} value={c}>
                  {c} - {n}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="26. Veículo de transmissão" htmlFor="sf-veiculo" hint={f.investigacao.veiculo === '1' ? 'Alimento/água abre o bloco da ficha de DTA.' : undefined}>
            <Select id="sf-veiculo" disabled={!editavel} value={f.investigacao.veiculo} onChange={(e) => setInv({ veiculo: e.target.value })}>
              <option value="">Não informado</option>
              {Object.entries(VEICULO_TRANSMISSAO).map(([c, n]) => (
                <option key={c} value={c}>
                  {c} - {n}
                </option>
              ))}
            </Select>
          </Field>
          {f.investigacao.veiculo === '6' && (
            <Field label="Qual veículo (outro)" htmlFor="sf-veiculo-texto">
              <Input id="sf-veiculo-texto" disabled={!editavel} maxLength={50} value={f.investigacao.veiculoTexto} onChange={(e) => setInv({ veiculoTexto: e.target.value })} />
            </Field>
          )}
          <Field label="Investigador" htmlFor="sf-investigador">
            <Input id="sf-investigador" disabled={!editavel} maxLength={120} value={f.investigacao.investigadorNome} onChange={(e) => setInv({ investigadorNome: e.target.value })} />
          </Field>
          <Field label="Função do investigador" htmlFor="sf-investigador-funcao">
            <Input id="sf-investigador-funcao" disabled={!editavel} maxLength={120} value={f.investigacao.investigadorFuncao} onChange={(e) => setInv({ investigadorFuncao: e.target.value })} />
          </Field>
          <Field label="Observações" htmlFor="sf-obs" className="md:col-span-3">
            <Textarea id="sf-obs" rows={3} disabled={!editavel} maxLength={4000} value={f.investigacao.observacoes} onChange={(e) => setInv({ observacoes: e.target.value })} />
          </Field>
        </CardBody>
      </Card>
      {dta && (
        <Card>
          <CardHeader
            title="Ficha de DTA (resumo)"
            description="Campos 27 a 60 da ficha de investigação de surto de DTA, resumidos. Pelo manual do Sinan, os dados de DTA se digitam depois de concluída a investigação."
          />
          <CardBody className="grid gap-3 pt-4 md:grid-cols-3">
            {CAMPOS_DTA.map((c) => (
              <Field key={c.variavel} label={`${c.rotulo} (${c.variavel})`} htmlFor={`sf-dta-${c.variavel}`}>
                {c.tipo === 'criterio' ? (
                  <Select id={`sf-dta-${c.variavel}`} disabled={!editavel} value={f.dta[c.variavel] ?? ''} onChange={(e) => set({ dta: { ...f.dta, [c.variavel]: e.target.value } })}>
                    <option value="">Não informado</option>
                    {Object.entries(CRITERIO_CASO_SURTO).map(([k, n]) => (
                      <option key={k} value={k}>
                        {k} - {n}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id={`sf-dta-${c.variavel}`}
                    type={c.tipo === 'data' ? 'date' : 'text'}
                    inputMode={c.tipo === 'numero' ? 'numeric' : undefined}
                    max={c.tipo === 'data' ? hoje : undefined}
                    maxLength={c.tipo === 'texto' ? 200 : undefined}
                    disabled={!editavel}
                    value={f.dta[c.variavel] ?? ''}
                    onChange={(e) => set({ dta: { ...f.dta, [c.variavel]: e.target.value } })}
                  />
                )}
              </Field>
            ))}
          </CardBody>
        </Card>
      )}
      {editavel && (
        <Card>
          <CardBody className="space-y-3">
            {mudou && pend.length > 0 && (
              <Alert tone="warn" title="Corrija antes de salvar">
                <ul className="list-inside list-disc space-y-0.5">
                  {pend.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {erro && <Alert tone="error">{erro}</Alert>}
            <div className="flex flex-wrap justify-end gap-2">
              {mudou && (
                <Button variant="ghost" onClick={() => setF(formEdicao(d))}>
                  <Undo2 className="h-4 w-4" /> Desfazer alterações
                </Button>
              )}
              <Button onClick={salvar} disabled={!mudou || pend.length > 0} loading={busy}>
                <Save className="h-4 w-4" /> Salvar a ficha
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
