import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { all, openDb, run } from './db.js';
import { createNetwork, issueActivation, type NetworkRow, type UserRow } from './services.js';
import { HttpError } from './util.js';

const USAGE = `Uso:
  create-network --slug <codigo> --name "<Nome>" --admin <usuario> --admin-name "<Nome do admin>"
  reset-activation <usuario@rede>
  list-networks
Variável DB_PATH define o arquivo do banco (padrão ./data/sigilo.db).`;

const [command, ...rest] = process.argv.slice(2);
const config = loadConfig();

try {
  const db = openDb(config.dbPath);
  if (command === 'create-network') {
    const { values } = parseArgs({
      args: rest,
      options: { slug: { type: 'string' }, name: { type: 'string' }, admin: { type: 'string' }, 'admin-name': { type: 'string' } },
    });
    if (!values.slug || !values.name || !values.admin || !values['admin-name']) throw new Error(USAGE);
    const result = createNetwork(db, config, {
      slug: values.slug,
      name: values.name,
      adminUsername: values.admin,
      adminDisplayName: values['admin-name'],
    });
    console.log(`Rede criada: ${result.network.name} (código: ${result.network.slug})`);
    console.log(`Administrador: ${result.member.handle}`);
    console.log(`Código de ativação (válido até ${new Date(result.activationExpiresAt).toLocaleString('pt-BR')}):`);
    console.log(`\n    ${result.activationCode}\n`);
    console.log('Entregue este código ao administrador. No app: "Ativar conta" e escolher a senha.');
  } else if (command === 'reset-activation') {
    const handle = rest[0]?.toLowerCase();
    if (!handle) throw new Error(USAGE);
    const user = db.prepare('SELECT * FROM users WHERE handle = ?').get(handle) as UserRow | undefined;
    if (!user) throw new Error(`Usuário não encontrado: ${handle}`);
    run(
      db,
      `UPDATE users SET status = 'pending', kdf_salt = NULL, kdf_params = NULL, auth_salt = NULL, auth_hash = NULL,
         public_key = NULL, encrypted_private_key = NULL, failed_logins = 0, locked_until = 0 WHERE id = ?`,
      user.id,
    );
    run(db, 'DELETE FROM sessions WHERE user_id = ?', user.id);
    run(db, 'DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?', user.id, user.id);
    const activation = issueActivation(db, config, user.id);
    console.log(`Novo código de ativação para ${handle}: ${activation.code}`);
  } else if (command === 'list-networks') {
    for (const n of all<NetworkRow & { members: number }>(
      db,
      'SELECT n.*, (SELECT COUNT(*) FROM users u WHERE u.network_id = n.id) AS members FROM networks n ORDER BY n.created_at',
    )) {
      console.log(`${n.slug}\t${n.name}\t${n.members} membro(s)`);
    }
  } else {
    throw new Error(USAGE);
  }
  db.close();
} catch (err) {
  console.error(err instanceof HttpError || err instanceof Error ? err.message : err);
  process.exit(1);
}
