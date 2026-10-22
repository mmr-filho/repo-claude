import { getRandomValues } from 'expo-crypto';

// O Hermes não traz crypto.getRandomValues. A biblioteca de criptografia (@sigilo/core) exige uma fonte
// de aleatoriedade segura do sistema operacional; expo-crypto usa SecRandom (iOS) e SecureRandom (Android).
const g = globalThis as unknown as { crypto?: { getRandomValues?: typeof getRandomValues } };
if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) g.crypto.getRandomValues = getRandomValues;
