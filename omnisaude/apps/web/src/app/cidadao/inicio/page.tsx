'use client';

import { CalendarDays, FlaskConical, MapPin, Phone, Scale, Syringe, Ticket } from 'lucide-react';
import Link from 'next/link';
import { CardItem, CitizenShell, Section } from '@/components/citizen/shell';
import { useCitizen } from '@/components/citizen/hooks';
import type { Eu } from '@/components/citizen/types';
import { Badge } from '@/components/ui/badge';
import { Alert, Spinner } from '@/components/ui/misc';
import { fmtDateTime } from '@/lib/format';

export default function CitizenHomePage() {
  const { data, error, loading } = useCitizen<Eu>('/cidadao/eu');
  return (
    <CitizenShell title="Minha saúde">
      {error && <Alert tone="error">{error}</Alert>}
      {loading && !data && <Spinner />}
      {data && (
        <>
          <CardItem className="mb-4 bg-brand-600 text-white">
            <p className="text-sm opacity-90">Olá,</p>
            <p className="text-2xl font-semibold">{data.cidadao.primeiroNome}</p>
            <p className="mt-1 text-sm opacity-90">
              {data.cidadao.idade} anos{data.cidadao.cns ? ` · CNS ${data.cidadao.cns}` : ''}
            </p>
          </CardItem>

          {data.senhaHoje && (
            <CardItem className="mb-4 border-amber-300 bg-amber-50">
              <div className="flex items-center gap-3">
                <Ticket className="h-8 w-8 text-amber-700" />
                <div className="flex-1">
                  <p className="text-xs uppercase text-amber-800">Sua senha hoje · {data.senhaHoje.unidade}</p>
                  <p className="text-3xl font-bold text-amber-900">{data.senhaHoje.senha}</p>
                  <p className="text-sm text-amber-900">
                    {data.senhaHoje.statusLabel}
                    {data.senhaHoje.posicao ? ` · ${data.senhaHoje.posicao}ª na fila` : ''}
                    {data.senhaHoje.guiche ? ` · ${data.senhaHoje.guiche}` : ''}
                  </p>
                </div>
              </div>
            </CardItem>
          )}

          <Section title="Próximo compromisso">
            {data.proximoAgendamento ? (
              <Link href="/cidadao/agenda">
                <CardItem>
                  <div className="flex items-start gap-3">
                    <CalendarDays className="mt-0.5 h-6 w-6 text-brand-600" />
                    <div className="flex-1">
                      <p className="font-medium">{data.proximoAgendamento.servico}</p>
                      <p className="text-sm text-slate-600">{fmtDateTime(data.proximoAgendamento.quando)}</p>
                      {data.proximoAgendamento.unidade && <p className="text-sm text-slate-500">{data.proximoAgendamento.unidade}</p>}
                    </div>
                    <Badge tone={data.proximoAgendamento.status === 'CONFIRMADO' ? 'green' : 'blue'}>{data.proximoAgendamento.statusLabel}</Badge>
                  </div>
                </CardItem>
              </Link>
            ) : (
              <CardItem className="text-sm text-slate-500">Nenhum agendamento marcado.</CardItem>
            )}
          </Section>

          <Section title="Precisa de atenção">
            <div className="grid grid-cols-3 gap-2">
              <Link href="/cidadao/exames">
                <CardItem className="text-center">
                  <FlaskConical className="mx-auto h-5 w-5 text-brand-600" />
                  <p className="mt-1 text-2xl font-semibold">{data.pendencias.examesNovos}</p>
                  <p className="text-xs text-slate-500">resultados novos</p>
                </CardItem>
              </Link>
              <Link href="/cidadao/vacinas">
                <CardItem className={`text-center ${data.pendencias.vacinasAtrasadas ? 'border-red-200 bg-red-50' : ''}`}>
                  <Syringe className="mx-auto h-5 w-5 text-brand-600" />
                  <p className="mt-1 text-2xl font-semibold">{data.pendencias.vacinasAtrasadas}</p>
                  <p className="text-xs text-slate-500">vacinas atrasadas</p>
                </CardItem>
              </Link>
              <Link href="/cidadao/regulacao">
                <CardItem className="text-center">
                  <Scale className="mx-auto h-5 w-5 text-brand-600" />
                  <p className="mt-1 text-2xl font-semibold">{data.pendencias.solicitacoesEmAndamento}</p>
                  <p className="text-xs text-slate-500">pedidos em andamento</p>
                </CardItem>
              </Link>
            </div>
          </Section>

          <Section title="Minha unidade de saúde">
            {data.unidadeReferencia ? (
              <CardItem>
                <p className="font-medium">{data.unidadeReferencia.name}</p>
                {data.unidadeReferencia.address && (
                  <p className="mt-1 flex items-center gap-1 text-sm text-slate-600">
                    <MapPin className="h-4 w-4" /> {data.unidadeReferencia.address}
                  </p>
                )}
                {data.unidadeReferencia.phone && (
                  <a href={`tel:${data.unidadeReferencia.phone.replace(/\D/g, '')}`} className="mt-1 flex items-center gap-1 text-sm text-brand-700">
                    <Phone className="h-4 w-4" /> {data.unidadeReferencia.phone}
                  </a>
                )}
                {data.unidadeReferencia.openingHours && <p className="mt-1 text-sm text-slate-500">{data.unidadeReferencia.openingHours}</p>}
              </CardItem>
            ) : (
              <CardItem className="text-sm text-slate-500">
                Seu cadastro ainda não está vinculado a uma unidade. Veja as{' '}
                <Link href="/cidadao/unidades" className="text-brand-700 underline">
                  unidades da rede
                </Link>
                .
              </CardItem>
            )}
          </Section>
        </>
      )}
    </CitizenShell>
  );
}
