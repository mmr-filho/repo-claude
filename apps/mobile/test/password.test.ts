import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordProblem, weakPasswordHint } from '../src/password';

test('senha: 8 ou mais caracteres, com letras e números', () => {
  assert.equal(passwordProblem('abc12345'), undefined);
  assert.match(passwordProblem('abc1234')!, /pelo menos 8 caracteres/);
  assert.match(passwordProblem('')!, /pelo menos 8 caracteres/);
});

test('senha: exige ao menos uma letra e ao menos um número', () => {
  assert.match(passwordProblem('abcdefghij')!, /pelo menos um número/);
  assert.match(passwordProblem('1234567890')!, /pelo menos uma letra/);
  assert.match(passwordProblem('!!!!!!!!!!')!, /pelo menos uma letra/);
});

test('senha: símbolos e espaços são aceitos, mas não obrigatórios', () => {
  assert.equal(passwordProblem('abcd1234'), undefined, 'sem símbolo');
  assert.equal(passwordProblem('abcd-1234'), undefined, 'com hífen');
  assert.equal(passwordProblem('a b c 1 2 3 ! @ #'), undefined, 'com espaços e símbolos');
  assert.match(passwordProblem('1234 5678 !!')!, /pelo menos uma letra/, 'símbolo não substitui a letra');
});

test('senha: letra com acento conta como letra; conta por caractere, não por unidade UTF-16', () => {
  assert.equal(passwordProblem('ação1234'), undefined);
  assert.equal(passwordProblem('ÇÃO12345'), undefined);
  assert.match(passwordProblem('😀😀😀😀😀😀😀1')!, /pelo menos uma letra/, 'emoji não é letra');
  assert.match(passwordProblem('a1😀😀😀😀😀')!, /pelo menos 8 caracteres/, '7 caracteres (cada emoji vale 1), não 12 unidades');
  assert.equal(passwordProblem('a1😀😀😀😀😀😀'), undefined, '8 caracteres');
});

test('senha: confirmação diferente é recusada só depois das outras regras', () => {
  assert.equal(passwordProblem('abcd1234', 'abcd1234'), undefined);
  assert.equal(passwordProblem('abcd1234', 'abcd1235'), 'As senhas não conferem');
  assert.match(passwordProblem('abc', 'abd')!, /pelo menos 8 caracteres/);
});

test('aviso de senha curta: só para senhas aceitas com menos de 12 caracteres', () => {
  assert.equal(weakPasswordHint('abc'), undefined, 'senha recusada não ganha aviso (já tem erro)');
  assert.match(weakPasswordHint('abcd1234')!, /Quanto mais longa/);
  assert.match(weakPasswordHint('abcd1234xyz')!, /Quanto mais longa/);
  assert.equal(weakPasswordHint('abcd1234xyzw'), undefined);
});
