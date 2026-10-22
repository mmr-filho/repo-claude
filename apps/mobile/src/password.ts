import { MIN_PASSWORD } from './config';

/** Mensagem de erro se a senha não pode ser aceita; indefinido se está ok. */
export function passwordProblem(password: string, confirm?: string): string | undefined {
  if (password.length < MIN_PASSWORD) return `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres`;
  if (confirm !== undefined && password !== confirm) return 'As senhas não conferem';
  return undefined;
}

/**
 * Aviso (não bloqueia) para senhas fáceis de adivinhar. A senha protege as chaves guardadas no aparelho:
 * se alguém conseguir copiar esses dados, uma senha curta pode ser descoberta por tentativa e erro.
 */
export function weakPasswordHint(password: string): string | undefined {
  if (password.length < MIN_PASSWORD) return undefined;
  if (/^\d+$/.test(password)) return 'Só números é fácil de adivinhar. Misture letras maiúsculas, minúsculas e números.';
  if (password.length < 10) return 'Senha curta: misture letras maiúsculas, minúsculas e números, ou use uma frase.';
  return undefined;
}
