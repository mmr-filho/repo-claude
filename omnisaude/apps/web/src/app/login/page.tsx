'use client';

import { HeartPulse, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function LoginPage() {
  const session = useSession();
  const router = useRouter();
  const [tenant, setTenant] = useState(() => (typeof window !== 'undefined' ? (localStorage.getItem('omni.tenant') ?? '') : ''));
  const [cpf, setCpf] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'credentials' | 'mfa'>('credentials');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = stage === 'credentials' ? await session.login(tenant, cpf, password) : await session.verifyMfa(code);
      if (res.stage === 'mfa') {
        setStage('mfa');
        return;
      }
      try {
        localStorage.setItem('omni.tenant', tenant);
      } catch {
        // sem armazenamento: o usuário digita a instituição de novo
      }
      if (res.assignments.length === 1) {
        await session.selectContext(res.assignments[0]!.unitId, res.assignments[0]!.role);
        router.replace('/inicio');
      } else router.replace('/contexto');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-brand-700 via-brand-600 to-teal-600 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-white">
            <HeartPulse className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">OmniSaúde</h1>
            <p className="text-sm text-slate-500">Rede pública de saúde integrada</p>
          </div>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {stage === 'credentials' ? (
            <>
              <Field label="Instituição" htmlFor="tenant" hint="Código da prefeitura ou consórcio (ex.: demo)">
                <Input id="tenant" value={tenant} onChange={(e) => setTenant(e.target.value)} autoCapitalize="none" autoComplete="organization" required />
              </Field>
              <Field label="CPF" htmlFor="cpf">
                <Input id="cpf" value={cpf} onChange={(e) => setCpf(e.target.value)} inputMode="numeric" autoComplete="username" placeholder="000.000.000-00" required />
              </Field>
              <Field label="Senha" htmlFor="password">
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </Field>
            </>
          ) : (
            <Field label="Código de verificação" htmlFor="code" hint="Abra o aplicativo autenticador e digite o código de 6 dígitos">
              <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus required />
            </Field>
          )}
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit" size="lg" loading={pending}>
            {stage === 'credentials' ? 'Entrar' : (
              <>
                <ShieldCheck className="h-4 w-4" /> Verificar
              </>
            )}
          </Button>
        </form>
        <p className="mt-6 text-center text-xs text-slate-400">Acesso restrito a profissionais da rede. Todas as ações são registradas.</p>
      </div>
    </main>
  );
}
