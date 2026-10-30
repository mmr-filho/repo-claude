'use client';

import { Dialog } from '@/components/ui/dialog';

/** Painel retrátil com a biblioteca de POPs (soft gates). Implementação completa em pops-library. */
export function PopsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Procedimentos operacionais padrão" size="lg">
      <p className="text-sm text-slate-600">Biblioteca de POPs.</p>
    </Dialog>
  );
}
