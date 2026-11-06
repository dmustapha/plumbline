// File: apps/verifier/src/main-verifier.ts
// Wiring for the verifier process (systemd unit `plumbline-verifier`, user `plumbline-verifier`, env file with only the view key
// and the lease secret). Refuses to boot unless the key is verifiably view-only (AG4-VER-7), the shared dir is safe (AG4-VER-3),
// and, when a policy public key is configured, the floor signature verifies.
import { loadVerifierConfig } from './config.ts';
import { loadFloor } from './sharedFiles.ts';
import { buildVerifier } from './verifierServer.ts';
import { assertViewOnlyKey, makeHttp } from './vultr-lite.ts';

const config = loadVerifierConfig(process.env);
const http = makeHttp(config.viewKey);
const acls = await assertViewOnlyKey(http);
const floor = loadFloor(config.floorPath, config.floorSigPath, config.policyPubkeyB64);
const { app, run } = buildVerifier({ config, http, floor });
await app.listen({ host: config.host, port: config.port });
console.log(JSON.stringify({ evt: 'verifier-listening', host: config.host, port: config.port, key_acls: acls, floor: floor.floor ? floor.floor.hash.slice(0, 12) : 'UNAVAILABLE' }));
void run().catch(() => undefined);
