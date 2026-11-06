// File: packages/operator/src/loop.ts
import { ADVISORY_PROMPT, EXECUTOR_PROMPT, PLANNER_PROMPT } from './prompts.ts';
import type { ChatMsg, LlmPort, LlmReplyLike, SandboxPort, SandboxResultLike, TaskPort } from './llm.ts';
import { SUBMIT_TOOL, extractCode } from './tools.ts';

export type OperatorEvent =
  | { stage: 'advisory'; label: string; model: string }
  | { stage: 'plan'; text: string; model: string }
  | { stage: 'code'; code: string; model: string; attempt: number }
  | { stage: 'run'; result: SandboxResultLike; attempt: number }
  | { stage: 'refused'; text: string; model: string }
  | { stage: 'failed'; status: 'OPERATOR_INVALID' | 'OPERATOR_BUSY'; detail: string };

export interface OperatorDeps {
  llm: LlmPort;
  tasks: TaskPort;
  sandbox: SandboxPort;
  onEvent?: (e: OperatorEvent) => void;
  maxAttempts?: number;
  demoCaps?: boolean;
}

export interface TaskResult {
  task_id: string | null;
  status: 'RAN' | 'REFUSED' | 'OPERATOR_INVALID' | 'OPERATOR_BUSY';
  plan: string;
  advisory: string | null;
  code: string | null;
  runs: SandboxResultLike[];
  models: { planner: string | null; executor: string | null; advisory: string | null };
  attempts: number;
  /** Why the task failed (OPERATOR_INVALID / OPERATOR_BUSY); null otherwise. */
  detail: string | null;
}

const BUG_MARKERS = ['SyntaxError', 'NameError', 'AttributeError', 'TypeError', 'KeyError', 'IndexError', 'ArgsInvalid', 'ImportError', 'ModuleNotFoundError'];
const FINAL_STATES = ['SANDBOX_TIMEOUT', 'SANDBOX_OOM', 'SANDBOX_PIDS', 'SANDBOX_STUCK'];

export function isCodeBug(r: SandboxResultLike): boolean {
  if (FINAL_STATES.includes(r.state)) return false;
  const err = r.harness_error ?? '';
  if (err.includes('PolicyDenied') || err.includes('EscalationRequired') || err.includes('AuthError')) return false;
  return BUG_MARKERS.some((m) => err.includes(m));
}

function busy(e: unknown): boolean {
  return /OPERATOR_BUSY|RUNNER_BUSY|503|VSI_|SPEND_REFUSED/.test(String((e as Error)?.message ?? e));
}

export async function runOperatorTask(deps: OperatorDeps, sessionId: string, text: string): Promise<TaskResult> {
  const emit = deps.onEvent ?? (() => undefined);
  const out: TaskResult = { task_id: null, status: 'RAN', plan: '', advisory: null, code: null, runs: [], models: { planner: null, executor: null, advisory: null }, attempts: 0, detail: null };
  const fail = (status: 'OPERATOR_INVALID' | 'OPERATOR_BUSY', detail: string): TaskResult => {
    emit({ stage: 'failed', status, detail });
    return { ...out, status, detail };
  };

  try {
    const adv = await deps.llm.chat(sessionId, 'advisory', [{ role: 'system', content: ADVISORY_PROMPT }, { role: 'user', content: text }], undefined, undefined, 8);
    out.advisory = (adv.message.content ?? '').trim().toLowerCase().split(/\s+/)[0]?.slice(0, 24) ?? null;
    out.models.advisory = adv.model;
    emit({ stage: 'advisory', label: out.advisory ?? 'unlabelled', model: adv.model });
  } catch {
    out.advisory = null;
  }

  let plan: LlmReplyLike;
  try {
    plan = await deps.llm.chat(sessionId, 'planner', [{ role: 'system', content: PLANNER_PROMPT }, { role: 'user', content: text }], undefined, undefined, 300);
  } catch (e) {
    return fail(busy(e) ? 'OPERATOR_BUSY' : 'OPERATOR_INVALID', String((e as Error).message).slice(0, 120));
  }
  out.plan = (plan.message.content ?? '').trim().slice(0, 800);
  out.models.planner = plan.model;
  emit({ stage: 'plan', text: out.plan, model: plan.model });

  const messages: ChatMsg[] = [
    { role: 'system', content: EXECUTOR_PROMPT },
    { role: 'user', content: `Request: ${text}\n\nPlan:\n${out.plan}` },
  ];
  const max = deps.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= max; attempt++) {
    out.attempts = attempt;
    let reply: LlmReplyLike;
    try {
      reply = await deps.llm.chat(sessionId, 'executor', messages, [SUBMIT_TOOL], 'required', 1024);
    } catch (e) {
      return fail(busy(e) ? 'OPERATOR_BUSY' : 'OPERATOR_INVALID', String((e as Error).message).slice(0, 120));
    }
    out.models.executor = reply.model;
    const got = extractCode(reply);
    if (got.kind === 'refusal') {
      emit({ stage: 'refused', text: got.text, model: reply.model });
      return { ...out, status: 'REFUSED' };
    }
    if (got.kind === 'invalid') {
      if (attempt === max) return fail('OPERATOR_INVALID', got.why);
      messages.push({ role: 'assistant', content: reply.message.content ?? '' }, { role: 'user', content: `Invalid answer: ${got.why}. Call submit_python with the program.` });
      continue;
    }
    out.code = got.code;
    emit({ stage: 'code', code: got.code, model: reply.model, attempt });
    let run: SandboxResultLike;
    try {
      const task = await deps.tasks.mint(sessionId, reply.model);
      out.task_id = task.task_id;
      run = await deps.sandbox.run({ code: got.code, capability: task.capability, limits: deps.demoCaps ? { wall_s: 10 } : undefined });
    } catch (e) {
      return fail(busy(e) ? 'OPERATOR_BUSY' : 'OPERATOR_INVALID', String((e as Error).message).slice(0, 120));
    }
    out.runs.push(run);
    emit({ stage: 'run', result: run, attempt });
    if (!isCodeBug(run) || attempt === max) return out;
    messages.push(
      { role: 'assistant', content: `submit_python:\n${got.code}` },
      { role: 'user', content: `The program failed with a Python error: ${run.harness_error}. Fix the program and call submit_python again.` },
    );
  }
  return out;
}
