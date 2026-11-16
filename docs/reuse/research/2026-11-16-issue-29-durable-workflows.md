# Issue #29: Source-audited durable task orchestration and approvals

- Date: 2026-11-16
- Repository baseline: `rml4791lol-lang/DS-Bot@26228dfa1e52d536eda78a60936e5c0664e29e9c`
- Pinned DSH source inspected locally: `deepseek-ai/deepseek-harness@66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` (`0.2.2-rc.1`)
- Request type: comprehensive research (official docs, upstream source, current DS-Bot/DSH behavior)
- Decision: **Do not adopt Temporal or LangGraph in V1. Add a local durable task store/projection around the existing DSH Agent Runtime, using SQLite as the preferred implementation and DSH lifecycle events as attempt/recovery evidence.**

## Outcome

Temporal and LangGraph contain useful patterns, but neither is required to satisfy DS-Bot's local V1 semantics. Temporal supplies a durable workflow control plane and event history, but that control plane is a separate service plus database and worker fleet. LangGraph supplies graph checkpoints and interrupts, but using it as DS-Bot's execute/resume engine would create a second Agent Runtime, which this ticket explicitly rules out.

The smallest compatible design is:

1. Keep DSH Sessions, turns, tools, models, and `rt.deliver()` as the only Agent Runtime.
2. Add one DS-Bot-owned task journal and materialized task table. Use SQLite transactions/unique constraints where possible; use JSONL plus snapshots only as a fallback, not as an additional orchestration service.
3. Store task identity, dependency edges, attempts, deadlines, approval requests, current state, and an outbox in that store.
4. Correlate every dispatch with a stable `task_id`, `attempt_id`, `exchange_id`, Session id, and DSH `turn` number.
5. Treat DSH `turn/start`, `turn/end`, `step/*`, `approval/asked`, and `approval/decided` as evidence of what the runtime observed, not as the authoritative business-task state machine.
6. Recover conservatively after a crash: reconcile against the DSH durable Session log, mark an interrupted effect **unknown** unless it is proven not to have happened, and never blindly repeat a non-idempotent action.

This adds durable task state and scheduling decisions, not a second graph executor or agent loop.

## Current DS-Bot and DSH recovery mechanisms

### DSH Session log

DSH defines a Session as an append-only typed event log and the single source of truth for an interaction history; replay re-derives model history from those events. The event vocabulary includes `turn/start`, `turn/end`, `step/start`, `step/end`, user/assistant messages, tool events, retries, and approval audit events. See [DSH Sessions](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/session.md) and the pinned vocabulary at `deepseek-ai/deepseek-harness@66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db:packages/core/session/src/types.ts`.

DSH persistence distinguishes an accepted append from a durable append. Only `SessionHandle.flush()` is the durability barrier. A crash mid-turn leaves a valid log ending in `turn/start` without `turn/end`; resume appends missing tool errors, any missing `step/end`, and a synthetic `turn/end { reason: { kind: "interrupted" } }`. Persistence never invents a successful completion. See [DSH persistence](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/persistence.md), especially “The flush checkpoint” and “Crash recovery preserves an interrupted turn”; source reference: `deepseek-ai/deepseek-harness@66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db:packages/session/session-persistence/src/storage-contract.ts:L1-L120`.

Consequence: DSH can prove that an attempt started and how it ended, but it does not provide business task identity, dependency joins, approval expiry, retry budgets, or task-level pause. DS-Bot must own those semantics.

### Scheduling

DSH Schedule stores recurring/one-shot delivery tasks independently of Session activation and supports `after`, `at`, `every`, `daily`, `weekly`, `cron`, and `rrule`. It delivers a prompt to an existing/reserved/new Session. A saved receipt acknowledges a durable Session-inbox write, **not model completion**. The Host must be running, and because inbox persistence precedes the receipt write, a crash between those stores can repeat a delivery. See [DSH Host-wide Schedule](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/schedule.md), especially lines mirrored by `deepseek-ai/deepseek-harness@66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db:docs/subsystems/schedule.md:L115-L131`.

DS-Bot's adapter exposes create/list/delete/move over that service and explicitly degrades when the DSH Automation bundle is absent: `ds-bot/src/host/schedules.js:L1-L7`, `:113-L160`, `:164-L190`. This is a reminder mechanism, not a durable task graph.

### Goals

Group goals have a stable generated id, revision, sequential stages, tasks assigned to members, per-task state (`pending`, `working`, `reported`, `done`), stage evidence, pause/resume/stop, and a capped event list of the newest 50 events (`ds-bot/src/host/goals.js:L39-L83`, `:143-L177`, `:180-L215`, `:281-L367`). The state is mutable and persisted inside `rooms` in the whole-file `state.json` snapshot. Its events are audit hints, not an authoritative append-only task journal.

The goal driver is a nudge heuristic: when a round settles, it may wake the group admin; two fruitless wakes set `idle`, and a user message clears it (`ds-bot/src/host/goals.js:L591-L661`). It is not a scheduler, retry engine, deadline service, or crash-safe lease manager.

### Handoffs and resume

A handoff is an open work record in `state.works`, with parent/child relations, results, and who asked whom (`ds-bot/src/host/handoffs.js:L1-L7`, `:103-L142`). Large results are written before `state.json` names them (`:37-L83`). The task ledger appends only `open`/`close` rows to `ledger/tasks-<day>.jsonl`; a ledger write failure is deliberately non-blocking (`ds-bot/src/host/task-ledger.js:L1-L58`). Consequently it is a metrics/audit projection, not a durable source of truth or recovery cursor.

`inflight.json` records running turns and queued deliveries. It is replaced atomically through a temporary file and rename (`ds-bot/src/host/resume.js:L105-L163`). On restart, DS-Bot reconciles the note with DSH's durable log, delivers an already-produced answer, marks unreadable outcomes unknown, or sends a resume prompt; it does not reconstruct the exact agent step (`ds-bot/src/host/resume.js:L317-L375`, `:390-L508`, `:511-L613`). A second interruption after one resume remains stopped to prevent a restart loop (`:317-L339`). The `resumed`/`again` marker is important: recovery must be explicitly at-least-once and must not become an infinite retry loop.

### Approvals

DS-Bot's approval service intercepts DSH `approval/request`, exposes pending requests to DS-Bot clients, races its own answerer against DSH's native card for own-chat Sessions, and resolves the first valid answer (`ds-bot/src/host/approvals.js:L1-L116`). Pending entries and answer closures live in an in-memory `Map` (`:10-L45`, `:98-L116`). DSH records `approval/asked` and `approval/decided` audit events, but DS-Bot itself only notes the tool/reason in `inflight.json`; after restart, `resumeText` tells the agent the approval request is gone and must be asked again (`ds-bot/src/host/resume.js:L24-L28`, `:313-L315`).

Consequence: current approval handling is correct for a live process (fail closed, first answer wins, stale cards rejected), but it is not durable. A V1 human-approval interruption needs a persisted approval record and a resume token.

### Existing idempotency pattern

`message_bot` already implements a strong local idempotency pattern for named requests: caller + conversation + request name identifies the request; a SHA-256 payload fingerprint detects reuse with changed content; a receipt is durably saved before send; outcomes are `delivered`, `uncertain`, or conflict; a pending receipt from another process/run is not retried blindly (`ds-bot/src/host/requests.js:L1-L141`). Reuse this model for task dispatch and approval decisions.

## External project audit

### Temporal

**Pinned versions and license**

- Temporal Server `v1.32.2`, released 2026-11-02: <https://github.com/temporalio/temporal/releases/tag/v1.32.2>, source tag commit `6d085822273f4336796e6959c73ab1d14a23eb77`.
- TypeScript SDK `v1.25.0`, released 2026-10-27: <https://github.com/temporalio/sdk-typescript/releases/tag/v1.25.0>, source tag commit `efafd16ef4533da24029277bd72caf564c7aa007`.
- Server and TypeScript SDK are MIT. Server: `temporalio/temporal@6d085822273f4336796e6959c73ab1d14a23eb77:LICENSE:L1-L8`; SDK: `temporalio/sdk-typescript@efafd16ef4533da24029277bd72caf564c7aa007:LICENSE:L1-L8`.

**Exact modules/APIs**

- `temporalio/sdk-typescript@efafd16ef4533da24029277bd72caf564c7aa007:packages/workflow/src/workflow.ts:L182-L191`: deterministic workflow `sleep()` timer.
- Same file `L738`: `proxyActivities()`; `L1075-L1121`: `executeChild()`; `L1359-L1375`: `condition()` wait/timeout; `L1428-L1582`: signal, query, update definitions and handlers.
- `...:packages/common/src/activity-options.ts:L83-L132`: activity timeouts and retry policy.
- `...:packages/common/src/workflow-options.ts:L96-L147`: `WorkflowIdConflictPolicy` (`FAIL`, `USE_EXISTING`, `TERMINATE_EXISTING`) and `WorkflowIdReusePolicy`.
- `...:packages/testing/src/testing-workflow-environment.ts:L64-L198`: `TestWorkflowEnvironment.createTimeSkipping()` and `createLocal()`.

**Recovery semantics**

Temporal Service durably persists an append-only event history per Workflow Execution; the SDK replays workflow code to reconstruct state. Activity scheduling, starts, completions/failures, timeouts, retries, signals, and timer events are recorded. Event history is bounded (warning after 10,240 events and termination at the documented maximum), so long-lived workflows require `continueAsNew` or decomposition. See [Events and Event History](https://docs.temporal.io/workflow-execution/event#event-history), [Workflow IDs](https://docs.temporal.io/workflow-execution/workflowid-runid), and [Workflow message passing](https://docs.temporal.io/encyclopedia/workflow-message-passing).

Activities are retried by default; workflows are not. Retry policies include initial interval, backoff, maximum interval, maximum attempts, non-retryable error types, and per-error next delay. See [Retry policies](https://docs.temporal.io/encyclopedia/retry-policies) and [Activity execution](https://docs.temporal.io/activity-execution). Activities and message delivery remain at-least-once unless the external effect is made idempotent; Temporal's approval pattern explicitly warns that Signals may be duplicated in rare cases and approval handlers must deduplicate (`temporalio/documentation@882a9dececd9ddcf7d3e18d4934b191c7e82a161:docs/design-patterns/approval.mdx`).

Human approval is a Workflow pattern, not a Turnkey primitive: use a Signal with rich decision data plus `condition()` and a durable timer, or a synchronous Update when acknowledgement is needed. The external UI still has to send and authorize the decision. See [Approval pattern](https://docs.temporal.io/design-patterns/approval).

Workflow Pause is an operator control requiring server support and feature enablement. It blocks new workflow/activity dispatch and queues signals/timer processing, but does not stop in-flight activities, deadlines, or activity retries (`temporalio/documentation@882a9dececd9ddcf7d3e18d4934b191c7e82a161:docs/encyclopedia/workflow/workflow-pause.mdx`).

**Dependencies and operational cost**

The TypeScript worker SDK requires Node `>=20.3.0` and brings gRPC, `@swc/core`, webpack, protobuf, and the Temporal core bridge (`temporalio/sdk-typescript@efafd16ef4533da24029277bd72caf564c7aa007:packages/worker/package.json`). The server is a separate Go control plane. Production self-hosting requires MySQL, PostgreSQL, or Cassandra; SQLite/embedded mode is testing/development only, and SQLite is single-writer (`temporalio/documentation@882a9dececd9ddcf7d3e18d4934b191c7e82a161:docs/production-deployment/self-hosted-guide/embedded-server.mdx`, `docs/encyclopedia/temporal-service/persistence.mdx`).

Operational cost includes server deployment, persistence database, schema/version upgrades, namespaces, worker deployment/versioning, nondeterminism/versioning discipline, history retention, visibility, monitoring, and disaster recovery. This is disproportionate for a desktop-local Bot team that already has a durable Session runtime.

**Test model**

The TS SDK's test environment launches a local/time-skipping Temporal test server; timers, retries, and conditions can be tested without real waits. See [Testing suite](https://docs.temporal.io/develop/typescript/best-practices/testing-suite) and `temporalio/sdk-typescript@efafd16ef4533da24029277bd72caf564c7aa007:packages/testing/src/testing-workflow-environment.ts:L143-L198`. The upstream repo also carries integration, history-replay, stress, and nightly suites (`packages/test/src/`).

**Verdict**

Choose Temporal only if DS-Bot needs a separately operated, multi-host durable workflow control plane, deterministic replay/versioning, worker-fleet dispatch, large-scale timers/signals, or compliance-grade event history. None is a demonstrated V1 requirement.

### LangGraph

**Pinned version and license**

- Python `langgraph==1.2.22`, released 2026-11-14: <https://github.com/langchain-ai/langgraph/releases/tag/1.2.22>, tag commit `08a2016953789a4f579b4d36bd1967941ec62012`.
- MIT, Python `>=3.10` (`langchain-ai/langgraph@08a2016953789a4f579b4d36bd1967941ec62012:libs/langgraph/pyproject.toml:L1-L34`).
- SQLite saver package inspected at `langgraph-checkpoint-sqlite==3.1.3`, also MIT.

**Exact modules/APIs**

- `langgraph/graph/state.py`: `StateGraph.add_node()` and `.compile(checkpointer=...)`; `thread_id` is the checkpoint key (`langchain-ai/langgraph@08a2016953789a4f579b4d36bd1967941ec62012:libs/langgraph/langgraph/graph/state.py:L1177-L1212`).
- `langgraph/pregel/main.py`: `Pregel` execution and checkpointer resolution (`...:libs/langgraph/langgraph/pregel/main.py:L456-L860`).
- `langgraph/types.py`: `RetryPolicy`, `Command`, and `interrupt()` (`...:libs/langgraph/langgraph/types.py:L428-L913`).
- `langgraph.checkpoint.sqlite`: `SqliteSaver`/`AsyncSqliteSaver`; Postgres and MongoDB savers are separate packages.
- `langgraph.checkpoint.conformance`: shared saver tests for `get_tuple`, `list`, `put`, `put_writes`, deletion, pruning, and delta-channel history.

**Recovery semantics**

A checkpointer stores snapshots at super-step boundaries and per-node task writes. On a failed super-step, completed sibling-node writes can be retained so they are not recomputed. `thread_id` is required; `graph.invoke(None, config)` continues unfinished work, while `Command(resume=...)` answers an interrupt. See [Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers) and [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence).

Durability is not unconditional. Current modes are `exit`, `async`, and `sync`; process-crash recovery requires durable checkpoints, and Python `sync` can still lose recent checkpoints mid-run. The docs explicitly say that before the first durable checkpoint, an accepted-but-lost thread is indistinguishable from a never-invoked thread and recommend an external outbox/admission row if that distinction matters (`langchain-ai/docs@ffc99ed77cebedd64f065bcb351b42b2908c2142:src/oss/langgraph/checkpointers.mdx:L640-L696`).

`interrupt(value)` persists graph state and resumes via `Command(resume=value)`. On resume, **the interrupted node restarts from its beginning**, and multiple interrupts are matched by call index. Side effects before an interrupt must therefore be idempotent, and effects after approval still need deduplication if a node can fail between the effect and checkpoint completion (`langchain-ai/docs@ffc99ed77cebedd64f065bcb351b42b2908c2142:src/oss/langgraph/interrupts.mdx:L17-L103`, `:1023-L1070`, `:1365-L1375`).

Node retries and timeouts are available via `add_node(..., retry_policy=..., timeout=...)` or graph defaults. Retry defaults are three attempts, 0.5 s initial interval, factor 2.0, 128 s maximum, with jitter. A timed-out attempt clears buffered writes before retry. See [Fault tolerance](https://docs.langchain.com/oss/python/langgraph/fault-tolerance) and [Graph API nodes](https://docs.langchain.com/oss/python/langgraph/graph-api#nodes).

**Dependencies and operational cost**

Core package dependencies include `langchain-core`, `langgraph-checkpoint`, `langgraph-sdk`, `langgraph-prebuilt`, `xxhash`, and `pydantic` (`langchain-ai/langgraph@08a2016953789a4f579b4d36bd1967941ec62012:libs/langgraph/pyproject.toml:L26-L34`). SQLite persistence separately requires `aiosqlite` and `sqlite-vec` (`...:libs/checkpoint-sqlite/pyproject.toml:L14-L18`). Production commonly adds PostgreSQL or MongoDB, and the optional Agent Server adds a hosted graph runtime.

For DS-Bot, adopting LangGraph as the executor means duplicating DSH's model loop, tool loop, streaming, session lifecycle, permissions, and recovery, or bridging two runtimes. That violates the ticket's no-second-runtime constraint. The useful ideas to copy are super-step/task-level checkpoints, explicit pending writes, timeouts/retries with attempt metadata, and interrupt/resume as a first-class state.

**Test model**

LangGraph uses pytest plus shared checkpoint-conformance tests across savers. Its conformance suite covers `get_tuple`, `list`, `put`, `put_writes`, thread deletion/copy, run deletion, and pruning (`libs/checkpoint-conformance/langgraph/checkpoint/conformance/spec/`). It also has dedicated interrupt, retry, resume, subgraph-persistence, and time-travel tests under `libs/langgraph/tests/`.

**Verdict**

Do not adopt Rust/JS graph execution. Extract the checkpoint and interruption semantics into DS-Bot's lightweight task journal.

## Minimum V1 semantics

| Concern | Required V1 contract | Acceptance evidence |
|---|---|---|
| Task identity | Stable opaque `task_id`; `kind`, scope (`bot` or `room`), creator, objective, payload digest, created time, parent/dependency ids. Never use a prompt or Session id as task identity. | Re-submitting the same client request with the same idempotency key returns the original task; changed digest is a conflict. |
| Event history | Append-only `task_events(seq, task_id, type, time, actor, data, schema_version)`. Materialized `tasks` row is a projection, rebuildable from events. | Delete/rebuild projection from events; current state and history hash match. |
| Attempts | `attempt_id`, `task_id`, `number`, dispatch time, DSH Session id, `exchange_id`, optional `turn` number, start/end evidence, outcome (`completed`, `failed`, `interrupted`, `timed_out`, `cancelled`, `unknown`). | One attempt row per dispatch; late completion cannot overwrite a newer attempt. |
| Retries | Attempt budget, retryable/non-retryable classification, next-attempt time, max attempts, reason, and idempotency key per attempt. Retrying an effect is allowed only when the effect key is honored. | Crash during dispatch produces one reconciled attempt and a bounded retry/no-retry decision. |
| Timeouts | At least dispatch/start deadline, attempt lease/heartbeat deadline, approval deadline, and optional overall deadline. Distinguish `timed_out` from `unknown`. | Expired lease is visible; a late result is recorded but does not silently reopen/complete the task. |
| Dependencies | Stable DAG edges or `blocked_by` set; only dispatch when all prerequisites are satisfied. Cycles rejected. For V1, sequential stages can compile into edges rather than needing an expression language. | Cycle rejected; partial failure leaves dependents blocked; retry succeeds and unblocks exactly once. |
| Pause/resume | Pause blocks new attempts and dependent dispatch, records actor/reason, and leaves in-flight work running unless separately cancelled. Resume re-arms eligible tasks; it does not replay completed work. | Pause during a run causes no second dispatch; resume emits exactly one eligible dispatch. |
| Crash recovery | Single-writer/lease ownership; startup sweeps stale leases, reconciles DSH Session logs, and marks unverifiable external effects `unknown`. Do not auto-repeat uncertain effects. | Kill after admit-before-dispatch, after dispatch-before-turn/start, and during a turn; restart outcomes are deterministic and duplicate-free. |
| Approval interruption | Durable approval id, task/attempt id, exact action digest, requested scope, reason, expiry, allowed approvers, one terminal decision, optional resume token. Fail closed on stale, duplicate, unauthorized, expired, or digest-mismatched decisions. | Restart while awaiting approval restores the same card; approve/reject is recorded once; changed action requires a new request. |
| Idempotency | Unique constraints for `task_id`, `(task_id, attempt_no)`, `effect_key`, and `approval_id`; transactional outbox for dispatch; task state transitions use expected revision/compare-and-set. | Duplicate calls to create/start/approve/resume/complete do not create duplicate messages or side effects. |

### Additional rules

- A dispatch means “accepted for delivery”; it does not mean the model started or the task completed.
- `exchange_id` correlates DS-Bot delivery to DSH's log. `turn/start`/`turn/end` are evidence, not the task lifecycle itself.
- A DSH `turn/end` with `error`, `aborted`, `max-tokens`, or `interrupted` is classified explicitly; it is not silently mapped to success.
- `max-tokens` is a failed/incomplete attempt, not completion.
- The task journal must survive `state.json` loss independently, or be reconstructible from its own append-only record.
- Retention must preserve task identities and terminal outcomes; pruning full prompts/results must not erase idempotency keys or approval decisions.
- Any external side effect must have an effect key accepted by its target. DSH cannot make an arbitrary filesystem or API action exactly-once.

## Storage decision: SQLite, JSONL, and DSH

**DSH lifecycle events alone are insufficient.** They are excellent attempt evidence and prove interruption, but they do not own task intent, dependency satisfaction, approval policy, retry budgets, or business completion. The DSH Schedule receipt expressly acknowledges inbox delivery, not completion. DS-Bot's goal events are capped at 50 and embedded in a mutable whole-file snapshot; its task ledger is best-effort.

**SQLite is the preferred V1 store.** Use one local `tasks.sqlite` per DSH home/team, WAL mode, foreign keys, and these tables: `tasks`, `task_edges`, `attempts`, `approvals`, `task_events`, and `outbox`. SQLite transactions and unique indexes directly express idempotency, compare-and-set transitions, lease ownership, dependency reads, and durable outbox delivery without a service. This is still local storage, not an orchestration runtime.

Caveat: Node 24's built-in `node:sqlite` is available without a flag but is still labeled Stability 1.2 (release candidate), as of the [Node 24 SQLite docs](https://nodejs.org/docs/latest-v24.x/api/sqlite.html). It is acceptable for a prototype behind a storage interface and conformance tests, but DSH/DS-Bot compatibility and the packaged Electron runtime must be verified before shipping. If that risk is unacceptable, use a maintained SQLite binding or the JSONL fallback.

**JSONL can satisfy the semantics only with more custom machinery.** A correct fallback is an append-only log per task/team plus atomic snapshots: one writer, append-and-fsync, checksummed records, torn-tail detection, monotonic sequence numbers, snapshot compaction, and replay. That is essentially reimplementing a small transaction/outbox layer. Use it only if adding SQLite is a worse product risk. The current `tasks-*.jsonl` ledger is not sufficient because writes are fire-and-forget and there is no task state machine.

**No cross-store transaction is implied.** DSH and the task DB cannot be updated atomically. Therefore: commit task state and outbox intent first; deliver using a stable `exchange_id`; record dispatch acknowledgement; reconcile uncertain outcomes from DSH's durable Session log. This is an at-least-once design with idempotent consumers, not a claim of exactly-once execution.

## Smallest implementation shape

1. **Task journal module** (`src/host/task-journal.js` or equivalent): schema, append event, project state, transaction/CAS helpers, migration, retention.
2. **Coordinator/dispatcher**: selects eligible tasks, writes outbox row, calls the existing `rt.deliver()` once, maps `exchangeId` to attempt, and records acknowledgement. It must not call a new agent loop.
3. **Lifecycle adapter**: listens to existing `session/event` and `approval/*` events, translating `turn/start`, `turn/end`, tool failures, and approval decisions into attempt evidence. Keep translation idempotent by DSH event identity/sequence.
4. **Approval adapter**: extend `approvals.js` so the pending record is inserted before emitting the card; decisions update that row transactionally; restart rehydrates the card from the durable row. Retain the current fail-closed/first-answer behavior.
5. **Recovery sweeper**: on startup, reconcile every non-terminal task with a stale lease or unresolved dispatch against the DSH log. Mark unknown effects and require explicit retry/approval when replay safety cannot be proven.
6. **Operator surface**: task state, attempts, deadlines, dependency reason, approval history, and a “retry/resume/cancel” command. Do not expose raw graph internals.

## Explicit non-goals for V1

- No Temporal server, database cluster, namespace, worker fleet, replay determinism/versioning system, or Temporal UI.
- No LangGraph Pregel executor, graph DSL, or checkpoint saver as DS-Bot's main agent loop.
- No second scheduler that competes with DSH Schedule; DS-Bot schedules task decisions, while DSH remains the prompt-delivery mechanism when scheduling is needed.
- No exactly-once promises for arbitrary tools. Only idempotent effects with explicit keys can be retried safely.
- No ping-pong retry loops. After an uncertain crash, require reconciliation and bounded retry policy.

## Adoption gates for an external orchestrator

Revisit this decision only with measured evidence of at least one of:

- multiple DS-Bot hosts must cooperatively execute one task graph with leader leases;
- local single-writer SQLite/JSONL has a demonstrated reliability or scale failure;
- task graphs require worker-fleet routing, deterministic replay/versioning, or external event-history retention/audit obligations;
- approval volume/retention or regulatory audit requires a control plane beyond DS-Bot's local store;
- a production reference shows the existing DS-Bot/DSH hybrid cannot meet crash or duplicate-delivery SLAs.

Even then, Temporal is the closer architectural fit than LangGraph because it separates the durable workflow control plane from the existing agent worker. LangGraph should remain an implementation reference unless DS-Bot intentionally replaces DSH's agent loop.

## Verification and test plan for the future implementation

- Unit: schema migrations, event replay, cycle detection, retry classification, deadline/lease transitions, approval validation.
- Crash matrix: after task admission; after outbox commit; after `rt.deliver()` acceptance but before DSH `turn/start`; after `turn/start`; after an external side effect but before completion; during approval wait; during result persistence.
- Duplicate matrix: duplicate create, duplicate dispatch, duplicate DSH event, duplicate approval, duplicate resume, late completion after timeout.
- Pause matrix: pause before dispatch, during attempt, during approval, and while dependents are blocked.
- Integration: use the mock model and isolated `.dsh-test-<name>` bench only; never point tests at a real `~/.dsh` or DSH_HOME data.
- Regression gates: `npm test`, `node scripts/build-client.mjs --check`, `npm run lint`; run the documented smoke test for host/session changes.

## Source list

Official/upstream documentation:

- Temporal Event History: <https://docs.temporal.io/workflow-execution/event#event-history>
- Temporal Retry Policies: <https://docs.temporal.io/encyclopedia/retry-policies>
- Temporal Activity Execution: <https://docs.temporal.io/activity-execution>
- Temporal Workflow Message Passing: <https://docs.temporal.io/encyclopedia/workflow-message-passing>
- Temporal Approval Pattern: <https://docs.temporal.io/design-patterns/approval>
- Temporal Workflow IDs: <https://docs.temporal.io/workflow-execution/workflowid-runid>
- Temporal Workflow Pause: <https://docs.temporal.io/encyclopedia/workflow/workflow-pause>
- Temporal Persistence: <https://docs.temporal.io/temporal-service/persistence>
- Temporal Self-hosted Embedded Server: <https://docs.temporal.io/self-hosted-guide/embedded-server>
- Temporal TypeScript Testing: <https://docs.temporal.io/develop/typescript/best-practices/testing-suite>
- LangGraph Persistence: <https://docs.langchain.com/oss/python/langgraph/persistence>
- LangGraph Checkpointers: <https://docs.langchain.com/oss/python/langgraph/checkpointers>
- LangGraph Interrupts: <https://docs.langchain.com/oss/python/langgraph/interrupts>
- LangGraph Fault Tolerance: <https://docs.langchain.com/oss/python/langgraph/fault-tolerance>
- DSH Sessions: <https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/session.md>
- DSH Persistence: <https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/persistence.md>
- DSH Schedule: <https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/schedule.md>
- DSH Approval: <https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/approval.md>
- Node SQLite: <https://nodejs.org/docs/latest-v24.x/api/sqlite.html>

Pinned source-reference evidence:

- `temporalio/temporal@6d085822273f4336796e6959c73ab1d14a23eb77:go.mod:L1-L40`
- `temporalio/sdk-typescript@efafd16ef4533da24029277bd72caf564c7aa007:packages/workflow/src/workflow.ts:L182-L191,L738,L1075,L1359-L1375,L1428-L1582`
- `temporalio/sdk-typescript@efafd16ef4533da24029277bd72caf564c7aa007:packages/common/src/activity-options.ts:L83-L132`
- `temporalio/sdk-typescript@efafd16ef4533da24029277bd72caf564c7aa007:packages/common/src/workflow-options.ts:L96-L147`
- `langchain-ai/langgraph@08a2016953789a4f579b4d36bd1967941ec62012:libs/langgraph/langgraph/graph/state.py:L1177-L1212`
- `langchain-ai/langgraph@08a2016953789a4f579b4d36bd1967941ec62012:libs/langgraph/langgraph/types.py:L428-L913`
- `langchain-ai/langgraph@08a2016953789a4f579b4d36bd1967941ec62012:libs/langgraph/langgraph/pregel/_retry.py:L577`
- `langchain-ai/langgraph@08a2016953789a4f579b4d36bd1967941ec62012:libs/checkpoint-sqlite/pyproject.toml:L1-L18`

Repository evidence (baseline `26228dfa`):

- `ds-bot/src/host/goals.js`, `approvals.js`, `resume.js`, `requests.js`, `handoffs.js`, `task-ledger.js`, `schedules.js`, `store.js`
- `ds-bot/test/group-goal.test.js`, `follow-through.test.js`, `inflight-file.test.js`, `handoff-results.test.js`, `approval-notices.test.js`, `task-ledger.test.js`, `schedules.test.js`
- `ds-bot/dev/harness/package.json` pins `@deepseek-ai/dsh@0.2.2-rc.1`
