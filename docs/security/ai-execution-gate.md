# AI execution gate: paid model calls, default deny

Every paid model call in Familista goes through one door, the AI Gateway
(`src/platform/intelligence/gateway.ts`), and the gateway now applies the
**AI execution gate** (`src/platform/intelligence/execution-gate.ts`) before
anything is sent. This page is what the Platform Owner needs to run it.

## What is refused, and why

A call is made only when **all** of these hold. Each refusal is recorded as an
`AiEgressRecord` row with `outcome = REFUSED` and the rule in `reason`.

| Rule (`reason`) | Refused when |
|---|---|
| `origin` | The call has no authorised origin: not inside an API request from a signed-in person, and not inside an agent job a signed-in person queued. |
| `autonomous` | The call comes from a timer or a background worker. There is no setting that allows this (`AUTONOMOUS_AI_EXECUTION = false`). |
| `audit` | The switch or the usage ledger cannot be read or written. |
| `disabled` | The Platform Owner's **AI EXECUTION** switch is OFF. No row, or an unreadable row, also counts as OFF. |
| `config` | A limit or the price list is set to an invalid value. The setting's name is reported, never its value. |
| `pricing` | The model has no configured price, so its cost cannot be budgeted. |
| `request-limit` | The call could use more tokens than one request is allowed. |
| `concurrency` | The platform already has the maximum number of calls in flight. |
| `workflow-budget` / `agent-budget` | The executive workflow or the agent job has used its own allowance. |
| `budget` | The club has used its daily allowance. |
| `daily-budget` / `monthly-budget` | The platform's daily or monthly allowance, in tokens or estimated cost, is used up. |

Agents cannot start agents: a job never runs inside another job, and only a
signed-in person's request may create AI work (`assertMayCreateAgentWork`, at
every place an `AIAgentJob` is created). The provider client makes **one**
attempt (no SDK retries) and the request is aborted at its timeout. The
decision narrative no longer retries; it falls back to its deterministic text.

## Stop all new AI execution immediately

**SYSTEM → AI Agent Control → Paid AI execution → Switch paid AI off.** Give a
reason; it is recorded.

- The switch is stored in the database (`AiExecutionControl`) and read on every
  call, inside the same lock every reservation takes. So once OFF is saved, no
  new call is admitted, on any server instance.
- A call that was already sent finishes, at most until its provider timeout,
  and is recorded.
- Ordinary platform features keep working. AI features answer with their
  deterministic result, or say that AI is switched off.
- The same switch exists as an API call for the Platform Owner:
  `POST /api/v1/system/agents/ai-execution` with `{ "enabled": false, "reason": "…" }`.

This switch is separate from the **kill switch** above it, which stops
autonomous agent *actions*. Neither depends on anything in the browser.

## Switch paid AI on (owner decision)

1. In Render → familista-backend → Environment, set `AI_MODEL_PRICING` to the
   provider's current prices, in US dollars per million tokens, for the model
   the platform uses (the Operations Room lists it under **Model prices**):

   ```json
   {"<provider model name>": {"inputPerMTokUsd": 3, "outputPerMTokUsd": 15}}
   ```

   The numbers above are an example, not a quote. Check the provider's price
   page on the day.
2. Optionally adjust the limits below. Saving in Render deploys.
3. **SYSTEM → AI Agent Control → Switch paid AI on**, with a reason.
4. Watch **AI Agents Operations Room → AI cost control**.

## Limits

All limits count input and output tokens together. Estimated costs are in US
dollars. A setting that is absent uses its default. A setting that is present
but not a positive number refuses every call until it is corrected.

| Setting | Default | What it bounds |
|---|---|---|
| `AI_MAX_TOKENS_PER_REQUEST` | 32,000 | One call's reservation: input upper bound plus its output cap |
| `AI_MAX_TOKENS_PER_WORKFLOW` | 100,000 | All calls made by one executive workflow |
| `AI_MAX_TOKENS_PER_AGENT_RUN` | 50,000 | All calls made by one agent job |
| `AI_CLUB_DAILY_TOKEN_BUDGET` | 200,000 | One club, per UTC day |
| `AI_PLATFORM_DAILY_TOKEN_BUDGET` | 200,000 | The whole platform, per UTC day |
| `AI_PLATFORM_MONTHLY_TOKEN_BUDGET` | 2,000,000 | The whole platform, per UTC month |
| `AI_PLATFORM_DAILY_COST_BUDGET_USD` | 2 | Estimated cost, per UTC day |
| `AI_PLATFORM_MONTHLY_COST_BUDGET_USD` | 20 | Estimated cost, per UTC month |
| `AI_MAX_CONCURRENT_REQUESTS` | 2 | Calls in flight at once |
| `AI_MODEL_PRICING` | none | Price per model. Without it, nothing is called. |

## How budgets are counted

Before a call, the gate **reserves** the most the call could use: the prompt's
UTF-8 byte count plus a framing allowance, which no token count can exceed,
plus the output cap the provider is held to. The cost of that reservation is
priced from `AI_MODEL_PRICING`.

The reservation is made in one PostgreSQL transaction under one advisory lock:
read the switch, sum what every budget has already counted, decide, write the
record. Two calls therefore cannot both fit into the last of a budget. This is
proven on real PostgreSQL in `tests/ai-execution-gate.integration.test.ts`:
25 reservations at once against a budget for 10 admit exactly 10.

After the call, the record is settled to the token counts the provider
reported. A call with no reported usage (a timeout, a failure) keeps its whole
reservation as its charge. The record's append-only guard lets a settlement add
the outcome but never shrink a reservation or move it to another workflow or
agent run. Windows are calendar UTC days and months; nothing is reset by hand.

## What the figures are, and what they are not

- **Counted** (or **charged**): what the budgets use, meaning reported usage, or
  the whole reservation where none was reported.
- **Reported**: the provider's own token counts for its responses.
- **Estimated cost**: those counts times the configured prices.

None of these is the provider's invoice. The provider's billing is the record of
what was charged. An application-side budget cannot guarantee what an external
provider charges: prices may change before `AI_MODEL_PRICING` does, and a
request aborted at its timeout may still be billed. For a hard ceiling, also
set a spending limit in the provider's console, if the account offers one.

## Who sees what

- The switch and the cost view are the Platform Owner's alone. Every club role
  is refused (403), and the view is never cached.
- The cost view is platform-wide. It groups usage by model, agent and rule, and
  has no club field at all, so it cannot disclose one club's usage.
- A provider key is reported only as configured or not configured. Its value
  never leaves the server.
