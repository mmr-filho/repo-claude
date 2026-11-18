import { Card, EmptyState } from '@/components/ui/card';

/** Marcador das abas que as frentes da semana 27 ainda vão construir. */
export function EmConstrucao({ descricao }: { descricao: string }) {
  return (
    <Card>
      <EmptyState title="Em construção" description={descricao} />
    </Card>
  );
}
