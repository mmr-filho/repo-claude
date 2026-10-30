'use client';

import { CBO_SUGESTOES, ROLE_LABELS, ROLES, type Role } from '@omnisaude/shared';
import { Copy, KeyRound, Pencil, Plus, ShieldOff, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime, formatCpf } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { AdminUnit, AdminUser, AssignmentDraft } from './types';

interface Staged {
  id: string;
  name: string;
  cpf: string | null;
  cns: string | null;
  cbo: string;
  cboLabel: string | null;
  council: string | null;
  unitId: string | null;
  unitName: string | null;
  suggestedRole: Role;
}

const emptyPerson = { cpf: '', name: '', socialName: '', cns: '', email: '', phone: '' };
type Person = typeof emptyPerson;
const newRow = (unitId = ''): AssignmentDraft => ({ unitId, role: '', cbo: '', council: '' });

/**
 * Cadastro dos profissionais e das lotações (unidade + papel + CBO). O profissional novo recebe uma senha
 * provisória, mostrada uma vez, e precisa trocá-la no primeiro acesso.
 */
export function UsersAdmin() {
  const toast = useToast();
  const session = useSession();
  const [q, setQ] = useState('');
  const [unitId, setUnitId] = useState('');
  const [role, setRole] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const query = new URLSearchParams({ ...(q ? { q } : {}), ...(unitId ? { unitId } : {}), ...(role ? { role } : {}), ...(showInactive ? { includeInactive: 'true' } : {}) }).toString();
  const { data, loading, error, reload } = useApi<AdminUser[]>(`/admin/users?${query}`, [query]);
  const units = useApi<AdminUnit[]>('/admin/units');
  const [editing, setEditing] = useState<{ id: string | null; person: Person; rows: AssignmentDraft[]; stagedId?: string | null } | null>(null);
  const staged = useApi<Staged[]>('/admin/cnes/pre-cadastro');
  const [password, setPassword] = useState<{ name: string; value: string; reset: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ user: AdminUser; kind: 'password' | 'mfa' | 'deactivate' } | null>(null);

  function open(user?: AdminUser) {
    if (user) {
      setEditing({
        id: user.id,
        person: { cpf: formatCpf(user.cpf), name: user.name, socialName: user.socialName ?? '', cns: user.cns ?? '', email: user.email ?? '', phone: user.phone ?? '' },
        rows: user.assignments.filter((a) => a.active).map((a) => ({ unitId: a.unitId, role: a.role, cbo: a.cbo, council: a.council ?? '' })),
      });
    } else {
      setEditing({ id: null, person: { ...emptyPerson }, rows: [newRow(session.me?.context.unitId ?? '')] });
    }
  }

  const rowsValid = (rows: AssignmentDraft[]) => rows.length > 0 && rows.every((r) => r.unitId && r.role && /^\d{6}$/.test(r.cbo));

  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      const person = { ...editing.person, cpf: editing.person.cpf.replace(/\D/g, ''), cns: editing.person.cns.replace(/\D/g, '') || null };
      const assignments = editing.rows.map((r) => ({ unitId: r.unitId, role: r.role, cbo: r.cbo, council: r.council || null }));
      if (editing.id) {
        await api.patch(`/admin/users/${editing.id}`, person);
        await api.put(`/admin/users/${editing.id}/assignments`, assignments);
        toast.success('Profissional atualizado');
      } else {
        const res = await api.post<{ user: AdminUser; provisionalPassword: string }>('/admin/users', { ...person, assignments, stagedId: editing.stagedId ?? null });
        setPassword({ name: res.user.name, value: res.provisionalPassword, reset: false });
        if (editing.stagedId) await staged.reload();
      }
      setEditing(null);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runConfirm() {
    if (!confirm) return;
    const { user, kind } = confirm;
    setBusy(true);
    try {
      if (kind === 'password') {
        const res = await api.post<{ provisionalPassword: string }>(`/admin/users/${user.id}/reset-password`);
        setPassword({ name: user.name, value: res.provisionalPassword, reset: true });
      } else if (kind === 'mfa') {
        await api.post(`/admin/users/${user.id}/mfa/reset`);
        toast.success('Autenticador removido: o profissional configura outro no próximo acesso');
      } else {
        await api.patch(`/admin/users/${user.id}`, { active: false });
        toast.success('Profissional desativado');
      }
      setConfirm(null);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function reactivate(user: AdminUser) {
    try {
      await api.patch(`/admin/users/${user.id}`, { active: true });
      toast.success('Profissional reativado');
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const p = editing?.person;
  const setP = (patch: Partial<Person>) => setEditing((e) => (e ? { ...e, person: { ...e.person, ...patch } } : e));
  const setRow = (i: number, patch: Partial<AssignmentDraft>) => setEditing((e) => (e ? { ...e, rows: e.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) } : e));

  return (
    <Card>
      <CardHeader
        title="Profissionais"
        description="Quem acessa o sistema, com as lotações (unidade, papel e ocupação CBO) que definem as permissões."
        actions={
          <Button onClick={() => open()}>
            <Plus className="h-4 w-4" /> Novo profissional
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-3 p-0">
        <div className="flex flex-wrap items-end gap-3 px-4 pt-4">
          <Field label="Buscar" htmlFor="f-q" className="min-w-56 flex-1">
            <Input id="f-q" placeholder="Nome ou CPF" value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
          <Field label="Unidade" htmlFor="f-unit">
            <Select id="f-unit" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">Todas</option>
              {units.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Papel" htmlFor="f-role">
            <Select id="f-role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">Todos</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 pb-2 text-sm text-slate-600">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Mostrar desativados
          </label>
        </div>
        {error && <Alert tone="error" className="mx-4">{error}</Alert>}
        <div className="overflow-x-auto">
          {loading && !data ? (
            <Spinner className="py-10" />
          ) : !data?.length ? (
            <EmptyState title="Nenhum profissional encontrado" icon={<UserRound className="h-6 w-6" />} />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Profissional</TH>
                  <TH>Lotações</TH>
                  <TH>Acesso</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {data.map((u) => {
                  const self = u.id === session.me?.user.id;
                  return (
                    <TR key={u.id}>
                      <TD>
                        <p className="font-medium">
                          {u.socialName ?? u.name}
                          {u.socialName && <span className="text-xs text-slate-500"> ({u.name})</span>}
                        </p>
                        <p className="text-xs text-slate-500">
                          CPF {formatCpf(u.cpf)}
                          {u.email ? ` · ${u.email}` : ''}
                        </p>
                      </TD>
                      <TD>
                        <ul className="flex flex-col gap-0.5 text-sm">
                          {u.assignments
                            .filter((a) => a.active)
                            .map((a) => (
                              <li key={a.id}>
                                {a.unitName} · {a.roleLabel} <span className="text-xs text-slate-500">CBO {a.cbo}</span>
                              </li>
                            ))}
                        </ul>
                      </TD>
                      <TD>
                        <div className="flex flex-wrap gap-1">
                          {!u.active ? <Badge tone="slate">Desativado</Badge> : u.mustChangePassword ? <Badge tone="amber">Senha provisória</Badge> : <Badge tone="green">Ativo</Badge>}
                          {u.locked && <Badge tone="red">Bloqueado</Badge>}
                          {u.mfaEnabled && <Badge tone="blue">2FA</Badge>}
                        </div>
                        <p className="mt-1 text-xs text-slate-500">{u.lastLoginAt ? `Último acesso ${fmtDateTime(u.lastLoginAt)}` : 'Nunca acessou'}</p>
                      </TD>
                      <TD className="whitespace-nowrap text-right">
                        <Button size="sm" variant="ghost" onClick={() => open(u)}>
                          <Pencil className="h-4 w-4" /> Editar
                        </Button>
                        {!self && u.active && (
                          <>
                            <Button size="sm" variant="ghost" title="Gera uma senha provisória e desbloqueia a conta" onClick={() => setConfirm({ user: u, kind: 'password' })}>
                              <KeyRound className="h-4 w-4" /> Senha
                            </Button>
                            {u.mfaEnabled && (
                              <Button size="sm" variant="ghost" title="Remove o autenticador (aparelho perdido)" onClick={() => setConfirm({ user: u, kind: 'mfa' })}>
                                <ShieldOff className="h-4 w-4" /> 2FA
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => setConfirm({ user: u, kind: 'deactivate' })}>
                              Desativar
                            </Button>
                          </>
                        )}
                        {!u.active && (
                          <Button size="sm" variant="ghost" onClick={() => reactivate(u)}>
                            Reativar
                          </Button>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </div>
      </CardBody>

      <Dialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing?.id ? 'Editar profissional' : 'Novo profissional'}
        description={editing?.id ? 'As lotações removidas ficam inativas; o histórico é preservado.' : 'Uma senha provisória será gerada e mostrada uma única vez.'}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button loading={busy} disabled={!p || p.name.trim().length < 5 || p.cpf.replace(/\D/g, '').length !== 11 || !rowsValid(editing?.rows ?? [])} onClick={save}>
              {editing?.id ? 'Salvar' : 'Cadastrar e gerar senha'}
            </Button>
          </>
        }
      >
        {p && editing && (
          <div className="flex flex-col gap-5">
            {!editing.id && !!staged.data?.length && (
              <Field label="Preencher a partir do pré-cadastro do CNES" htmlFor="p-staged" hint={`${staged.data.length} profissional(is) importado(s) ainda sem acesso`}>
                <Select
                  id="p-staged"
                  value={editing.stagedId ?? ''}
                  onChange={(e) => {
                    const st = staged.data?.find((x) => x.id === e.target.value);
                    if (!st) {
                      setEditing((ed) => (ed ? { ...ed, stagedId: null } : ed));
                      return;
                    }
                    setEditing((ed) =>
                      ed
                        ? {
                            ...ed,
                            stagedId: st.id,
                            person: { ...ed.person, name: st.name, cpf: st.cpf ? formatCpf(st.cpf) : ed.person.cpf, cns: st.cns ?? '' },
                            rows: [{ unitId: st.unitId ?? '', role: st.suggestedRole, cbo: st.cbo, council: st.council ?? '' }],
                          }
                        : ed,
                    );
                  }}
                >
                  <option value="">Não usar</option>
                  {staged.data.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.name} · {st.cboLabel ?? `CBO ${st.cbo}`}
                      {st.unitName ? ` · ${st.unitName}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="CPF" htmlFor="p-cpf">
                <Input id="p-cpf" inputMode="numeric" value={p.cpf} onChange={(e) => setP({ cpf: formatCpf(e.target.value.replace(/\D/g, '').slice(0, 11)) })} disabled={!!editing.id} autoFocus={!editing.id} />
              </Field>
              <Field label="Cartão SUS (CNS)" htmlFor="p-cns" hint="opcional">
                <Input id="p-cns" inputMode="numeric" maxLength={15} value={p.cns} onChange={(e) => setP({ cns: e.target.value.replace(/\D/g, '') })} />
              </Field>
              <Field label="Nome completo" htmlFor="p-name">
                <Input id="p-name" value={p.name} onChange={(e) => setP({ name: e.target.value })} />
              </Field>
              <Field label="Nome social" htmlFor="p-social" hint="opcional">
                <Input id="p-social" value={p.socialName} onChange={(e) => setP({ socialName: e.target.value })} />
              </Field>
              <Field label="E-mail" htmlFor="p-email">
                <Input id="p-email" type="email" value={p.email} onChange={(e) => setP({ email: e.target.value })} />
              </Field>
              <Field label="Telefone" htmlFor="p-phone">
                <Input id="p-phone" value={p.phone} onChange={(e) => setP({ phone: e.target.value })} />
              </Field>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Lotações</h3>
                <Button size="sm" variant="secondary" onClick={() => setEditing((e) => (e ? { ...e, rows: [...e.rows, newRow()] } : e))}>
                  <Plus className="h-4 w-4" /> Adicionar
                </Button>
              </div>
              <div className="flex flex-col gap-2">
                {editing.rows.map((r, i) => (
                  <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-slate-200 p-2 sm:grid-cols-[1fr_1fr_8rem_1fr_auto]">
                    <Select aria-label="Unidade" value={r.unitId} onChange={(e) => setRow(i, { unitId: e.target.value })}>
                      <option value="">Unidade…</option>
                      {units.data?.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </Select>
                    <Select aria-label="Papel" value={r.role} onChange={(e) => setRow(i, { role: e.target.value as Role })}>
                      <option value="">Papel…</option>
                      {ROLES.map((x) => (
                        <option key={x} value={x}>
                          {ROLE_LABELS[x]}
                        </option>
                      ))}
                    </Select>
                    <Input aria-label="CBO" list="cbo-sugestoes" placeholder="CBO" inputMode="numeric" maxLength={6} value={r.cbo} onChange={(e) => setRow(i, { cbo: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
                    <Input aria-label="Conselho" placeholder="Conselho (CRM-TO 1234)" value={r.council} onChange={(e) => setRow(i, { council: e.target.value })} />
                    <Button size="icon" variant="ghost" aria-label="Remover lotação" disabled={editing.rows.length === 1} onClick={() => setEditing((e) => (e ? { ...e, rows: e.rows.filter((_, j) => j !== i) } : e))}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <datalist id="cbo-sugestoes">
                {CBO_SUGESTOES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </datalist>
              <p className="mt-2 text-xs text-slate-500">CBO: ocupação com 6 dígitos (ex.: 225125 médico clínico, 223505 enfermeiro). O papel define as permissões; a CBO vai para o faturamento.</p>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.kind === 'password' ? 'Redefinir senha' : confirm?.kind === 'mfa' ? 'Remover autenticador' : 'Desativar profissional'}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              Cancelar
            </Button>
            <Button variant={confirm?.kind === 'deactivate' ? 'danger' : 'primary'} loading={busy} onClick={runConfirm}>
              Confirmar
            </Button>
          </>
        }
      >
        {confirm && (
          <p className="text-sm text-slate-700">
            {confirm.kind === 'password' && (
              <>
                Uma senha provisória será gerada para <b>{confirm.user.name}</b>. A senha atual deixa de valer, a conta é desbloqueada e a troca é exigida no próximo acesso.
              </>
            )}
            {confirm.kind === 'mfa' && (
              <>
                O autenticador de <b>{confirm.user.name}</b> será removido. No próximo acesso, se o papel exigir, outro autenticador será configurado.
              </>
            )}
            {confirm.kind === 'deactivate' && (
              <>
                <b>{confirm.user.name}</b> perde o acesso imediatamente, inclusive nas sessões abertas. O histórico de atendimentos é preservado.
              </>
            )}
          </p>
        )}
      </Dialog>

      <Dialog open={!!password} onOpenChange={(o) => !o && setPassword(null)} title={password?.reset ? 'Senha provisória gerada' : 'Profissional cadastrado'} size="sm">
        {password && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-slate-700">
              Entregue a senha provisória a <b>{password.name}</b>. Ela é mostrada <b>uma única vez</b> e precisa ser trocada no primeiro acesso.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-slate-100 px-3 py-2 text-center font-mono text-lg tracking-wider">{password.value}</code>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Copiar senha"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(password.value);
                    toast.success('Senha copiada');
                  } catch {
                    toast.error('Não foi possível copiar; anote a senha');
                  }
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <Alert tone="info">Login: instituição {session.me?.tenant.slug}, CPF do profissional e esta senha.</Alert>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
