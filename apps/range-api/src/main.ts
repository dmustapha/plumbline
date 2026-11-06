// File: apps/range-api/src/main.ts
import Fastify from 'fastify';
import { BrokerClient, RunnerClient } from './brokerClient.ts';
import { loadApiConfig, type ApiConfig } from './config.ts';
import type { ApiDeps } from './deps.ts';
import { InFlight, SlidingWindow } from './rateLimit.ts';
import { registerRoutes } from './routes.ts';
import { SessionBook } from './sessionBook.ts';
import { SseHub } from './sse.ts';

export async function buildApi(config: ApiConfig, overrides: Partial<ApiDeps> = {}) {
  const app = Fastify({ logger: false, bodyLimit: 2048, trustProxy: '127.0.0.1' });
  const deps: ApiDeps = {
    config,
    broker: new BrokerClient(config.brokerSocket, config.apiToken),
    runner: new RunnerClient(config.runnerSocket, config.runnerToken),
    hub: new SseHub(),
    book: new SessionBook(),
    attackLimit: new SlidingWindow(3, 60_000),
    actLimit: new SlidingWindow(10, 60_000),
    sessionIpLimit: new SlidingWindow(config.sessionsPerIp, config.sessionWindowMs),
    sessionGlobalLimit: new SlidingWindow(config.sessionsPerMinute, 60_000),
    inFlight: new InFlight(config.maxInFlight),
    ...overrides,
  };
  await registerRoutes(app, deps);
  return { app, deps };
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/^.*\/apps\//, '/apps/'));
if (isMain) {
  const config = loadApiConfig(process.env);
  const { app } = await buildApi(config);
  await app.listen({ host: config.host, port: config.port });
  console.log(JSON.stringify({ evt: 'range-api-listening', host: config.host, port: config.port }));
}
