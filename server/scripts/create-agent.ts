/**
 * Creates an AGENT_ACCOUNTS entry for an individual test agent.
 *
 *   npm run agent:create -- <agent-id> "<Display Name>"
 *
 * The password is read interactively (or from AGENT_PASSWORD for automation)
 * and only its scrypt hash is printed.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { AGENT_ID_RE } from '../src/auth/agentAccounts.js';
import { hashPassword } from '../src/auth/passwords.js';

async function readPassword(prompt: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    muted = true;
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const [id, ...nameParts] = process.argv.slice(2);
  const displayName = nameParts.join(' ').trim() || id;
  if (!id || !AGENT_ID_RE.test(id)) {
    console.error('Usage: npm run agent:create -- <agent-id> "<Display Name>"');
    console.error('agent-id: 2-64 characters, letters, digits, . _ @ -');
    process.exit(1);
  }
  if (!displayName || /[|;\n]/.test(displayName) || displayName.length > 80) {
    console.error('Display name must not contain | or ; and must be at most 80 characters.');
    process.exit(1);
  }
  let password = process.env.AGENT_PASSWORD;
  if (!password) {
    password = await readPassword(`Password for ${id} (min. 10 characters): `);
    const repeat = await readPassword('Repeat password: ');
    if (password !== repeat) {
      console.error('Passwords do not match.');
      process.exit(1);
    }
  }
  if (password.length < 10) {
    console.error('Password must be at least 10 characters long.');
    process.exit(1);
  }
  const hash = await hashPassword(password);
  const entry = `${id}|${displayName}|${hash}`;
  console.log('\nAdd this entry to AGENT_ACCOUNTS (separate multiple agents with ";"):\n');
  console.log(entry);
  console.log('\nExample: AGENT_ACCOUNTS="' + entry + '"');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
