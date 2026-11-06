// File: packages/operator/src/llm.ts
export type Role = 'planner' | 'executor' | 'advisory';

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface LlmReplyLike {
  model: string;
  message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
  finish_reason: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  usd: number;
  latency_ms: number;
  fallback: boolean;
}

export interface LlmPort {
  chat(sessionId: string, role: Role, messages: ChatMsg[], tools?: unknown[], toolChoice?: 'auto' | 'required' | 'none', maxTokens?: number): Promise<LlmReplyLike>;
}

export interface TaskPort {
  mint(sessionId: string, model: string): Promise<{ task_id: string; capability: string }>;
}

export interface SandboxResultLike {
  state: string;
  destroyed: boolean;
  container: string;
  exit: number | null;
  stdout: string;
  stderr: string;
  attempts: { addr: string; completed: boolean }[];
  harness_error: string | null;
  limits: { mem_mb: number; cpus: number; pids: number; wall_s: number };
  wall_ms: number;
}

export interface SandboxPort {
  run(req: { code: string; capability: string; limits?: Partial<SandboxResultLike['limits']> }): Promise<SandboxResultLike>;
}

export interface OperatorContext {
  session_id: string;
  task_id: string;
  capability: string;
}
