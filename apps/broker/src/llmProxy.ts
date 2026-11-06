// File: apps/broker/src/llmProxy.ts
import type { Ledger } from '@plumbline/ledger';
import { VSI_MODELS, type ChatMessage, type ChatResult, type VsiClient } from '@plumbline/vultr-adapter';

export type Role = 'planner' | 'executor' | 'advisory';

export interface LlmReply extends ChatResult {
  role: Role;
  fallback: boolean;
}

export class LlmProxy {
  constructor(private readonly vsi: VsiClient, private readonly ledger: Ledger) {}

  async chat(sessionId: string, role: Role, messages: ChatMessage[], tools?: unknown[], toolChoice?: 'auto' | 'required' | 'none', maxTokens = 1024): Promise<LlmReply> {
    const first = VSI_MODELS[role];
    try {
      return await this.#once(sessionId, role, first, messages, tools, toolChoice, maxTokens, false);
    } catch (e) {
      const msg = String((e as Error).message);
      if (role === 'advisory' || msg.startsWith('SPEND_REFUSED')) throw e;
      const other = role === 'planner' ? VSI_MODELS.executor : VSI_MODELS.planner;
      return this.#once(sessionId, role, other, messages, tools, toolChoice, maxTokens, true);
    }
  }

  async #once(sid: string, role: Role, model: string, messages: ChatMessage[], tools: unknown[] | undefined, toolChoice: 'auto' | 'required' | 'none' | undefined, maxTokens: number, fallback: boolean): Promise<LlmReply> {
    const r = await this.vsi.chat(sid, { model, messages, tools: role === 'advisory' ? undefined : tools, tool_choice: role === 'advisory' ? undefined : toolChoice, max_tokens: maxTokens });
    this.ledger.recordInference(sid, r.model, r.usage.prompt_tokens, r.usage.completion_tokens, r.usd);
    return { ...r, role, fallback };
  }
}
