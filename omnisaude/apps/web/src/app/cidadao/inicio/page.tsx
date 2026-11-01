'use client';

import { CalendarDays, ExternalLink, FlaskConical, MapPin, MessageSquareText, Phone, Scale, Star, Syringe, Ticket } from 'lucide-react';
import Link from 'next/link';
import { CardItem, CitizenShell, Section } from '@/components/citizen/shell';
import { useCitizen } from '@/components/citizen/hooks';
import type { Avaliacao, MeuSusDigital, Eu } from '@/components/citizen/types';
import { Badge } from '@/components/ui/badge';
import { Alert, Spinner } from '@/components/ui/misc';
import { fmtDateTime } from '@/lib/format';

export default function CitizenHomePage() {
  const { data, error, loading } = useCitizen<Eu>('/cidadao/eu');
  const avaliacoes = useCitizen<Avaliacao[]>('/cidadao/avaliacoes');
  const msd = useCitizen<MeuSusDigital>('/cidadao/meu-sus-digital');
  const pendentes = avaliacoes.data?.filter((a) => a.status === 'PENDENTE') ?? [];
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

          {pendentes.length > 0 && (
            <Link href="/cidadao/avaliar">
              <CardItem className="mb-4 border-amber-200 bg-amber-50">
                <p className="flex items-center gap-2 font-medium text-amber-900">
                  <Star className="h-5 w-5" /> Como foi seu atendimento na {pendentes[0]!.unidade}?
                </p>
                <p className="text-sm text-amber-800">Leva menos de um minuto e ajuda a melhorar o serviço.</p>
              </CardItem>
            </Link>
          )}

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
          <Section title="Ouvidoria">
            <Link href="/cidadao/ouvidoria">
              <CardItem className="flex items-center gap-3">
                <MessageSquareText className="h-6 w-6 text-brand-600" />
                <div>
                  <p className="font-medium">Reclamar, sugerir, elogiar ou denunciar</p>
                  <p className="text-xs text-slate-500">Protocolo na hora e resposta em até 30 dias.</p>
                </div>
              </CardItem>
            </Link>
          </Section>

          {msd.data && (
            <Section title="Meu SUS Digital">
              <CardItem>
                <p className="text-sm text-slate-700">
                  {msd.data.enviados.total > 0
                    ? `${msd.data.enviados.total} registro${msd.data.enviados.total > 1 ? 's' : ''} seu${msd.data.enviados.total > 1 ? 's' : ''} já ${msd.data.enviados.total > 1 ? 'foram enviados' : 'foi enviado'} à Rede Nacional de Dados em Saúde`
                    : 'Seus registros nesta rede são enviados à Rede Nacional de Dados em Saúde'}
                  {msd.data.enviados.total > 0
                    ? ` (${[msd.data.enviados.atendimentos ? `${msd.data.enviados.atendimentos} atendimentos` : null, msd.data.enviados.vacinas ? `${msd.data.enviados.vacinas} vacinas` : null, msd.data.enviados.dispensacoes ? `${msd.data.enviados.dispensacoes} retiradas de remédio` : null, msd.data.enviados.altas ? `${msd.data.enviados.altas} internações` : null].filter(Boolean).join(', ')})`
                    : ''}{' '}
                  e aparecem no app do Ministério da Saúde, com sua conta gov.br.
                </p>
                {!msd.data.prontidao.pronto && (
                  <ul className="mt-2 list-disc pl-5 text-xs text-amber-800">
                    {msd.data.prontidao.pendencias.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
                <a href={msd.data.link} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-brand-700 underline">
                  <ExternalLink className="h-4 w-4" /> Abrir o Meu SUS Digital
                </a>
              </CardItem>
            </Section>
          )}
        </>
      )}
    </CitizenShell>
  );
}
