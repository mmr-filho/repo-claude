'use client';

import { loadVLibrasWidget } from '@omnisaude/accessibility';
import { HandMetal } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';

/** Ativa o avatar VLibras (tradução do conteúdo da tela para Libras). */
export function VLibrasToggle() {
  const [loaded, setLoaded] = useState(false);
  const toast = useToast();
  return (
    <Button
      variant="ghost"
      size="icon"
      title="Tradução para Libras (VLibras)"
      aria-label="Ativar tradução para Libras (VLibras)"
      onClick={async () => {
        if (loaded) return;
        try {
          await loadVLibrasWidget({ position: 'R' });
          setLoaded(true);
          toast.info('VLibras ativado: selecione um texto ou use o botão azul para traduzir.');
        } catch {
          toast.error('Não foi possível carregar o VLibras (verifique a conexão).');
        }
      }}
    >
      <HandMetal className="h-5 w-5" />
    </Button>
  );
}
