import { MIN_PASSWORD } from './config';

/** Texto da regra, para mostrar embaixo dos campos de senha. */
export const PASSWORD_RULE = `Mínimo de ${MIN_PASSWORD} caracteres, com letras e números. Símbolos (! @ # ...) e espaços são aceitos, mas não obrigatórios.`;

// Sem `\p{L}` de propósito: o Hermes pode não ter propriedades Unicode em expressões regulares. Letra = A-Z, as letras
// latinas acentuadas (ç, ã, é...) ou qualquer caractere que muda ao trocar maiúscula por minúscula (gregas, cirílicas...).
// Número é 0-9. (O intervalo explícito garante o português mesmo se o motor tratar mal a conversão de caixa.)
const isLetter = (ch: string) => /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]/.test(ch) || ch.toLowerCase() !== ch.toUpperCase();
const isDigit = (ch: string) => ch >= '0' && ch <= '9';

/** Mensagem de erro se a senha não pode ser aceita; indefinido se está ok. Só vale para quem ESCOLHE uma senha, nunca para destrancar. */
export function passwordProblem(password: string, confirm?: string): string | undefined {
  const chars = Array.from(password); // por caractere, não por unidade UTF-16 (um emoji conta 1)
  if (chars.length < MIN_PASSWORD) return `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres`;
  if (!chars.some(isLetter)) return 'A senha precisa ter pelo menos uma letra';
  if (!chars.some(isDigit)) return 'A senha precisa ter pelo menos um número';
  if (confirm !== undefined && password !== confirm) return 'As senhas não conferem';
  return undefined;
}

/**
 * Aviso (não bloqueia) para senhas aceitas mas curtas. A senha protege as chaves guardadas no aparelho: se alguém
 * conseguir copiar esses dados, uma senha curta pode ser descoberta por tentativa e erro. Quanto mais longa, melhor.
 */
export function weakPasswordHint(password: string): string | undefined {
  if (passwordProblem(password) !== undefined) return undefined;
  if (Array.from(password).length < 12) return 'Quanto mais longa, mais difícil de adivinhar. Misturar maiúsculas e minúsculas ou usar uma frase ajuda. Evite datas e sequências.';
  return undefined;
}
