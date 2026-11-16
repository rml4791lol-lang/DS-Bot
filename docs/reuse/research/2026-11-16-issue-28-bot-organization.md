# Source audit: multi-Bot organization, turn-taking, and handoff

- Issue: [#28](https://github.com/rml4791lol-lang/DS-Bot/issues/28)
- Date: 2026-11-16
- DS-Bot baseline: `26228dfa1e52d536eda78a60936e5c0664e29e9c`
- Decision: keep DSH as the only Bot runtime. Do not import a second agent loop, session store, server, or orchestration runtime. Adopt a small persisted organization contract over DS-Bot's existing rooms, group Sessions, queueing, and work tree; use the upstream projects as conformance cases.

## Outcome first

DS-Bot already has the strongest fit for its own product: independent Bots in DSH Sessions, per-Bot and per-group memory, deterministic mentions, ordered and parallel room turns, a `message_bot` work tree, result aggregation, idempotent request ids, Main Bot / group-admin authority, and restart-aware delivery. The upstream systems do not justify replacing any of that.

The smallest V1 contract is one persisted `WorkEnvelope` plus four invariants:

1. **One identity, one turn lease:** every Bot has one identity but may have separate DM/group Sessions; at most one live turn per Session and one live room round per room.
2. **Deterministic dispatch:** explicit mentions, room lead/admin, or ordered all-member turns decide speakers. V1 does not add an LLM speaker router.
3. **Bounded turn and explicit termination:** every turn ends as replied, passed, failed, timed out, stopped, or yielded-to-background; silence is never mistaken for success.
4. **Exactly-once result tree:** every child work has one parent, one terminal result, and one parent wake; the parent resumes only after all required children are terminal, or after a typed abandonment/timeout settles a missing child.

This is a state-machine contract, not a new Bot system. It should be enforced inside `ds-bot/src/host/` and expressed in the existing append-only task ledger.

## Scope and method

Primary sources were reviewed at pinned commits, not moving branches:

| System          | Audited revision                                                                                                                                                                                | Release / activity                                                    | License    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------- |
| Hermes Bot Mode | [`NousResearch/Hermes-Bot-Mode@80fee22582b871b9765a65e2992b8b5a8211c9f8`](https://github.com/NousResearch/Hermes-Bot-Mode/commit/80fee22582b871b9765a65e2992b8b5a8211c9f8) (`main`, 2026-08-17) | No GitHub release; repository marks itself archived and moved in-tree | MIT        |
| Hermes Agent    | [`NousResearch/hermes-agent@3b421578588243f920886e6fe79a6faa87ea026e`](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.1) (`v0.23.1`, 2026-11-10)                               | Active; built-in Bot Mode and delegation                              | MIT        |
| OpenMausBot     | [`milind-soni/OpenMausBot@c31dd5d101098c81ff9025249caf24e4e172cb4d`](https://github.com/milind-soni/OpenMausBot/releases/tag/v0.1.161) (`v0.1.161`, 2026-11-15)                                 | Active                                                                | Apache-2.0 |
| OpenCode        | [`anomalyco/opencode@810c0eba1a7348036f8bdf61e6632d0c36c6876c`](https://github.com/anomalyco/opencode/releases/tag/v1.19.5) (`v1.19.5`, 2026-10-28)                                             | Active                                                                | MIT        |
| DS-Bot          | [`rml4791lol-lang/DS-Bot@26228dfa1e52d536eda78a60936e5c0664e29e9c`](https://github.com/rml4791lol-lang/DS-Bot/commit/26228dfa1e52d536eda78a60936e5c0664e29e9c)                                  | `0.3.6`, preview; DSH `0.2.2-rc.1`                                    | Apache-2.0 |

Test counts below are inventories of test files at those revisions, not claims that every suite was executed during this audit. Runtime execution was intentionally out of scope: the ticket asks for source-level comparison and a reuse decision.

## Comparison matrix

| Concern             | Hermes Bot Mode / Hermes Agent                                                              | OpenMausBot                                                                                   | OpenCode                                                                           | DS-Bot today                                                                     | V1 decision                                              |
| ------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Identity            | A Bot is a Hermes profile with isolated config, memory, skills, credentials, and history    | Bot record with its own model, threads, workspace memory, apps/computer                       | Agent config selected per Session; no product-level Bot roster                     | Bot identity in DSH; DM Session plus persistent per-group Session; scoped memory | Keep DS-Bot identity and Session model                   |
| Shared room context | One room log, per-thread/per-member watermarks                                              | Channel transcript plus shared instructions; per-Bot task threads                             | No room organization layer                                                         | Room log, seen positions, group Session per member                               | Keep existing; add no new store                          |
| Speaker selection   | Deterministic `@mention`; otherwise everyone; built-in rotates lead                         | Explicit mentions/`@everyone`; auto mode uses decision model with lead fallback               | None                                                                               | Admin-first by default; explicit mentions; ordered all-member mode               | Deterministic mentions/lead/admin only in V1             |
| Turn order          | Serial; user send bumps epoch and supersedes old round                                      | Room jobs serial by default; optional isolated lanes                                          | One runner per Session; steer/queue input                                          | Ordered rounds serial; multi-target calls concurrent; per-member serial calls    | Preserve DS ordering and concurrency split               |
| Termination         | `(pass)`, empty, failure/timeout; 3 rounds / 10 messages                                    | Turn outcome, provider failure, parked, stall timeout; wait-for-user holds clock              | Model loop until stop; prompt queue/steer                                          | `[PASS]`, failure, timeout/late work, approval/working yield; idle-loop pause    | Make every terminal outcome explicit and durable         |
| Handoff payload     | Original: natural-language CLI message. Hermes Agent: goal/context, task id, parent session | Rich work/assignment: root/parent, requester, assignee, mode, reply policy, acceptance, files | Prompt, agent type, reusable task id, parent Session, permissions                  | Self-contained message, queue/steer, reply target, request id, parent work       | Standardize one `WorkEnvelope`; preserve existing fields |
| Aggregation         | Hermes Agent batch returns child summaries; background result injected once                 | Parent waits for all children; failure can resume early; results in tree                      | Each task returns one final text; parent gets background result injection          | Child results accumulate on parent; caller resumes when all are back             | Aggregate all terminal child results exactly once        |
| Authority           | No product-level Main Bot; profile routing and depth/permission limits                      | Chief of Staff + managed departments; reach is separate from manage authority                 | Child permission derivation; depth limit                                           | Main Bot team-wide; group admin room-scoped; ordinary Bot self/group-scoped      | Keep DS-Bot authority; do not add OpenMaus Chief         |
| Stall recovery      | Built-in harvests stranded replies and hard-caps runs                                       | Heartbeats, admission reasons, restart ticks, parked work, recovery/fallback                  | Session cancel and child cancellation; process restart loses lifecycle API handles | Resume interrupted turns once, late answers tombstoned, lost targets reconciled  | Add typed terminal state and one retry/recovery policy   |
| Reuse fit           | Pattern and tests; host-specific                                                            | Pattern and possibly pure queue helpers after a failing DS test                               | Pattern only; different runtime and weak organization surface                      | Canonical implementation target                                                  | No wholesale import                                      |

## Source audit: Hermes Bot Mode and Hermes Agent

### Identity, Sessions, and memory

Standalone Hermes Bot Mode defines a Bot as a Hermes profile with isolated config, memory, skills, credentials, and chat history. Each member keeps a persistent per-group Session, and a room has one ordered log with per-member watermarks. The standalone repository is now archived and points development to the in-tree Hermes Agent plugin.

- [Hermes Bot Mode `README.md:L3-L35`](https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/README.md#L3-L35)
- [Hermes Bot Mode `plugin.js:L2245-L2256`](https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/plugin.js#L2245-L2256)
- [Hermes Agent `apps/desktop/src/plugins/hermes-bots/group-rounds.ts:L37-L48`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/apps/desktop/src/plugins/hermes-bots/group-rounds.ts#L37-L48)

The in-tree version improves room identity and persistence: Sessions are scoped by room identity and thread, and watermarks are keyed by `${thread}::${member}` so parallel topics do not consume each other's deltas.

- [Hermes Agent `group-rounds.ts:L643-L654`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/apps/desktop/src/plugins/hermes-bots/group-rounds.ts#L643-L654)
- [Hermes Agent `group-turns.ts:L270-L321`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/apps/desktop/src/plugins/hermes-bots/group-turns.ts#L270-L321)

### Mentions, speaker selection, and turn termination

The original and in-tree implementations share a deterministic rule: parse mentions since the last user message; if any member is named, only named members respond, otherwise everyone responds. Rounds rotate the lead. There is no LLM router in the room loop.

- [Hermes Bot Mode `plugin.js:L2274-L2367`](https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/plugin.js#L2274-L2367)
- [Hermes Agent `group-rounds.ts:L170-L263`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/apps/desktop/src/plugins/hermes-bots/group-rounds.ts#L170-L263)

The standalone plugin allowed three rounds, ten posted messages, six members, and treated empty/`(pass)`/failure/timeout as silence. The in-tree version keeps three rounds, ten messages, and six members, adds two independently bounded continuation rounds, distinguishes `settled` from `capped`, harvests late stranded replies, and extends a visibly working turn up to a three-hour hard cap instead of treating a fixed three-minute poll timeout as final.

- [Hermes Bot Mode `plugin.js:L2258-L2261`](https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/plugin.js#L2258-L2261)
- [Hermes Bot Mode `plugin.js:L2510-L2642`](https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/plugin.js#L2510-L2642)
- [Hermes Agent `group-chat.ts:L1428-L1468`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/apps/desktop/src/plugins/hermes-bots/group-chat.ts#L1428-L1468)
- [Hermes Agent `group-rounds.ts:L675-L811`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/apps/desktop/src/plugins/hermes-bots/group-rounds.ts#L675-L811)
- [Hermes Agent `group-turns.ts:L630-L641`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/apps/desktop/src/plugins/hermes-bots/group-turns.ts#L630-L641)

### Relay, concurrency, and conflict control

Standalone Bot Mode is serial round-robin. A new user send increments the room epoch; the current loop notices at the next member boundary and the newest drive takes over. The in-tree stop path is stronger: it increments the epoch, marks future turns held, and sends `session.interrupt` to the current member. Failure is reported rather than silently converted into success.

- [Hermes Bot Mode `plugin.js:L2579-L2692`](https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/plugin.js#L2579-L2692)
- [Hermes Agent `group-rounds.ts:L527-L613`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/apps/desktop/src/plugins/hermes-bots/group-rounds.ts#L527-L613)
- [Hermes Agent `group-turns.ts:L1102-L1168`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/apps/desktop/src/plugins/hermes-bots/group-turns.ts#L1102-L1168)

### Delegation and handoff payloads

Original Bot Mode mentions are not a structured work tree. The active model is instructed to compose a CLI message, launch it in the background, end its turn, and relay the completion later. This is useful UX evidence, but too weak for DS-Bot's task relationships.

- [Hermes Bot Mode `plugin.js:L6439-L6455`](https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/plugin.js#L6439-L6455)

Hermes Agent's separate `delegate_task` is the stronger reference: fresh child context, goal + context, own task id, optional resume by task id, parent Session id, depth limit, inherited deny/external-directory permissions, parallel batches, one child summary, background result injection, and explicit completed/error handling.

- [Hermes Agent `tools/delegate_tool.py:L1-L11`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/tools/delegate_tool.py#L1-L11)
- [Hermes Agent `tools/delegate_tool.py:L378-L440`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/tools/delegate_tool.py#L378-L440)
- [Hermes Agent `tools/delegate_tool_dispatch.py:L1-L4`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/tools/delegate_tool_dispatch.py#L1-L4)
- [Hermes Agent `tools/delegate_tool_dispatch.py:L209-L254`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/tools/delegate_tool_dispatch.py#L209-L254)

Its lifecycle API is a useful protocol reference: serializable handles, `PENDING` through `CANCELLED`, cooperative cancel, immutable idempotent results, bounded results, and explicit loss of reconnect after process restart. DS-Bot should copy these semantics, not the Python implementation.

- [Hermes Agent `website/docs/developer-guide/subagent-lifecycle-api.md:L8-L66`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/website/docs/developer-guide/subagent-lifecycle-api.md#L8-L66)

A2A is relevant only as an external interoperability service. Hermes recommends same-machine agents use in-process delegation or a durable multi-profile queue, and A2A for crossing process/machine/framework boundaries. DS-Bot V1 must not turn A2A into a second internal organization layer.

- [Hermes Agent A2A guide `website/docs/user-guide/messaging/a2a.md:L1-L40`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/website/docs/user-guide/messaging/a2a.md#L1-L40)
- [Hermes Agent A2A guide `website/docs/user-guide/messaging/a2a.md:L42-L78`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/website/docs/user-guide/messaging/a2a.md#L42-L78)
- [Hermes Agent A2A design `plugins/platforms/a2a/DESIGN.md:L95-L150`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/plugins/platforms/a2a/DESIGN.md#L95-L150)

## Source audit: OpenMausBot

### Identity, Sessions, and memory

OpenMausBot explicitly gives each Bot its own model, computer, apps, task threads, and workspace memory. Its workspace code states the design directly: per-Bot workspaces under `~/.openmausbot/workspaces/<botId>/` double as file-based memory, with a per-Bot `MEMORY.md` and on-demand memory topics.

- [OpenMausBot `README.md:L85-L105`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/README.md#L85-L105)
- [OpenMausBot `server/workspace.ts:L1-L14`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/workspace.ts#L1-L14)
- [OpenMausBot `server/workspace.ts:L85-L95`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/workspace.ts#L85-L95)

Channels/rooms own a shared transcript, instructions, working folder, responder rules, and roster; Bot threads are separate tasks with `openedBy`, model, approval mode, cursors, and context state.

- [OpenMausBot `README.md:L190-L200`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/README.md#L190-L200)
- [OpenMausBot `server/store.ts:L77-L116`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/store.ts#L77-L116)
- [OpenMausBot `server/task-record.ts:L14-L33`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/task-record.ts#L14-L33)

### Mentions and speaker selection

OpenMausBot supports explicit mentions and `@everyone`; absent a mention, a room lead answers unless the room is in Auto mode. Auto uses a small decision model and falls back to the lead/first member on timeout, invalid output, network/provider failure, or low confidence. The model chooses a speaker, not the work.

- [OpenMausBot `server/store.ts:L198-L259`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/store.ts#L198-L259)
- [OpenMausBot `docs/decision-model.md:L107-L148`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/docs/decision-model.md#L107-L148)

This is valuable future work, but not minimum V1: DS-Bot's deterministic admin/mention behavior has lower latency, lower cost, and easier tests. The OpenMaus router is a fallback-safe optional policy, not a dependency the organization contract requires.

### Relay, queueing, concurrency, and conflict control

OpenMausBot separates admission surfaces (`direct`, `direct-busy`, `room`, `peer`, `guarded`, `unattended`, `incident`) and decisions (`steer`, `queue`, `start`, `refuse`) in a pure module. Rooms queue by default; only the queue head can steer the live speaker; guarded external sends refuse while busy; incidents are never refused.

- [OpenMausBot `server/admission.ts:L1-L23`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/admission.ts#L1-L23)
- [OpenMausBot `server/admission.ts:L88-L159`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/admission.ts#L88-L159)

The visible queue is deterministic and honest: one running item, queued items in order, each naming what it waits for. Sequential room jobs explicitly tell the model not to claim parallel dispatch.

- [OpenMausBot `server/room-queue.ts:L10-L50`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/room-queue.ts#L10-L50)
- [OpenMausBot `server/host/room-jobs.ts:L27-L84`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/host/room-jobs.ts#L27-L84)

The room driver runs one operation at a time by default. With the `parallelRoomJobs` feature enabled, independent work gets isolated work threads/lanes; results return as cards and the caller resumes once with all of them. This maps closely to DS-Bot's existing "ordered discussion, parallel named calls" split.

- [OpenMausBot `server/index.ts:L10890-L10961`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/index.ts#L10890-L10961)

### Delegation, task relationships, and aggregation

`coordinate_bots` carries group id, targets, message, reason, rework, standing/new thread, reply mode, consult mode, folder choice, done condition, title, project id, answer target, files, and task relationships. The coordinator creates a parent/rooted tree and exposes queued/running/waiting/resume/completed/failed/cancelled states.

- [OpenMausBot `server/coordinator.ts:L8-L78`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/coordinator.ts#L8-L78)

Enqueue rejects missing/stale parents, validates the speaker, bounds the brief, deduplicates identical sibling work, refuses ancestor cycles, blocks crossed mutual waits, applies depth/request limits, and records requester/assignee/reply policy. `reply` is `resume`, `poll`, or `none`; modes are `work`, `consult`, and `notify`.

- [OpenMausBot `server/runtime-coordinator.ts:L235-L287`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/runtime-coordinator.ts#L235-L287)
- [OpenMausBot `server/runtime-coordinator.ts:L656-L700`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/runtime-coordinator.ts#L656-L700)

When a child ends, its result is attached to the parent tree. The parent does not resume until its open children are terminal; failures are results too. A duplicate identical request may join an earlier answer instead of starting a second worker. This is the closest mature analogue to DS-Bot's work tree.

### Coordinator authority

OpenMausBot separates reach from authority. Any visible Bot may reach another, but only a Chief with the target's managed section, ownership relation, or team-owner authority may manage it. A Team Cloud member's Bot cannot inherit more authority than its person.

- [OpenMausBot `server/peer-roster.ts:L23-L80`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/peer-roster.ts#L23-L80)
- [OpenMausBot `server/chief-level.ts:L13-L36`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/chief-level.ts#L13-L36)

DS-Bot already has a clearer product contract: Main Bot vs room admin vs ordinary Bot. Do not introduce a second "Chief" role in V1.

### Failure and stall recovery

OpenMausBot uses progress-aware stall timers: progress resets the deadline, waiting on a person/tool holds the clock, and a stall invokes the registered handler. Room turn state distinguishes settled, provider failure, and parked.

- [OpenMausBot `server/room-turn-timeout.ts:L51-L164`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/room-turn-timeout.ts#L51-L164)
- [OpenMausBot `server/room-turn-end.ts:L1-L12`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/room-turn-end.ts#L1-L12)

Its handoff ticker runs at 250 ms while busy, 10 s while parked, and hourly while idle; writes can kick an immediate tick. That pacing is a useful recovery rule even if the implementation is not imported.

- [OpenMausBot `server/handoff-ticks.ts:L1-L58`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/server/handoff-ticks.ts#L1-L58)

## Source audit: OpenCode

OpenCode contributes delegation mechanics, not an organization model. It has no room roster, mention dispatcher, speaker selector, or team authority layer in the audited source. Its useful parts are Session lineage, one-runner-per-Session concurrency, child permission derivation, resumable task ids, and input queue/steer semantics.

- [OpenCode `packages/opencode/src/tool/task.ts:L24-L79`](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/tool/task.ts#L24-L79)
- [OpenCode `packages/opencode/src/tool/task.txt:L3-L16`](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/tool/task.txt#L3-L16)

A task gets a child Session with `parentID`, a selected agent type, inherited deny/external-directory permissions, a model, and optional background execution. `task_id` resumes the same child Session; depth is capped; a foreground task returns one final text; a background task injects one synthetic result into the parent.

- [OpenCode `task.ts:L104-L172`](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/tool/task.ts#L104-L172)
- [OpenCode `task.ts:L181-L225`](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/tool/task.ts#L181-L225)
- [OpenCode `task.ts:L227-L345`](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/tool/task.ts#L227-L345)

The Session tree and concurrency guard are explicit: children have a `parentID`, recursive deletion removes descendants, and a Session has at most one active runner. Prompts are durably admitted as `steer` or `queue`; queued inputs are promoted after the current continuation, while steers are consumed before the next queued input.

- [OpenCode `packages/opencode/src/session/session.ts:L596-L619`](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/session/session.ts#L596-L619)
- [OpenCode `packages/opencode/src/session/run-state.ts:L35-L107`](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/session/run-state.ts#L35-L107)
- [OpenCode `packages/core/src/session/input.ts:L41-L80`](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/core/src/session/input.ts#L41-L80)
- [OpenCode `packages/core/test/session-runner.test.ts:L2060-L2190`](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/core/test/session-runner.test.ts#L2060-L2190)

## DS-Bot fit and gaps

### What DS-Bot already owns

DS-Bot's stated model already matches the product: independent DSH-based Bots, Main Bot organization, group chats, persistent memory, one group memory, and visible activity.

- [DS-Bot `docs/vision.md:L7-L26`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/docs/vision.md#L7-L26)

Its room implementation is not a toy. It has one persistent group Session per member, ordered all-member rounds, immediate multi-member calls, per-member serialization, `[PASS]`, failure display, late results, work/approval yielding, and a persisted idle-loop pause after repeated zero-tool turns. It explicitly lets background work leave the round and return later.

- [DS-Bot `ds-bot/src/host/groups.js:L1-L18`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/groups.js#L1-L18)
- [DS-bot `groups.js:L415-L445`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/groups.js#L415-L445)
- [DS-Bot `groups.js:L849-L890`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/groups.js#L849-L890)
- [DS-Bot `groups.js:L1042-L1078`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/groups.js#L1042-L1078)
- [DS-Bot `groups.js:L1126-L1199`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/groups.js#L1126-L1199)
- [DS-Bot `groups.js:L958-L1018`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/groups.js#L958-L1018)
- [DS-Bot `ds-bot/src/host/constants.js:L38-L90`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/constants.js#L38-L90)

Its direct handoff layer already has parent/child works, whole-result files, all-child aggregation, late-answer tombstones, abandoned waits, and restart reconciliation. `message_bot` has queue vs steer, reply-to-caller vs reply-to-user, and caller-supplied idempotent request ids.

- [DS-Bot `ds-bot/src/host/handoffs.js:L1-L7`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/handoffs.js#L1-L7)
- [DS-Bot `handoffs.js:L108-L142`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/handoffs.js#L108-L142)
- [DS-Bot `handoffs.js:L209-L266`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/handoffs.js#L209-L266)
- [DS-Bot `handoffs.js:L307-L390`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/handoffs.js#L307-L390)
- [DS-Bot `ds-bot/src/host/tools.js:L239-L350`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/tools.js#L239-L350)

Delivery already batches plain relay notes while busy, coalesces duplicates through the backlog, and sends steer/silent/follow-up according to role. The task ledger records only ids and lifecycle facts, not transcript bodies.

- [DS-Bot `ds-bot/src/host/delivery.js:L19-L51`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/delivery.js#L19-L51)
- [DS-Bot `delivery.js:L183-L230`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/delivery.js#L183-L230)
- [DS-Bot `ds-bot/src/host/backlog.js:L12-L95`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/backlog.js#L12-L95)
- [DS-Bot `ds-bot/src/host/task-ledger.js:L1-L57`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/task-ledger.js#L1-L57)

Authority is also already decided: Main Bot team-wide, group admin room-wide, ordinary Bot self/group-scoped, and DSH enforces sandbox permissions separately. The user alone grants Main Bot or sandbox level.

- [DS-Bot `docs/plans/2026-10-07-roles-and-permissions.md:L17-L36`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/docs/plans/2026-10-07-roles-and-permissions.md#L17-L36)

### Real gaps

The gaps are representational, not missing upstream architecture:

1. Group calls live in room `slots`/`batches`, while direct calls live in `state.works`. Both carry parent/open-child semantics, but not one shared typed status/projection.
2. `message_bot` prevents many conflicts, but the work tree does not expose one canonical `queued/running/waiting/completed/failed/cancelled/abandoned` state for room and direct calls alike.
3. Batch or provider failure can be surfaced, but the contract does not require one terminal reason and one aggregation rule for every child before a parent resumes.
4. The 240-second late-answer and 6-idle-step guards are sound, but they are not expressed as a reusable organization-level invariant that new room/job types must satisfy.
5. The task ledger records open/close but not the complete state transition set required to debug a stalled tree.

## Reuse decisions

| Candidate                        | Direct code copy |                               SDK / service | Pattern / conformance tests | Decision                                                                                                                             |
| -------------------------------- | ---------------: | ------------------------------------------: | --------------------------: | ------------------------------------------------------------------------------------------------------------------------------------ |
| Hermes Bot Mode standalone       |               No |                                          No |                         Yes | Archived, no release, and its room/handoff semantics are below current DS-Bot and in-tree Hermes Agent                               |
| Hermes Agent in-tree Bot Mode    |               No |                                          No |                         Yes | Strong tests for deterministic room rounds, stop, stranded harvest, and bounded continuation; host/plugin internals are not portable |
| Hermes Agent `delegate_task`     |               No |                                          No |                         Yes | Use lifecycle/result semantics; Python/threads/background delivery are a different runtime                                           |
| Hermes Agent A2A                 |               No | Only for a future external-peer requirement |                         Yes | Not an internal organization layer; no V1 dependency                                                                                 |
| OpenMausBot admission/queue/tree |         No in V1 |                                          No |                         Yes | Best conformance source after Hermes; pure helpers may be reconsidered only if a DS-Bot regression test still fails                  |
| OpenCode task/session mechanics  |               No |                                          No |                         Yes | Different Bun/Effect runtime and no room organization; use queue/steer and one-runner invariants as tests                            |
| New organization library/runtime |               No |                                          No |                          No | Duplicates DSH and existing DS-Bot host state                                                                                        |

All four upstream licenses are compatible in principle with DS-Bot's Apache-2.0 distribution, but direct adoption would still require source/version pinning, NOTICE updates, dependency review, and tests under ADR-013. That is unnecessary for V1 because no upstream module is both smaller than the DS-Bot host change and portable across runtimes.

## Recommended smallest V1 organization contract

### 1. Canonical `WorkEnvelope`

Persist this minimal record for both direct handoffs and room calls. Existing room slots and batches may project into it; they do not need to be replaced in one step.

```ts
type WorkStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned";

interface WorkEnvelope {
  id: string;
  rootId: string;
  parentId?: string;
  roomId?: string;

  from: { botId: string; sessionId: string };
  to: { botId: string; sessionId: string };

  mode: "work" | "consult" | "notify";
  reply: "resume" | "poll" | "none";
  delivery: "steer" | "queue";

  brief: { text: string; fileRefs?: string[]; doneWhen?: string };
  status: WorkStatus;
  createdAt: number;
  startedAt?: number;
  lastProgressAt?: number;
  endedAt?: number;
  terminal?: { reason: string; summaryRef?: string };
  attempts: number;
  idempotencyKey?: string;
}
```

The payload should remain body-by-reference for large results, matching DS-Bot's existing `handoff-results/` design.Transcripts, hidden reasoning, and full child context must not be copied into the work record.

### 2. Four required state machines

- **Bot turn lease:** `(botId, sessionId)` has at most one running turn. DM and group Sessions may run independently, but one group member has at most one active room call. This matches OpenCode's runner guard, OpenMausBot's per-Bot capacity model, and DS-Bot's current per-member serialization.
- **Room round:** one active round per room. Ordered all-member turns run serially. A message that explicitly calls N members creates N concurrent work items. New user input joins or supersedes the round according to the existing DS-Bot policy; it never creates a second driver.
- **Work tree:** a parent may have zero or more children. Parent status is `waiting_input` while any required child is non-terminal. When all required children are terminal, aggregate them in deterministic creation/index order and wake the parent once. A terminal late result is recorded but does not wake or close again.
- **Recovery:** persist before external delivery; on startup, resume an interrupted work with the same id at most once; reconcile deleted targets to `abandoned`; expose `unknown delivery` instead of retrying when a non-idempotent send's outcome is uncertain.

### 3. Dispatch and termination rules

- `@name` dispatches only named members. `@all`/`@everyone` is valid only from the user or the room admin; ordinary Bots cannot fan out the room.
- No mention goes to the room admin/lead in admin mode, or to all members in ordered mode.
- A turn terminates as `completed` only on a non-empty final reply or a typed successful tool result that the host accepts as the result. `[PASS]` and empty output terminate as `passed`, not `completed`.
- Provider failure, tool failure, timeout, cancellation, and lost Session are distinct terminal reasons. None may be rewritten as a pass.
- Work that visibly continues in the background yields its room slot and later posts a result. It does not hold the whole room open.
- A room-wide idle guard parks further zero-tool Bot-to-Bot calls until the user writes. Preserve DS-Bot's existing six-step policy unless measurements justify a change.
- V1 speaker selection is deterministic: explicit mention → admin/lead → ordered all-member. An OpenMaus-style decision model is deferred until measured ambiguity or misrouting proves a need; if added, it must have a lead fallback and short timeout.

### 4. Conflict and authority rules

- Reject self-work, ancestor cycles, unmatched generations, duplicate `(idempotencyKey, payload)`, and crossed mutual waits.
- A room-originated call may target only current room members. Direct work may target any reachable, non-private Bot; reach never grants management authority.
- A Main Bot may manage non-private Bots, rooms, and team work; a room admin may manage only its room; an ordinary Bot may act only on its own identity and room-scoped calls. Bot deletion, Main Bot grants, and sandbox permission changes remain user-only. Keep this narrower than OpenMausBot's Chief/department model.
- A stop cancels the active Session turn, drops queued messages according to existing policy, persists `cancelled`, and never creates a receipt-only wake.

### 5. Aggregation and handoff payload

A child result envelope should contain `workId`, `parentId`, `from`, `status`, `summary`, optional `artifactRefs`, `startedAt`, `endedAt`, and `attempts`. The parent-facing aggregation should include every terminal child, including failed/abandoned children, in stable order. A parent turn receives one aggregate wake with:

```text
[Handed back to <parent> for work <id>]
<Child A>: completed — summary/artifact refs
<Child B>: failed — typed reason
<Child C>: abandoned — no reply before deadline
```

The parent's own text remains separate from child results. This follows DS-Bot's current `answerText` behavior and OpenMausBot's tree aggregation, while avoiding OpenCode's single-child-only return shape.

### 6. Required acceptance tests

1. Two explicit mentions start together; an unmentioned member does not run; each sees "who else is answering".
2. An ordered all-member round never overlaps speakers and stops on pass/failure/late-work yield.
3. A busy Bot queues a second call; `now` steering is accepted only where the host can steer, and a non-head room call cannot steer.
4. Duplicate `request_id` replays one receipt; same id with a different payload is refused.
5. A parent with children `completed + failed + abandoned` wakes once, with all three results in stable order.
6. A lost target settles `abandoned`; a late reply is recorded once and never reopens the parent.
7. Stop cancels the live Session and prevents queued calls from starting until a user release.
8. Restart resumes a persisted in-flight work at most once and never creates a replacement result.
9. Six zero-tool Bot status turns park calls until the user writes; tool work clears the streak before the limit.
10. A timeout produces a visible typed failure, not silence or `completed`.
11. Room jobs stay serial unless an explicit isolated-lane feature is enabled; the model cannot claim parallel dispatch when the queue is serial.
12. Admin/main authority tests cover fan-out, group modification, and cross-room reach independently.

## Release, dependency, and test notes

- **Hermes Bot Mode:** MIT, single `plugin.js`, no package manifest/dependencies beyond the Hermes Desktop plugin SDK; no release; last commit 2026-08-17. Thirty-five `.test.mjs` files were present.
- **Hermes Agent:** MIT; Python `>=3.11,<3.15`, with an Electron desktop requiring Node `>=26`; 7,940 Python test files and 156 Bot Mode test files were present. The release is `v0.23.1` (2026-11-10).
- **OpenMausBot:** Apache-2.0; Node `>=24`, pnpm `10.33.0`, Electron/TypeScript/Vitest, plus external Claude/Codex/Grok CLI engines and many desktop/cloud integrations; 2,630 test files were present. Release `v0.1.161` (2026-11-15).
- **OpenCode:** MIT; Bun `1.4.4`, Effect/TypeScript monorepo; 733 test/spec files were present. Release `v1.19.5` (2026-10-28). Background subagents are explicitly experimental and require a runtime flag.
- **DS-Bot:** Apache-2.0; `ds-bot` `0.3.6`; Node tests plus an external pinned DSH harness; 224 test files were present in `ds-bot/test`. CI gates are `npm test`, generated-client check, and lint; smoke is required for host/index changes.

Package and test evidence:

- [Hermes Bot Mode `README.md:L65-L78`](https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/README.md#L65-L78), [`LICENSE:L1-L3`](https://github.com/NousResearch/Hermes-Bot-Mode/blob/80fee22582b871b9765a65e2992b8b5a8211c9f8/LICENSE#L1-L3)
- [Hermes Agent `pyproject.toml:L5-L19`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/pyproject.toml#L5-L19), [`apps/desktop/package.json:L1-L18`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/apps/desktop/package.json#L1-L18)
- [OpenMausBot `package.json:L1-L43`](https://github.com/milind-soni/OpenMausBot/blob/c31dd5d101098c81ff9025249caf24e4e172cb4d/package.json#L1-L43)
- [OpenCode `packages/opencode/package.json:L1-L20`](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/package.json#L1-L20)
- [DS-Bot `ds-bot/package.json:L1-L30`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/package.json#L1-L30), [`README.md:L7-L9`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/README.md#L7-L9)

## Caveats and uncertainty

- OpenMausBot changes quickly; use `v0.1.161` as the audit snapshot, not a permanent API promise.
- Hermes Bot Mode is archived. Its standalone source is useful history; the maintained source is inside Hermes Agent.
- Hermes Agent's in-tree Bot Mode is desktop-plugin code and is evolving. It is evidence for conformance, not a stable third-party organization API.
- Test-file counts measure coverage surface, not pass rates. No upstream suite was executed for this note.
- The decision-model route in OpenMausBot is optional and provider-dependent; it was not evaluated as a DS-Bot V1 requirement.
- The V1 contract should be implemented inside DS-Bot's host layer. If a future requirement needs cross-machine agents, evaluate A2A as an external connector at that time, not as a replacement runtime.

## Reusable takeaway

Adopt DS-Bot's current architecture and make its implicit organization semantics explicit: one Bot identity, one turn lease per Session, one room round at a time, deterministic mention/lead dispatch, explicit terminal outcomes, and one exactly-once parent-child result tree. Use Hermes Agent for room recovery and lifecycle concepts, OpenMausBot for admission/tree/queue conformance, and OpenCode for Session lineage and queue/steer tests. Import no upstream runtime in V1.
