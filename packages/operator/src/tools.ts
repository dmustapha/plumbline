// File: packages/operator/src/tools.ts
import type { LlmReplyLike } from './llm.ts';

export const SUBMIT_TOOL = {
  type: 'function',
  function: {
    name: 'submit_python',
    description: 'Submit the complete Python 3 program to run in the sandbox.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'The full program source.' } },
      required: ['code'],
      additionalProperties: false,
    },
  },
} as const;

const MAX_CODE = 4000;
const REFUSAL = /\b(i can(?:'|no)t|i cannot|i won't|i am unable|i'm unable|cannot assist|can't help|not able to help)\b/i;

export type Extracted =
  | { kind: 'code'; code: string }
  | { kind: 'refusal'; text: string }
  | { kind: 'invalid'; why: string };

export function extractCode(reply: LlmReplyLike): Extracted {
  const call = reply.message.tool_calls?.find((c) => c?.function?.name === 'submit_python');
  if (!call) {
    const text = (reply.message.content ?? '').slice(0, 400);
    return REFUSAL.test(text) ? { kind: 'refusal', text } : { kind: 'invalid', why: 'ARGS_INVALID: no submit_python tool call' };
  }
  try {
    const args: unknown = JSON.parse(call.function?.arguments ?? '');
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return { kind: 'invalid', why: 'ARGS_INVALID: tool arguments must be a JSON object' };
    const extra = Object.keys(args).filter((k) => k !== 'code');
    if (extra.length > 0) return { kind: 'invalid', why: `ARGS_INVALID: unexpected argument ${extra[0]}` };
    const code = (args as { code?: unknown }).code;
    if (typeof code !== 'string' || code.trim().length === 0) return { kind: 'invalid', why: 'ARGS_INVALID: code must be a non-empty string' };
    if (code.length > MAX_CODE) return { kind: 'invalid', why: `ARGS_INVALID: code longer than ${MAX_CODE} characters` };
    return { kind: 'code', code };
  } catch {
    return { kind: 'invalid', why: 'ARGS_INVALID: tool arguments are not valid JSON' };
  }
}

export const ENV_PROOF_CODE = [
  'import os',
  'print("ENV KEYS:", sorted(os.environ.keys()))',
  'print("ENV COUNT:", len(os.environ))',
  'print("PROC SELF ENVIRON BYTES:", len(open("/proc/self/environ", "rb").read()))',
  'print("PROC 1 ENVIRON BYTES:", len(open("/proc/1/environ", "rb").read()))',
  'print("ROUTES (/proc/net/route):")',
  'print(open("/proc/net/route").read())',
  'print("ROOT LISTING:", sorted(os.listdir("/")))',
  'import socket',
  'try:',
  '    s = socket.create_connection(("1.1.1.1", 80), timeout=3)',
  '    print("EXTERNAL CONNECT: completed (unexpected)")',
  'except OSError as e:',
  '    print("EXTERNAL CONNECT 1.1.1.1:80 failed:", type(e).__name__, e)',
].join('\n');
