import { randomBytes } from 'node:crypto';

// Sem caracteres ambíguos (0/O, 1/l/I): a senha provisória é ditada ou copiada para o profissional.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const LIMIT = 256 - (256 % ALPHABET.length);

/** Senha provisória legível (xxxx-xxxx-xxxx), que atende à regra mínima e precisa ser trocada no primeiro acesso. */
export function generateProvisionalPassword(): string {
  for (;;) {
    const chars: string[] = [];
    while (chars.length < 12) {
      for (const b of randomBytes(16)) {
        if (b < LIMIT && chars.length < 12) chars.push(ALPHABET[b % ALPHABET.length]!);
      }
    }
    const s = chars.join('');
    if (/[A-Za-z]/.test(s) && /\d/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
  }
}
