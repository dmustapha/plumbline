// DBG-R-M3: the API must not admit more concurrent operator runs than the runner can start sandboxes for.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SandboxRunner } from '@plumbline/sandbox';
import { loadApiConfig } from '../apps/range-api/src/config.ts';
import { buildRunnerApp } from '../apps/runner/src/main.ts';
import { parseEnvText } from '../ops/scripts/bootstrap-range.ts';

const slowRunner = { run: async () => { await new Promise((r) => setTimeout(r, 80)); return { state: 'OK', destroyed: true }; }, listContainers: async () => [] } as unknown as SandboxRunner;

async function runnerCapacity(): Promise<number> {
  const app = buildRunnerApp(slowRunner, 'tok');
  const post = () => app.inject({ method: 'POST', url: '/run', headers: { 'x-plumbline-runner-token': 'tok' }, payload: { code: 'print(1)', token: 't' } });
  const codes = (await Promise.all(Array.from({ length: 8 }, post))).map((r) => r.statusCode);
  return codes.filter((c) => c === 200).length;
}

describe('DBG-R-M3 admission matches runner capacity', () => {
  const env = { PLUMBLINE_API_TOKEN: 'a', PLUMBLINE_RUNNER_TOKEN: 'r' };
  it('DBG-R-M3: default range-api maxInFlight is not above the runner concurrent-run capacity', async () => {
    expect(loadApiConfig(env).maxInFlight).toBeLessThanOrEqual(await runnerCapacity());
  });
  it('DBG-R-M3: the shipped api.env.example agrees (so a regenerated api.env cannot re-open the gap)', async () => {
    const ex = parseEnvText(readFileSync(fileURLToPath(new URL('../ops/env/api.env.example', import.meta.url)), 'utf8'));
    expect(Number(ex.PLUMBLINE_MAX_IN_FLIGHT)).toBeLessThanOrEqual(await runnerCapacity());
  });
});
