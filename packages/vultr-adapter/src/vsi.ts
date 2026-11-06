// File: packages/vultr-adapter/src/vsi.ts
import type { SpendGate } from '@plumbline/ledger';

export const VSI_BASE = 'https://api.vultrinference.com/v1';

export const VSI_MODELS = {
  planner: 'glm-5.3',
  executor: 'qwen3.8-27b',
  advisory: 'nemotron-3.5-content-safety',
} as const;

const PRICE_PER_M: Record<string, { in: number; out: number }> = {
  'glm-5.3': { in: 0.75, out: 3 },
  'qwen3.8-27b': { in: 0.15, out: 1 },
  'nemotron-3.5-content-safety': { in: 0.2, out: 0.2 },
};

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: 'auto' | 'required' | 'none';
  max_tokens?: number;
  temperature?: number;
}

export interface ChatResult {
  model: string;
  message: { role: string; content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
  finish_reason: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  usd: number;
  latency_ms: number;
}

export function priceUsd(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICE_PER_M[model];
  if (!p) throw new Error(`MODEL_NOT_ALLOWED: ${model}`);
  return (promptTokens * p.in + completionTokens * p.out) / 1e6;
}

export class VsiClient {
  readonly #key: string;
  readonly #gate: SpendGate;
  readonly #fetch: typeof fetch;

  constructor(apiKey: string, gate: SpendGate, fetchImpl: typeof fetch = fetch) {
    this.#key = apiKey;
    this.#gate = gate;
    this.#fetch = fetchImpl;
  }

  toJSON(): string {
    return '[VsiClient]';
  }

  async chat(sessionId: string, req: ChatRequest, timeoutMs = 25000): Promise<ChatResult> {
    if (!(req.model in PRICE_PER_M)) throw new Error(`MODEL_NOT_ALLOWED: ${req.model}`);
    const maxTokens = Math.min(req.max_tokens ?? 1024, 2048);
    const promptEstimate = Math.ceil(JSON.stringify(req.messages).length / 3) + Math.ceil(JSON.stringify(req.tools ?? []).length / 3);
    const estimate = priceUsd(req.model, promptEstimate, maxTokens);
    const charge = this.#gate.charge('vsi', estimate, { session_id: sessionId });
    if (!charge.ok) throw new Error(`SPEND_REFUSED: ${charge.reason}`);
    const t0 = Date.now();
    const res = await this.#fetch(`${VSI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...req, max_tokens: maxTokens, temperature: req.temperature ?? 0.2 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      charge.receipt.settle(0);
      throw new Error(`VSI_${res.status}`);
    }
    const body = (await res.json()) as {
      model?: string;
      choices: { finish_reason: string; message: ChatResult['message'] }[];
      usage: ChatResult['usage'];
    };
    const choice = body.choices[0];
    if (!choice) throw new Error('VSI_EMPTY');
    const usd = priceUsd(req.model, body.usage.prompt_tokens, body.usage.completion_tokens);
    charge.receipt.settle(usd);
    return { model: body.model ?? req.model, message: choice.message, finish_reason: choice.finish_reason, usage: body.usage, usd, latency_ms: Date.now() - t0 };
  }

  async usage(sessionId: string): Promise<unknown> {
    const c = this.#gate.charge('vsi', 0, { session_id: sessionId });
    if (!c.ok) throw new Error(`SPEND_REFUSED: ${c.reason}`);
    const res = await this.#fetch(`${VSI_BASE}/usage`, { headers: { authorization: `Bearer ${this.#key}` }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`VSI_${res.status}`);
    return res.json();
  }
}
