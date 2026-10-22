import { WrongPasswordError } from '@sigilo/core';
import { LockedError, RelayError } from '@sigilo/core/v2';

/** Mensagem em português para erros que a pessoa precisa entender. */
export function errorText(err: unknown): string {
  if (err instanceof WrongPasswordError) return 'Senha incorreta';
  if (err instanceof LockedError) return 'O cofre está trancado';
  if (err instanceof RelayError) {
    if (err.status === 0) return 'Sem conexão com o relé. Verifique a internet e o endereço.';
    if (err.status === 429) return 'Muitas tentativas. Aguarde um instante.';
    return err.message;
  }
  return err instanceof Error ? err.message : 'Algo deu errado';
}
