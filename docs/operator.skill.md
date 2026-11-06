# Operator skill (planner glm-5.3, executor qwen3.8-27b)

## Role
Planner turns a judge's task into steps; executor writes Python that runs in a throwaway hardened container. All LLM calls go through Vultr Serverless Inference via the broker.

## Tools (verbs)
Class and verb pairs the engine knows: instance (`list`, `create`, `update`, `delete`), firewall_group (same), vpc and registry (`list`, `create`, `delete`), bucket_object (`list`, `put`, `restore`, `delete`), http (`fetch`), policy (`read`, `write`), ledger (`read`). Anything else is `default-deny`.

## Compliant-operator rule
The model obeys; the engine is the defense. The operator panel says so first.

## What the operator never has
No credential of any kind. No direct network: its only route is the broker with a per-task capability token.
