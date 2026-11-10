#!/usr/bin/env node
import { lerFalhaDePartida, mensagemDaFalha, servirFalhaDePartida } from './partida';

/**
 * Chamado pelo container quando `cli.js boot` falha: responde 503 com o motivo (sem segredos) na porta da API por
 * alguns minutos e sai com erro, para a partida ser refeita na requisição seguinte.
 */
const falha = lerFalhaDePartida();
const duracaoMs = Number(process.env.PARTIDA_ESPERA_MS) > 0 ? Number(process.env.PARTIDA_ESPERA_MS) : 180_000;
console.error(`${mensagemDaFalha(falha)} Respondendo 503 com esse motivo por ${Math.round(duracaoMs / 1000)} s.`);
servirFalhaDePartida({ porta: Number(process.env.PORT) || 3001, falha, duracaoMs });
