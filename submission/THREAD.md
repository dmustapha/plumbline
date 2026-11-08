<!-- DRAFT ONLY. Not posted. Dami posts. autoSent: false, autoPosted: false -->
<!-- Handles verified, see handles.verified.json: @Vultr, @lablabai -->

**1/**
everyone is racing to give AI agents cloud credentials. almost nobody built the box the agent acts inside.

a prompt that says "do not delete production" is text the agent can be talked out of. a log only shows what the system says it did.

**2/**
i built Plumbline for the @Vultr Agent Rush hackathon, hosted by @lablabai.

thesis: an agent should act on a real cloud account without ever holding the credential, and you should be able to prove the account is intact.

**3/**
the idea is simple. don't trust the agent. don't trust the log either.

a broker holds every key. a coded policy engine decides every action. a second host in another region re-reads the live account and says GREEN or RED.

**4/**
the parts:

- agent: plans and codes on Vultr Serverless Inference
- sandbox: Docker + gVisor, no credential, one route out
- broker: sole key holder, returns ALLOW, ESCALATE or DENY
- ledger: append-only, hash-chained, public
- verifier: second VM, view-only key

**5/**
the load-bearing separation: the agent holds no key, the broker holds all of them, and the verifier sits on another host, region and key.

a compromised broker can't quietly rewrite the account. if the verifier can't read it, it says DEGRADED, never GREEN.

**6/**
this is the Blast Radius Zero challenge. open the live range, click "Delete prod-db", and watch protect-tagged-destroy deny it while plumbline-prod-db stays active in the account. no sign-up.

**7/**
proven: 1189 tests, offline. 7 of 8 claims re-derived from evidence files with one command (the eighth is waiting on a gate re-run).

not claimed: the sandbox is a hardened container, not a microVM. spend is broker arithmetic, not Vultr's invoice. the verifier is point-in-time. all written down in the repo.

**8/**
demo video is on the submission page.

**9/**
live: https://plumbline.108-61-70-169.sslip.io
repo: https://github.com/dmustapha/plumbline

built on @Vultr. try to break it.
