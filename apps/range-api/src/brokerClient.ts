// File: apps/range-api/src/brokerClient.ts
import http from 'node:http';
import type { ChatMsg, LlmPort, LlmReplyLike, Role, SandboxPort, SandboxResultLike, TaskPort } from '@plumbline/operator';

export interface JsonResponse<T = unknown> {
  status: number;
  json: T;
}

export function unixJson<T = unknown>(socketPath: string, method: string, path: string, headers: Record<string, string>, body?: unknown, timeoutMs = 60000): Promise<JsonResponse<T>> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath, method, path, timeout: timeoutMs, headers: { ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: (text ? JSON.parse(text) : null) as T }); } catch { resolve({ status: res.statusCode ?? 0, json: text as unknown as T }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('socket timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

export class BrokerClient implements LlmPort, TaskPort {
  constructor(private readonly socketPath: string, private readonly apiToken: string) {}

  call<T = unknown>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<JsonResponse<T>> {
    return unixJson<T>(this.socketPath, method, path, { 'x-plumbline-api-token': this.apiToken, ...extraHeaders }, body);
  }

  async chat(sessionId: string, role: Role, messages: ChatMsg[], tools?: unknown[], toolChoice?: 'auto' | 'required' | 'none', maxTokens?: number): Promise<LlmReplyLike> {
    const r = await this.call<LlmReplyLike & { status?: string }>('POST', '/v1/llm', { session_id: sessionId, role, messages, tools, tool_choice: toolChoice, max_tokens: maxTokens });
    if (r.status === 503) throw new Error('OPERATOR_BUSY');
    if (r.status !== 200) throw new Error(`LLM_${r.status}`);
    return r.json;
  }

  async mint(sessionId: string, model: string): Promise<{ task_id: string; capability: string }> {
    const r = await this.call<{ task_id: string; token: string; status?: string }>('POST', '/v1/task', { session_id: sessionId, model });
    if (r.status !== 200) throw new Error(`TASK_${r.status}_${(r.json as { status?: string }).status ?? ''}`);
    return { task_id: r.json.task_id, capability: r.json.token };
  }
}

export class RunnerClient implements SandboxPort {
  constructor(private readonly socketPath: string, private readonly token: string) {}

  async run(req: { code: string; capability: string; limits?: Partial<SandboxResultLike['limits']> }): Promise<SandboxResultLike> {
    const r = await unixJson<SandboxResultLike & { status?: string }>(this.socketPath, 'POST', '/run', { 'x-plumbline-runner-token': this.token }, { code: req.code, token: req.capability, limits: req.limits }, 60000);
    if (r.status === 429) throw new Error('OPERATOR_BUSY');
    if (r.status !== 200) throw new Error(`RUNNER_${r.status}`);
    return r.json;
  }

  async containers(): Promise<string[]> {
    const r = await unixJson<{ containers: string[] }>(this.socketPath, 'GET', '/containers', { 'x-plumbline-runner-token': this.token });
    return r.json.containers ?? [];
  }
}
