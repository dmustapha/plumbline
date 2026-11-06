// File: ops/scripts/sign-policy.ts
// INVARIANT 5: Ed25519 detached signature over policy/floor.yaml -> policy/floor.yaml.sig. The private key lives only at the path named by
// PLUMBLINE_SIGNING_KEY (outside the repository, mode 0600) and is never printed. Only the public key is emitted, for the broker env.
//   PLUMBLINE_SIGNING_KEY=/path/outside/repo/key.pem npm run sign-policy -- --init   (creates the pair, prints PLUMBLINE_POLICY_PUBKEY=...)
//   PLUMBLINE_SIGNING_KEY=/path/outside/repo/key.pem npm run sign-policy             (signs the floor)
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { policyMessage, verifyPolicySignature } from '@plumbline/policy-engine';

const REPO = resolve(new URL('../../', import.meta.url).pathname);
const FLOOR = resolve(REPO, 'policy/floor.yaml');

export function keyPathFromEnv(env: NodeJS.ProcessEnv = process.env, repo = REPO): string {
  const p = env.PLUMBLINE_SIGNING_KEY;
  if (!p) throw new Error('PLUMBLINE_SIGNING_KEY is not set: name a key path outside the repository');
  const abs = resolve(p);
  const rel = relative(repo, abs);
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) throw new Error('PLUMBLINE_SIGNING_KEY points inside the repository: refusing');
  return abs;
}

const rawPub = (pub: ReturnType<typeof createPublicKey>): string => (pub.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64');

/** Creates the key pair at `keyPath` (0600) and returns ONLY the public key (raw 32 bytes, base64). */
export function initKey(keyPath: string): string {
  if (existsSync(keyPath)) throw new Error(`${keyPath} already exists; refusing to overwrite`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return rawPub(publicKey);
}

/** Signs `floorPath` into `<floorPath>.sig` and self-verifies before returning the public key. */
export function signFloor(keyPath: string, floorPath: string): string {
  if (!existsSync(keyPath)) throw new Error('signing key not found: run with --init first');
  const priv = createPrivateKey(readFileSync(keyPath));
  const text = readFileSync(floorPath, 'utf8');
  const signature = sign(null, Buffer.from(policyMessage(text)), priv).toString('base64');
  const pub = rawPub(createPublicKey(priv));
  if (verifyPolicySignature(text, signature, pub) !== 'OK') throw new Error('self-verification of the new signature failed');
  writeFileSync(`${floorPath}.sig`, signature + '\n');
  return pub;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const keyPath = keyPathFromEnv();
  if (process.argv.includes('--init')) console.log(`PLUMBLINE_POLICY_PUBKEY=${initKey(keyPath)}`);
  else console.log(JSON.stringify({ signed: 'policy/floor.yaml', sig_file: 'policy/floor.yaml.sig', public_key: signFloor(keyPath, FLOOR) }));
}
