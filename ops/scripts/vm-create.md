# VM bring-up sequence (DRAFT for the integrator; nothing here has been run)

Owner machine only. Every step marked **[DAMI]** needs Dami in chat before it runs. Nothing below prints a key; if a command's output shows one, stop.

## What gets created and what it costs ([ASSUMED] list prices, re-read from `GET /plans` hourly_cost before the go)

| Resource | Label | Plan / region | ~USD per hour | ~USD per month |
|---|---|---|---|---|
| VM 1 broker | `plumbline-infra-broker` | `vc2-2c-4gb`, ewr, Debian 12 (os_id 2136) | 0.027 | 20 |
| VM 2 verifier + watchdog | `plumbline-infra-verifier` | `vc2-1c-1gb`, second region (ord; else lax, dfw, sea) | 0.007 | 5 |
| Protected target | `plumbline-prod-db` | `vc2-1c-1gb`, ewr | 0.007 | 5 |
| Registry | `plumblinereg` | `start_up`, ewr | not in the rate card | ~5 |
| Object storage + canary bucket | `plumbline-orders-db` | existing subscription | already running | ~6 |

Compute running cost: about 0.041 USD/hour, 0.99 USD/day. Two to three days to the deadline is roughly 2 to 3 USD of compute (plus registry). The broker's session and global caps (1.5 / 10 USD) do NOT meter this: owner infra is outside session spend. Teardown at the end (`npm run teardown`) stops the meter; Vultr bills a started hour.

## Preconditions

1. **[DAMI]** says "go" in chat for the first resource creation (spend approved) and confirms the spend is credit-only (no payment-method prompt).
2. **[DAMI]** confirms the SSH key is registered in Vultr and gives its id; export it as `VULTR_SSH_KEY_ID` (the bootstrap reads that name, or `--ssh-key-id`). Without it the script refuses to start.
3. Owner `.env` (`/Users/MAC/vultr-rush/.env`) holds `VULTR_API_KEY`, `VULTR_INFERENCE_API_KEY`, `VULTR_S3_HOST`, `VULTR_S3_ACCESS_KEY`, `VULTR_S3_SECRET_KEY`. Check names only: `grep -o '^[A-Z_]*=' /Users/MAC/vultr-rush/.env`. The bootstrap fails with `BOOTSTRAP_INPUT_MISSING: <names>` before any API call if one is absent.
4. Policy key and signed floor (private key stays in `~/.plumbline/policy-signing.pem`):
   `cd app && npm run sign-policy -- --init` prints the public key; `export PLUMBLINE_POLICY_PUBKEY=<that line>`; `npm run sign-policy`; `ls policy/floor.yaml.sig`.
5. Local gates green first: `npx tsc --noEmit -p tsconfig.json` and `npx vitest run`.

## Step 1: create VM 1, VM 2, prod-db, registry, bucket and the six tier users (one command)

```bash
cd /Users/MAC/vultr-rush/plumbline/app
npm run bootstrap:range -- --expiry 2026-11-20T00:00:00Z
```

What it does, in order (all idempotent; a re-run reuses what exists, issues no new key, writes no new ledger row):
1. creates `plumbline-infra-broker`, `plumbline-infra-verifier`, `plumbline-prod-db` (tags `protected`) through an engine ALLOW under the owner policy (caller `owner`); each ALLOW is written to `/Users/MAC/vultr-rush/.deploy/ledger.sqlite` as it is issued and the resource is tied to it;
2. creates registry `plumblinereg` the same way (H-1: it is in the ledger AND the baseline);
3. creates or reuses the six users `plumbline-{observer,deployer,network,registry,verifier-ro,watchdog}`, each locked to its VM's IP, one key each, every call behind a recorded OwnerAction (`user.create`, `user.ip_allow`, `user.issue_key`, `user.delete`, `bucket.ensure`);
4. ensures the versioned bucket and seeds `orders.json` (2 versions) once;
5. writes `.deploy/{broker,api,runner,verifier,watchdog}.env` (0600), `baseline.json` (id, label, plan, region, power_status, os; H-3), `bootstrap-summary.json`, `ledger.sqlite`.

Expected: one JSON line with `broker_ip`, `verifier_ip`, `verifier_region`, `ledger.gaps: []`. Exit code 2 means `ledger.gaps` is not empty (a live resource has no ledger row): STOP, do not invent a row, escalate.

Checks (no key printed):
```bash
stat -f '%Lp %N' /Users/MAC/vultr-rush/.deploy/*.env /Users/MAC/vultr-rush/.deploy/ledger.sqlite   # 600 each
ssh -o ConnectTimeout=10 root@<broker_ip> true && ssh -o ConnectTimeout=10 root@<verifier_ip> true
```
**[DAMI]** U-10: Vultr's create response carries no `date_expire`. Open the console, check each of the six keys' expiry (or note they never expire) and tell the integrator; the `--expiry` value is only the banner date. Record the answer in `evidence/ops-state.md`. Do not print a "date_expire" warning from code.

Rotation (later, e.g. after an IP change; U-11: ip-whitelist entries cannot be deleted, so rotation = recreate the user, which revokes its keys): `npm run bootstrap:range -- --rotate`. Re-copy the env files afterwards (Step 3) and restart the units.

## Step 2: prepare the machines

On each VM from the owner machine (VM 1 `broker`, VM 2 `verifier`):
```bash
ssh root@<ip> 'mkdir -p /opt/plumbline && git clone <repo> /opt/plumbline/app'      # or rsync the tagged tree
ssh root@<ip> 'bash /opt/plumbline/app/ops/scripts/bootstrap-vm.sh <broker|verifier>'
```
**[DAMI]** if the sslip.io HTTPS certificate does not issue (rate limit), approve the `--http-fallback` argument of bootstrap-vm.sh.
Docker must be >= 26.0 on VM 1 (H-4): `ssh root@<broker_ip> docker version --format '{{.Server.Version}}'`.

## Step 3: copy the generated files (nothing is read or printed locally)

```bash
D=/Users/MAC/vultr-rush/.deploy
scp $D/broker.env $D/api.env $D/runner.env root@<broker_ip>:/etc/plumbline/
scp $D/ledger.sqlite root@<broker_ip>:/var/lib/plumbline/ledger.sqlite
ssh root@<broker_ip> 'chown plumbline-broker:plumbline-ipc /var/lib/plumbline/ledger.sqlite && chmod 640 /var/lib/plumbline/ledger.sqlite && chmod 600 /etc/plumbline/*.env'
scp $D/verifier.env $D/watchdog.env $D/baseline.json root@<verifier_ip>:/etc/plumbline/
ssh root@<verifier_ip> 'chmod 600 /etc/plumbline/*'
# the watchdog uid only exists once bootstrap-vm.sh has run on VM 2:
ssh root@<verifier_ip> 'echo "PLUMBLINE_WATCHDOG_UID=$(id -u plumbline-watchdog)" >> /etc/plumbline/verifier.env'
scp /Users/MAC/vultr-rush/plumbline/app/policy/floor.yaml.sig root@<broker_ip>:/opt/plumbline/app/policy/
scp /Users/MAC/vultr-rush/plumbline/app/policy/floor.yaml.sig root@<verifier_ip>:/opt/plumbline/app/policy/
```
The ledger file must be in place BEFORE the broker's first start, otherwise the broker creates an empty ledger and the infra resources have no ALLOW row (verifier would go RED, H-1).

## Step 4: start

```bash
ssh root@<broker_ip>   'systemctl enable --now plumbline-broker plumbline-runner plumbline-api'
ssh root@<verifier_ip> 'systemctl enable --now plumbline-verifier plumbline-watchdog'
```
`PLUMBLINE_WATCHDOG_DRY_RUN=1` is set in watchdog.env: the watchdog logs but does not destroy until GATE-L3. **[DAMI]**/integrator flips it to `0` only for the L3 gate run and records it.

## Step 5: verify (these are GATE-L4 and the H-1/H-3 gates)

```bash
H=https://$(echo <broker_ip> | tr . -).sslip.io
curl -fsS -X POST $H/api/acl-self-test -H 'content-type: application/json' -d '{"session_id":"gate"}' | jq '.[0].status, .[1].status'   # 403 then 200
curl -fsS $H/api/status | jq '.key_expiry_days'                                                                                        # number
cd /Users/MAC/vultr-rush/plumbline/app && PLUMBLINE_URL=$H npm run gate -- l4; echo exit=$?                                           # exit=0
curl -fsS https://$(echo <verifier_ip> | tr . -).sslip.io/api/verify | jq '.status'                                                    # GREEN right after bootstrap
```
Save `bootstrap-summary.json` (no keys) to `evidence/bootstrap-summary.json`, and the re-whitelist command (`npm run bootstrap:range -- --rotate`, then Step 3 and 4) to `evidence/ops-state.md`.

## Step 6: what to do if Step 1 stops half way

Re-run it. Instances are found by label, users by name; a user whose key is missing from the local env file is recreated (its old keys die with it). Never delete `ledger.sqlite` to "start clean": a live resource without a row is reported as a gap and the run exits 2.

## Rollback / teardown

`npm run teardown` (owner-run, deletes through the engine/OwnerAction path). Compute stops billing at the next hour boundary.
