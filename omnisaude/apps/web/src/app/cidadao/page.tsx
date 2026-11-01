'use client';

import { HeartPulse, MessageCircle, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { citizenApi, citizenStore, type CitizenSession } from '@/components/citizen/api';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';

interface Pedido {
  canal: 'whatsapp' | 'nenhum';
  telefone?: string | null;
  validadeMinutos?: number;
  orientacao?: string;
}

/** Entrada do cidadão: CPF e data de nascimento; o código chega pelo WhatsApp ou vem da recepção. */
export default function CitizenLoginPage() {
  const router = useRouter();
  const [tenant, setTenant] = useState('');
  const [cpf, setCpf] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [codigo, setCodigo] = useState('');
  const [etapa, setEtapa] = useState<'dados' | 'codigo'>('dados');
  const [pedido, setPedido] = useState<Pedido | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      setTenant(localStorage.getItem('omni.cidadao.tenant') ?? localStorage.getItem('omni.tenant') ?? '');
    } catch {
      // sem armazenamento
    }
    if (citizenStore.get()) router.replace('/cidadao/inicio');
  }, [router]);

  async function pedirCodigo(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    setBusy(true);
    try {
      const r = await citizenApi.public<Pedido>('/cidadao/acesso/solicitar', { tenant, cpf, birthDate });
      setPedido(r);
      setEtapa('codigo');
      try {
        localStorage.setItem('omni.cidadao.tenant', tenant);
      } catch {
        // idem
      }
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    setBusy(true);
    try {
      const s = await citizenApi.public<CitizenSession>('/cidadao/acesso/confirmar', { tenant, cpf, birthDate, codigo });
      citizenStore.set(s);
      router.replace('/cidadao/inicio');
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-brand-700 via-brand-600 to-teal-600 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-white">
            <HeartPulse className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Minha saúde</h1>
            <p className="text-sm text-slate-500">App do cidadão · OmniSaúde</p>
          </div>
        </div>
        {erro && (
          <Alert tone="error" className="mb-3">
            {erro}
          </Alert>
        )}
        {etapa === 'dados' ? (
          <form onSubmit={pedirCodigo} className="flex flex-col gap-3">
            <Field label="Município ou instituição" htmlFor="cid-tenant" hint="O mesmo nome usado pela sua unidade de saúde.">
              <Input id="cid-tenant" value={tenant} onChange={(e) => setTenant(e.target.value)} autoComplete="organization" required />
            </Field>
            <Field label="CPF" htmlFor="cid-cpf">
              <Input id="cid-cpf" value={cpf} onChange={(e) => setCpf(e.target.value)} inputMode="numeric" autoComplete="username" placeholder="000.000.000-00" required />
            </Field>
            <Field label="Data de nascimento" htmlFor="cid-nasc">
              <Input id="cid-nasc" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} required />
            </Field>
            <Button type="submit" loading={busy} size="lg" id="cid-pedir">
              <MessageCircle className="h-4 w-4" /> Receber código de acesso
            </Button>
            <p className="text-xs text-slate-500">O código chega no WhatsApp cadastrado na sua unidade. Sem WhatsApp, peça um código na recepção e informe aqui.</p>
            <Button type="button" variant="link" size="sm" onClick={() => setEtapa('codigo')} id="cid-tenho-codigo">
              Já tenho um código
            </Button>
          </form>
        ) : (
          <form onSubmit={entrar} className="flex flex-col gap-3">
            {pedido?.canal === 'whatsapp' && (
              <Alert tone="success" title={`Código enviado para ${pedido.telefone ?? 'seu WhatsApp'}`}>
                Vale por {pedido.validadeMinutos} minutos.
              </Alert>
            )}
            {pedido?.canal === 'nenhum' && <Alert tone="info">{pedido.orientacao}</Alert>}
            {!pedido && <p className="text-sm text-slate-600">Informe os seus dados e o código recebido pelo WhatsApp ou na recepção.</p>}
            {!pedido && (
              <>
                <Field label="Município ou instituição" htmlFor="cid-tenant2">
                  <Input id="cid-tenant2" value={tenant} onChange={(e) => setTenant(e.target.value)} required />
                </Field>
                <Field label="CPF" htmlFor="cid-cpf2">
                  <Input id="cid-cpf2" value={cpf} onChange={(e) => setCpf(e.target.value)} inputMode="numeric" required />
                </Field>
                <Field label="Data de nascimento" htmlFor="cid-nasc2">
                  <Input id="cid-nasc2" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} required />
                </Field>
              </>
            )}
            <Field label="Código de acesso" htmlFor="cid-codigo">
              <Input id="cid-codigo" value={codigo} onChange={(e) => setCodigo(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="text-center text-2xl tracking-[0.4em]" required />
            </Field>
            <Button type="submit" loading={busy} size="lg" id="cid-entrar">
              <ShieldCheck className="h-4 w-4" /> Entrar
            </Button>
            <Button type="button" variant="link" size="sm" onClick={() => setEtapa('dados')}>
              Pedir outro código
            </Button>
          </form>
        )}
        <p className="mt-4 text-center text-xs text-slate-400">Seus dados de saúde são protegidos pela LGPD e só aparecem para você.</p>
      </div>
    </main>
  );
}
