'use client';

import { avaliarGps, conferirImovelCampo, LIMITES_CAMPO_ACE, TIPO_IMOVEL, type ImovelCampo } from '@omnisaude/shared';
import { LocateFixed } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import type { ImovelOp } from '@/lib/ace-campo';
import { obterPosicao, uuid, type Posicao } from '@/lib/offline';
import { falhaAoGuardar } from './visita-vetorial-form';

const L = LIMITES_CAMPO_ACE;

/**
 * Imóvel encontrado em campo que não está no cadastro (reconhecimento geográfico): quarteirão, sequência, tipo e
 * endereço, com o GPS opcional. Vai para a fila e já pode ser visitado antes de sincronizar. Com `inicial`, corrige o
 * imóvel recusado no envio (mesmo clientId), inclusive trocando o quarteirão.
 */
export function ImovelForm({
  aberto,
  onClose,
  quarteirao,
  quarteiroes,
  inicial,
  onSalvar,
}: {
  aberto: boolean;
  onClose: () => void;
  quarteirao: { id: string; numero: string } | null;
  /** Quarteirões do pacote, para trocar o quarteirão na correção. */
  quarteiroes?: { id: string; numero: string; ativo: boolean }[];
  /** Imóvel da fila que está sendo corrigido. */
  inicial?: ImovelOp | null;
  /** Guarda no aparelho; rejeita se não conseguiu (o diálogo continua aberto com a mensagem). */
  onSalvar: (op: ImovelOp, rotulo: string) => Promise<void>;
}) {
  const [blockId, setBlockId] = useState('');
  const [tipo, setTipo] = useState('01');
  const [sequencia, setSequencia] = useState('');
  const [rua, setRua] = useState('');
  const [numero, setNumero] = useState('');
  const [complemento, setComplemento] = useState('');
  const [obs, setObs] = useState('');
  const [posicao, setPosicao] = useState<Posicao | null>(null);
  const [localizando, setLocalizando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  // A leitura do GPS pedida numa abertura é descartada se o diálogo fechou ou abriu para outro imóvel.
  const geracao = useRef(0);

  useEffect(() => {
    geracao.current += 1;
    setLocalizando(false);
    if (!aberto) return;
    const d: Partial<ImovelCampo> = inicial?.dados ?? {};
    setBlockId(d.blockId ?? quarteirao?.id ?? '');
    setTipo(d.propertyType ?? '01');
    setSequencia(d.sequencia ?? '');
    setRua(d.street ?? '');
    setNumero(d.number ?? '');
    setComplemento(d.complement ?? '');
    setObs(d.observacoes ?? '');
    setPosicao(d.latitude != null && d.longitude != null ? { latitude: d.latitude, longitude: d.longitude, precisao: d.precisaoGps ?? null } : null);
    setErro(null);
  }, [aberto, inicial, quarteirao]);

  const localizar = async () => {
    const g = geracao.current;
    setLocalizando(true);
    setErro(null);
    try {
      const p = await obterPosicao();
      if (g === geracao.current) setPosicao(p);
    } catch (e) {
      if (g === geracao.current) setErro(e instanceof Error ? e.message : String(e));
    } finally {
      if (g === geracao.current) setLocalizando(false);
    }
  };

  const numeroDoQuarteirao = (id: string) => quarteiroes?.find((q) => q.id === id)?.numero ?? (id === quarteirao?.id ? quarteirao.numero : '?');

  const salvar = async () => {
    if (!blockId) return;
    const gpsRuim = posicao?.precisao != null && avaliarGps(posicao.precisao) === 'NOVA_LEITURA';
    const dados: ImovelCampo = {
      blockId,
      sequencia: sequencia.trim() || null,
      propertyType: tipo,
      street: rua.trim() || null,
      number: numero.trim() || null,
      complement: complemento.trim() || null,
      latitude: posicao && !gpsRuim ? posicao.latitude : null,
      longitude: posicao && !gpsRuim ? posicao.longitude : null,
      precisaoGps: posicao && !gpsRuim ? posicao.precisao : null,
      observacoes: obs.trim() || null,
    };
    const problemas = conferirImovelCampo(dados);
    if (problemas.length) {
      setErro(problemas.join('; '));
      return;
    }
    setSalvando(true);
    try {
      await onSalvar(
        { tipo: 'IMOVEL', clientId: inicial?.clientId ?? uuid(), registradoEm: inicial?.registradoEm ?? new Date().toISOString(), dados },
        `Imóvel novo · Q ${numeroDoQuarteirao(blockId)} · ${[rua.trim(), numero.trim()].filter(Boolean).join(', ') || obs.trim()}`,
      );
    } catch (e) {
      setErro(falhaAoGuardar(e));
      return;
    } finally {
      setSalvando(false);
    }
    onClose();
  };

  const opcoes = [...(quarteiroes ?? [])].sort((a, b) => a.numero.localeCompare(b.numero, 'pt-BR', { numeric: true }));

  return (
    <Dialog
      open={aberto}
      onOpenChange={(o) => !o && onClose()}
      title={inicial ? 'Corrigir o imóvel novo' : 'Imóvel novo no quarteirão'}
      description={blockId ? `Quarteirão ${numeroDoQuarteirao(blockId)}` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={salvar} loading={salvando}>
            Salvar no aparelho
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {inicial && opcoes.length > 0 && (
          <Field label="Quarteirão" htmlFor="im-quarteirao" hint="O imóvel e as visitas registradas nele vão juntos para o quarteirão escolhido">
            <Select id="im-quarteirao" value={blockId} onChange={(e) => setBlockId(e.target.value)}>
              {!opcoes.some((q) => q.id === blockId) && <option value={blockId}>Quarteirão {numeroDoQuarteirao(blockId)} (fora do pacote)</option>}
              {opcoes.map((q) => (
                <option key={q.id} value={q.id}>
                  Quarteirão {q.numero}
                  {q.ativo ? '' : ' (desativado na malha)'}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Tipo de imóvel" htmlFor="im-tipo" className="sm:col-span-2">
            <Select id="im-tipo" value={tipo} onChange={(e) => setTipo(e.target.value)}>
              {Object.entries(TIPO_IMOVEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Sequência" htmlFor="im-seq" hint="Número do imóvel no quarteirão">
            <Input id="im-seq" value={sequencia} onChange={(e) => setSequencia(e.target.value.toUpperCase())} maxLength={L.sequencia} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Logradouro" htmlFor="im-rua" className="sm:col-span-2">
            <Input id="im-rua" value={rua} onChange={(e) => setRua(e.target.value)} maxLength={L.logradouro} />
          </Field>
          <Field label="Número" htmlFor="im-num">
            <Input id="im-num" value={numero} onChange={(e) => setNumero(e.target.value)} maxLength={L.numero} />
          </Field>
        </div>
        <Field label="Complemento" htmlFor="im-comp">
          <Input id="im-comp" value={complemento} onChange={(e) => setComplemento(e.target.value)} maxLength={L.complemento} />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={localizar} loading={localizando}>
            <LocateFixed className="mr-1 h-4 w-4" /> Marcar minha posição
          </Button>
          <span className="text-sm text-slate-600">
            {posicao
              ? `${posicao.latitude}, ${posicao.longitude}${posicao.precisao ? ` (±${posicao.precisao} m)` : ''}${posicao.precisao != null && avaliarGps(posicao.precisao) === 'NOVA_LEITURA' ? ' · acima de 50 m: não será usada' : ''}`
              : 'Na frente do imóvel, para ele aparecer no mapa'}
          </span>
        </div>
        <Field label="Observação" htmlFor="im-obs">
          <Textarea id="im-obs" rows={2} maxLength={L.observacaoImovel} value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Ex.: borracharia, terreno com entulho, casa sem número" />
        </Field>
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}
