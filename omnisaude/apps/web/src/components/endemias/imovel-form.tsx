'use client';

import { avaliarGps, TIPO_IMOVEL, type OperacaoAce } from '@omnisaude/shared';
import { LocateFixed } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { obterPosicao, uuid, type Posicao } from '@/lib/offline';

/**
 * Imóvel encontrado em campo que não está no cadastro (reconhecimento geográfico): quarteirão, sequência, tipo e
 * endereço, com o GPS opcional. Vai para a fila e já pode ser visitado antes de sincronizar.
 */
export function ImovelForm({
  aberto,
  onClose,
  quarteirao,
  onSalvar,
}: {
  aberto: boolean;
  onClose: () => void;
  quarteirao: { id: string; numero: string } | null;
  onSalvar: (op: Extract<OperacaoAce, { tipo: 'IMOVEL' }>, rotulo: string) => Promise<void>;
}) {
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

  useEffect(() => {
    if (!aberto) return;
    setTipo('01');
    setSequencia('');
    setRua('');
    setNumero('');
    setComplemento('');
    setObs('');
    setPosicao(null);
    setErro(null);
  }, [aberto]);

  const localizar = async () => {
    setLocalizando(true);
    setErro(null);
    try {
      setPosicao(await obterPosicao());
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setLocalizando(false);
    }
  };

  const salvar = async () => {
    if (!quarteirao) return;
    if (!rua.trim() && !obs.trim()) {
      setErro('Informe o logradouro ou uma referência do imóvel');
      return;
    }
    const gpsRuim = posicao?.precisao != null && avaliarGps(posicao.precisao) === 'NOVA_LEITURA';
    setSalvando(true);
    try {
      await onSalvar(
        {
          tipo: 'IMOVEL',
          clientId: uuid(),
          registradoEm: new Date().toISOString(),
          dados: {
            blockId: quarteirao.id,
            sequencia: sequencia.trim() || null,
            propertyType: tipo,
            street: rua.trim() || null,
            number: numero.trim() || null,
            complement: complemento.trim() || null,
            latitude: posicao && !gpsRuim ? posicao.latitude : null,
            longitude: posicao && !gpsRuim ? posicao.longitude : null,
            precisaoGps: posicao && !gpsRuim ? posicao.precisao : null,
            observacoes: obs.trim() || null,
          },
        },
        `Imóvel novo · Q ${quarteirao.numero} · ${[rua.trim(), numero.trim()].filter(Boolean).join(', ') || obs.trim()}`,
      );
      onClose();
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Dialog
      open={aberto}
      onOpenChange={(o) => !o && onClose()}
      title="Imóvel novo no quarteirão"
      description={quarteirao ? `Quarteirão ${quarteirao.numero}` : undefined}
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
            <Input id="im-seq" value={sequencia} onChange={(e) => setSequencia(e.target.value.toUpperCase())} maxLength={12} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Logradouro" htmlFor="im-rua" className="sm:col-span-2">
            <Input id="im-rua" value={rua} onChange={(e) => setRua(e.target.value)} maxLength={160} />
          </Field>
          <Field label="Número" htmlFor="im-num">
            <Input id="im-num" value={numero} onChange={(e) => setNumero(e.target.value)} maxLength={20} />
          </Field>
        </div>
        <Field label="Complemento" htmlFor="im-comp">
          <Input id="im-comp" value={complemento} onChange={(e) => setComplemento(e.target.value)} maxLength={80} />
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
          <Textarea id="im-obs" rows={2} value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Ex.: borracharia, terreno com entulho, casa sem número" />
        </Field>
        {erro && <Alert tone="error">{erro}</Alert>}
      </div>
    </Dialog>
  );
}
