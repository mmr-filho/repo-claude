'use client';

import { SignatureValidator } from '@/components/signatures/signature-validator';
import { PageHeader } from '@/components/ui/card';

export default function ValidateSignaturePage() {
  return (
    <>
      <PageHeader title="Validar documento assinado" description="Confira a assinatura digital de um PDF: atestados, receitas e registros emitidos aqui ou em outro sistema (padrão ICP-Brasil, PAdES/CAdES)." />
      <SignatureValidator />
    </>
  );
}
