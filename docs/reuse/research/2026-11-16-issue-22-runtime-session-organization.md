# Issue #22: DS-Bot and DSH runtime, Session, and organization ownership

- **Date:** 2026-11-16
- **DS-Bot baseline:** [`26228dfa1e52d536eda78a60936e5c0664e29e9c`](https://github.com/rml4791lol-lang/DS-Bot/tree/26228dfa1e52d536eda78a60936e5c0664e29e9c).
- **DSH baseline:** official tag [`dsh-v0.2.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1), commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`, tagged 2026-11-04; npm package [`@deepseek-ai/dsh@0.2.2-rc.1`](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.2-rc.1). DS-Bot pins this version in both the app and test harness: [app/package.json:25-65][db-app-package], [ds-bot/dev/harness/package.json:1-10][db-harness-package].
- **Method:** source and generated API-doc inspection at those exact revisions. No real `~/.dsh`, `DSH_HOME`, credentials, cookies, or tokens were read. No third-party sources were needed.

## Decision

Keep **DSH as the only Agent Runtime** and keep **DS-Bot as the organization/product authority**.

- DSH owns the Agent loop, Session event log, model/tool execution, inbox delivery, turn/step lifecycle, cancellation, compaction mechanics, permission presets, and optional subagent execution.
- DS-Bot owns Bot identity and profiles, the roster, Main Bot and group-admin policy, rooms and membership, mentions, group rounds, Bot-to-Bot work trees, recovery policy, and the product UI/API.
- A Bot is a durable DS-Bot identity anchored to a Session history, not a new runtime. The first own-chat Session id is the Bot id; the current chat can move to newer Session “parts” while old parts remain archived/readable ([store.js:451-526][db-store-sessions]).
- DSH's experimental Agent Teams roster/task DAG must **not** become a second organization model. It is explicitly experimental, flat, Lead-centric, shared-checkout, and has no retry or ownership-release guarantee ([Agent Teams limitations][dsh-agent-team-limits]).

This is already the working architecture; the audit found no requirement to patch DSH or introduce another runtime.

## Ownership map

| Object / authority | Current owner | Representation | Important boundary |
|---|---|---|---|
| Agent loop, model call, tool call, step/turn | DSH | DSH `SessionEvent` log plus live `agent/*` events | DS-Bot observes and directs; it does not implement the loop. See [agent lifecycle][dsh-agent-lifecycle] and [Session events][dsh-session-events]. |
| Conversational transcript and history | DSH | Event-sourced `Session`; persistence is a DSH persistence plugin | `session/event` is replay truth; `agent/*` is live coordination/status ([DSH Session README][dsh-session-readme]). |
| Bot identity/profile | DS-Bot | `state.bots[botId]`: name, role label, instructions, model, effort, folder, capabilities, session id, prior segments | Bot id is the first own-chat Session id. Callers must use `chatOf(botId)`/`bot.sessionId`, not assume `botId === current SessionId` ([roster.js:183-225][db-roster-bot], [store.js:443-526][db-store-sessions]). |
| Main Bot authority | DS-Bot | `state.mainBotIds[]` | Multiple Main Bots are allowed, at least one must remain, and a Main Bot cannot be deleted until demoted ([roster.js:895-932][db-roster-main]). It is not a DSH role. |
| Group membership/admin/mode | DS-Bot | `state.rooms[roomId]` with `members`, `admin`, `mode`, `notice`, `sessions`, `segments`, log and shared todos | Group admin is product authority over one room only; Main Bots may manage all non-private rooms according to DS-Bot checks ([roster.js:623-808][db-roster-rooms]). |
| Per-Bot and per-group sandbox preset | DS-Bot policy over DSH | Bot/room `permission`; applied to each DSH Session through `ctx.permissionPresets` | DSH enforces sandbox/approval knobs; only the user may change the product-level preset ([permissions.js:1-116][db-permissions]). |
| Group round and mention dispatch | DS-Bot | `roomProgress`, `roomBatches`, `room.log` plus room Session inbox | One round per room; calls in one message can run concurrently; ordered “everyone” turns remain sequential ([groups.js:1-18][db-groups-header], [groups.js:1202-1373][db-groups-rounds]). |
| Bot-to-Bot work tree | DS-Bot | `state.works[workId]`: `from`, `to`, `room`, `parent`, `child`, `open[]`, `results[]`, `held` | A handoff is a product work item/message tree, not a DSH Agent child or task object ([handoffs.js:108-142][db-handoffs-open]). |
| Plain DSH Agent in the app | DS-Bot records a separate non-Bot Agent | `state.agents[]`; its Sessions are ordinary DSH root Sessions and never receive team tools | This is one plain DSH conversation surface beside the Bot roster, not an invisible runtime for Bots ([agents.js:1-20][db-agents]). |
| App data root | DS-Bot desktop app | App-owned `DSH_HOME`/data directory and `ds-bot` profile | The app starts DSH in its own data home and only imports from the user's DSH read-only ([main.mjs:565-590][db-app-main], [import.mjs:1-5][db-app-import]). |
| Experimental Agent Teams | DSH, optional and unused | Lead root Session log | A different root-Team model; using it would duplicate DS-Bot's roster, rooms, and task ownership ([Agent Teams API][dsh-agent-team-api]). |

## Capability and reuse map

Legend: **A = reuse directly**, **B = reuse behind a DS-Bot adapter**, **C = keep product-owned**, **D = do not adopt for this architecture**.

| Capability | Current implementation / data structure | Public API vs internal detail | Existing evidence | Reuse verdict |
|---|---|---|---|---|
| Plugin loading and dependency composition | `plugin.js` exports namespace `name`/`inject`, then dynamically imports host code; `cordis.patch.yml` mounts the host and client manifest | Documented Cordis/DSH plugin shape. `inject` means required service and controls activation/restart ([Cordis primer][dsh-cordis-primer], [service tutorial][dsh-cordis-services]). | [plugin-entry.test.js:17-32][db-test-plugin-entry] verifies the thin entry and required services. | **A/B**: keep as a normal DSH plugin bundle. Never import or patch DSH internals. |
| Bot roster and lifecycle | DS-Bot `state.bots`; creation makes a DSH Session first, then saves the Bot, then applies scoped tools ([roster.js:60-99][db-roster-session], [roster.js:183-274][db-roster-bot]) | Product model over documented `sessionController.create`, `workspaceRegistry`, and Agent/tool APIs | Roster/delete/main-role and rollback tests include [roster.test.js:420-518][db-test-roster-main], [roster.test.js:828-936][db-test-roster-failure]. | **C** for product identity/lifecycle; **B** for Session creation and cleanup. |
| Main Bot and group-admin authorization | `rt.isMain(id)` and `room.admin`; tool handlers enforce `create_bot`, `stop_bot`, `create_group`, `post_to_group`, etc. ([tools.js:368-485,555-625][db-tools-authority]) | DS-Bot product policy; DSH has no equivalent Main Bot/group-admin role | Role contract: [roles-and-permissions.md:10-46][db-roles-doc]. Concurrency/race tests: [room-races.test.js:89-171][db-test-room-races]. | **C**: keep DS-Bot-owned. Do not map onto Agent Teams. Consider a single policy module later because checks are currently spread across tool and roster handlers. |
| Session creation | `ctx.sessionController.create({workspaceId|cwd, agentPreset})`, then `resolveAgent` and title rename ([roster.js:60-99][db-roster-session]) | Public DSH Session-controller and Session services ([controller source][dsh-session-controller], [SessionStore API][dsh-session-store]) | Covered indirectly across roster, group, and scoped-tool tests. | **A/B**: continue using documented entry points. |
| Session continuation | Bot delivery resolves the Agent, calls `agent.steer`, `agent.send(message, 'next-turn', false)`, or `agent.followup`, then `ctx.sessions.flush` ([delivery.js:124-230][db-delivery]) | Public `Agent` API: `followup` next turn, `steer` next step, `send` with inbox target/wakeup ([runtime-types.ts:233-270][dsh-agent-runtime]) | Queue/steer tests: [queue-next-turn.test.js:59-98][db-test-queue], [bot-messages.test.js:144-221][db-test-bot-messages]. | **A/B**: direct reuse. DS-Bot only chooses routing/coalescing policy. |
| Compaction and conversation parts | Steward decides `compact` or `switch`; DS-Bot condenses through DSH compaction or starts a fresh Session part ([context-and-memory.md:20-45][db-context-doc], [parts.js:1249-1288][db-parts], [parts.js:1425-1459][db-parts-check]) | The `ctx.compaction` seam is documented, but DS-Bot also monkey-patches provider methods/`summarize` and wraps `sessionController.prompt` | [model-switch-compaction.test.js:86-147][db-test-compaction] | **B with risk**: keep for now, but treat the monkey patches as the highest DSH-upgrade risk. They are not documented extension points. |
| Interruption and cancellation | `agent.cancel({kind,...})` for Stop; DS-Bot joins subagent interruption with Agent cancellation ([turns.js:298-390][db-turn-stop]) | Public `Agent.cancel`; default clears inbox, `keepInbox` preserves it ([Agent limits][dsh-agent-limits]). `sessionController.cancel` instead preserves pending inbox ([controller source][dsh-session-controller-cancel]). | [bot-messages.test.js:320-353][db-test-bot-messages]. | **B**: choose cancellation semantics deliberately. DS-Bot's “stop the work” behavior uses `Agent.cancel`; do not swap in the remote controller without preserving the contract. |
| Restart, cold resume, and replay | `inflight.json` notes running turns/queued deliveries; on start DS-Bot opens Sessions, reads durable events, reconciles turns already ended, and re-delivers only what was not consumed ([resume.js:260-340][db-resume-live], [resume.js:385-452][db-resume-reconcile], [resume.js:510-605][db-resume-all]) | Public Session events + `resolveAgent`; DSH's log is the source of truth | [resume-redelivery.test.js:107-202][db-test-resume]. | **B**: keep DS-Bot's product reconciliation. Never infer success only from an in-memory Agent or an HTTP acknowledgement. |
| Group @mention dispatch | `mentionSpans` selects members; `callIn` creates slots/batches; `runRound` starts every startable slot and awaits all turns ([groups.js:849-890][db-group-schedule], [groups.js:1042-1078][db-group-run]) | DS-Bot product scheduler over each member's separate DSH Session | Concurrent vs ordered behavior: [rounds.test.js:963-1034][db-test-rounds]. | **C**: keep DS-Bot-owned. DSH has no room/mention/group-admin equivalent. |
| Bot-to-Bot messaging and handoffs | `message_bot` opens/closes work, supports `request_id` idempotency, and delivers through the target Agent inbox ([tools.js:239-364][db-tools-message], [handoffs.js:108-142][db-handoffs-open], [handoffs.js:239-305][db-handoffs-query]) | DS-Bot tree/policy over documented DSH Agent inbox delivery and Session flush | Long results/restart/subagent handoffs: [handoff-results.test.js:183-233][db-test-handoffs], [handoff-results.test.js:400-565][db-test-handoffs-subagent]; tree/wait behavior: [bot-messages.test.js:586-902][db-test-bot-handoff]. | **C/B**: product work tree stays DS-Bot; transport uses DSH. Do not replace with Agent Teams' task DAG. |
| Turn scheduling and concurrency | One Agent loop per Session; a Bot's own chat and each group membership use separate Sessions. DS-Bot tracks durable `turn/start`/`turn/end` separately from live `agent/status` ([turns.js:775-1060][db-turns], [turns.js:1061-1270][db-turn-end]) | Public live Agent API + durable Session events; `agent/status` is only `idle|running` and can span queued turns ([runtime-types.ts:190-220][dsh-agent-runtime]) | [rounds.test.js:160-238][db-test-round-order], [rounds.test.js:963-1034][db-test-rounds], [turns-reply.test.js][db-test-turns]. | **B**: use DSH capacity per Session; DS-Bot owns cross-Session/room scheduling. Never equate `agent.status === 'running'` with one specific open turn. |
| Permission presets | `ctx.permissionPresets.catalog/resolve/set`; Bot/group presets are reapplied to chat and group Sessions ([permissions.js:11-116][db-permissions]) | Documented DSH permission-preset service, but DS-Bot reads it opportunistically with `ctx.get` because it is not a hard injection | [permissions.test.js:45-154][db-test-permissions]. | **A/B**: direct DSH enforcement, DS-Bot selection policy. Preserve the current rule that Auto review is Session-only and not stored as a Bot/group preset. |
| Scoped team tools | Every team tool is registered in `agent.ctx.tools`, not globally; group relay Session gets only relay/inbox tools; non-team Sessions get none ([tools.js:909-1042][db-tools-scope]) | Documented Agent-scoped `tools.register`/`restrict`; `system-prompt/assemble` waterfall is documented | [scoped-tools-creation.test.js:208-227][db-test-scope]. | **A/B**: this is the correct isolation seam. Keep it and add upgrade tests around scoped names and prompt sections. |
| Subagent execution | DSH supports managed local/external child executions through `ctx.subagents` and `subagent/*` ([subagent docs][dsh-subagent]); DS-Bot hides model-facing delegation tools and instead routes work to Bots ([tools.js:20-39][db-tools-hidden]) | Public DSH service/events, but product behavior deliberately disabled | Subagent settlement/handoff handling: [handoff-results.test.js:400-565][db-test-handoffs-subagent]. | **D for current product flow**; if future helpers are needed, use `ctx.subagents` behind a documented DSH API, not a second Agent Runtime. First settle product ownership/stop/visibility semantics. |
| Agent Teams roster/task DAG | DSH experimental `ctx.agentTeams` creates Lead/teammate children and a flat task board ([Agent Teams API][dsh-agent-team-api]) | Public but explicitly experimental with no stability promise; service itself imports a subagent `/internal` path ([source][dsh-agent-team-source]) | Upstream tests exist ([team.spec.ts][dsh-agent-team-test], [persistence.spec.ts][dsh-agent-team-persistence-test]). | **D**: conflicts with DS-Bot's roster/rooms/admin/work-tree authority. |
| Workflow orchestration | DSH `workflow` fans out subagents, but is foreground-only and has no journaling/resume ([workflow limits][dsh-workflow-limits]); DS-Bot hides/disables it | Public DSH capability, not a durable organization/task authority | Product allowlist/mask: [tools.js:22-39][db-tools-hidden]; app base rows disabled: [cordis.patch.yml:103-128][db-app-engine-patch]. | **D** as a replacement for handoffs. Revisit only for bounded in-turn fan-out that can fail without losing product-level work. |

## Source-level findings

### 1. The runtime boundary is clean

DS-Bot's host plugin only imports and composes product modules; `apply(ctx, config)` builds one shared runtime object and installs modules. It does not fork or monkey-patch the DSH Agent loop ([index.js:59-96][db-index]). The host declares its required services as `llm`, `tools`, `systemPrompt`, `sessionController`, `sessions`, `sessionTitle`, `workspaceRegistry`, and `connection` ([entry.js:1-4][db-entry]).

DSH's public contract separates durable and live state:

- `session/event` is the replayable transcript/event path.
- `agent/*` is live queue/status/prompt coordination.
- `followup`, `steer`, and `send` target inbox boundaries; cancellation and idle are explicit Agent methods ([agent lifecycle][dsh-agent-lifecycle], [runtime types][dsh-agent-runtime]).

DS-Bot follows that split: it renders product state from `session/event` ([turns.js:775-1060][db-turns]) and uses `agent/status` only as a live signal ([delivery.js:294-301][db-delivery]). This is the reusable pattern for any future product feature.

### 2. Bot identity and organization identity are intentionally different

DS-Bot keeps two levels:

1. **Bot identity** survives Session changes. `bot.id` is the first own-chat Session id; current and past own-chat Sessions are tracked separately.
2. **DSH Session identity** is execution/history identity. A group membership gets its own hidden Session per Bot, and the room itself has a separate relay Session ([store.js:451-526][db-store-sessions]).

This prevents a group conversation from reading a Bot's private chat and avoids sharing one mutable context among concurrent rooms. It also means any new feature must resolve `Session -> Bot` through `chatOwners`/`groupOwners`/`pastOwners`, not by assuming all Sessions are Bots or that a Bot id equals its current part.

### 3. Organization authority is product code, not DSH identity

Main Bot and group-admin rules live in DS-Bot's roster/tool code. DSH Agents are execution identities; being an Agent does not grant team-management rights. This is correct: DSH's Agent Teams model grants only a Lead/teammate distinction and is not equivalent to DS-Bot's Main Bot, group admin, room membership, or product permissions ([Agent Teams identity][dsh-agent-team-api]).

Current authorization is nevertheless spread across:

- `tools.js` checks on `create_bot`, `update_bot`, `stop_bot`, `create_group`, `post_to_group`, [`tools.js:368-485,555-625`][db-tools-authority];
- `roster.js` checks in `planRoomChange` ([`roster.js:685-808`][db-roster-rooms]), `setMain`, and `deleteBot` ([`roster.js:895-986`][db-roster-main]);
- privacy and memory modules with additional actor-specific checks.

The rules agree today, but a future change should centralize “who may mutate what” rather than add another tool-local conditional.

### 4. Group parallelism is DS-Bot scheduling, not multiple Agent loops inside one Session

DS-Bot uses one DSH Session per Bot per room. A room round is a DS-Bot object:

- `callIn` creates member slots and batches;
- `startable` permits non-ordered calls to start concurrently, while ordered calls wait for earlier speakers;
- `runRound` starts every eligible slot, records their turns in a set, and waits for all of them;
- `memberTurn` runs the corresponding DSH Agent turn and posts progress/final text into the room ([groups.js:849-890][db-group-schedule], [groups.js:1042-1078][db-group-run]).

This gives “parallel work, ordered discussion” without inventing a second loop: DSH still runs each Agent turn. Cross-room and cross-Bot concurrency comes from separate Sessions/Agents; one room still has at most one active round.

### 5. Handoffs are durable product work, while DSH carries messages

The durable handoff node is a tree: `from`, `to`, optional `parent`, optional `room`, optional `child`, `open[]`, and `results[]`. Closing a work settles its result upward; long results spill to files; `request_id` prevents duplicate work; missing targets can be settled during recovery, but there is no automatic timeout ([handoffs.js:108-142][db-handoffs-open], [handoffs.js:239-305][db-handoffs-query], [bot-handoffs.md:74-133][db-handoffs-doc]).

DSH should carry the actual user-role message into the recipient Session. It should not own the product question “is this task complete for the organization?” Agent Teams' task DAG is not a substitute because its semantics, limits, and authority model differ.

### 6. Compaction is functionally strong but the integration seam is not clean

The documented compaction seam is `ctx.compaction.compactIfNeeded`, `compactNow`, and `compactRegion` ([DSH compaction API][dsh-compaction]). DS-Bot correctly uses public pre-step/request-error/system-prompt/event hooks for most of its context behavior.

However, it also:

- mutates the provider object's `compactIfNeeded`, `compactNow`, and `compactRegion` methods;
- consumes a `summarize` method that is not part of the abstract `CompactionEngine` contract;
- replaces the `ctx.sessionController.prompt` method in place ([parts.js:289-350][db-parts-monkey], [turns.js:1308-1346][db-turn-prompt]).

Those are implementation-level adaptations, not documented extension points. They are the highest-risk DSH upgrade surface and should be represented in a compatibility test matrix before any pinned-DSH upgrade.

## Public extension points vs internals

| Surface | Classification at DSH `0.2.2-rc.1` | DS-Bot use |
|---|---|---|
| Plugin `name`/`inject`/`apply`, bundle patch | Documented public plugin contract | Direct. Tests use the real namespace entry path. |
| `ctx.sessionController` create/resolveAgent/prompt/cancel/fork/events | Documented public service methods | Direct for create/resolve; method replacement of `prompt` is not a documented interception API. |
| `ctx.sessions` create/get/list/flush/fork and `ctx.sessionController.events/follow` | Documented public Session APIs | Direct for flush; the existing history reader still uses deprecated `sessionController.page` and should migrate to `events`. |
| Live `Agent` API: `followup`, `steer`, `send`, `cancel`, `whenIdle`, `session`, `inbox`, `ctx` | Documented public Agent contract | Direct. Respect cancellation semantics and inbox boundaries. |
| Durable `session/event` and `turn/start`/`turn/end`/`user/message`/`assistant/message` | Documented durable event contract | Direct. Preferred source for replay and product state. |
| `agent/pre-step`, `agent/request-error`, `system-prompt/assemble`, `llm/stream`, `tools/*` | Documented interception/observation points | Direct. Use `next()` correctly and own prompt/tool contributions as documented. |
| `ctx.tools.register/restrict/guard`, `agent.ctx.tools` | Documented scoped tool contract | Direct. Correct isolation mechanism. |
| `ctx.permissionPresets` | Documented optional service | Direct, but use `ctx.get` because it is optional. |
| `ctx.compaction` three abstract methods | Documented compaction seam | Direct calls are public; provider-method mutation and `summarize` are internals. |
| `ctx.subagents` and `subagent/*` | Documented public seam | DS-Bot observes settlement and can stop live children, but current model tools are deliberately masked. |
| `ctx.agentTeams` | Experimental public seam with no stability promise | Do not use in the current architecture. |
| DSH UI DOM/classes, command-menu removal | Not a stable runtime extension surface | DS-Bot's concessions log already records reliance and workarounds ([dsh-concessions.md:19-29][db-concessions]). |

## Tests and known limits

### DS-Bot integration coverage

- Entry/loading: [plugin-entry.test.js:17-52][db-test-plugin-entry].
- Scoped tools and non-team Session isolation: [scoped-tools-creation.test.js:208-263][db-test-scope].
- Main Bot creation/deletion and rollback: [roster.test.js:420-518,828-936][db-test-roster-main], [roster.test.js:828-936][db-test-roster-failure].
- Permission propagation/races: [permissions.test.js:45-154][db-test-permissions].
- Group ordering/parallel calls/mid-round input: [rounds.test.js:160-238,963-1034][db-test-rounds].
- Bot message routing, stop authority, handoff waiting: [bot-messages.test.js:144-353,586-902][db-test-bot-messages].
- Restart redelivery/reconciliation: [resume-redelivery.test.js:107-202][db-test-resume].
- Compaction provider takeover: [model-switch-compaction.test.js:86-147][db-test-compaction].

### DSH upstream coverage inspected

DSH already tests the primitives DS-Bot relies on:

- Agent loop queue, steering, cancellation, resume: `packages/core/agent-loop/tests/{inbox,cancel,resume}.spec.ts`.
- Session store membership, fork, projections, surface: `packages/core/session/tests/*.spec.ts`.
- Compaction locking, manual compaction, cancellation, persistence: `packages/compaction/compaction-basic/tests/*.spec.ts`.
- Experimental Team roster/task/message/persistence: `packages/experimental/agent-team/tests/{team,persistence}.spec.ts`.

DS-Bot must still keep integration tests because these upstream tests prove DSH primitives, not DS-Bot's Bot/room/handoff policy.

### Known limits / gaps

1. **No stable per-Bot compaction policy hook.** DS-Bot reaches into the compaction provider and wraps `sessionController.prompt`. This should be treated as compatibility debt.
2. **The history reader uses a deprecated DSH page API.** DS-Bot's `eventsBackwards` calls `ctx.sessionController.page` ([chat-index.js:53-68][db-history-reader]); pinned DSH marks `page` deprecated in favor of `events` ([controller source][dsh-session-controller-page]). This should be migrated before the next DSH upgrade.
3. **Global command/menu leakage remains.** DSH cannot remove all command entries per Session; `/compact`, permission/model/plan entries can bypass product settings. This is already recorded as concessions C2/C4 ([dsh-concessions.md:17-19][db-concessions]).
4. **No turn watchdog.** A stalled model stream can leave a turn running until a user or Main Bot stops it (concession C11, [dsh-concessions.md:26][db-concessions]).
5. **No Session tree beyond fork in DSH.** A real organization hierarchy must remain a DS-Bot product object; DSH's Session model is not a nested org tree ([Session limitations][dsh-session-limits]).
6. **Agent Teams is not an organizational upgrade path.** It is experimental, flat, Lead-only, one shared checkout, advisory write scopes, no automatic owner release, and no send retry guarantee ([limitations][dsh-agent-team-limits]).
7. **Workflow is not durable task recovery.** DSH workflow has no journaling or resume and is foreground/collection-owned ([workflow limits][dsh-workflow-limits]).
8. **Organization state is single-writer JSON.** DS-Bot writes the whole `state.json` under a host lock and makes another host read-only ([store.js:29-68][db-store-lock], [store.js:380-441][db-store-write]). This is simple and safe for the current app but is the scale/transaction boundary for future multi-process organization work.
9. **Role checks are not centralized.** The policy is coherent but scattered across tool handlers and roster mutators; adding another authority surface increases drift risk.
10. **Subagent product semantics remain intentionally disabled.** DSH can run managed children, but DS-Bot hides the delegation tools. Re-enabling them requires a product decision about visibility, stopping, ownership, and result routing, not a runtime rewrite.

## Reusable takeaway

Build every future team/org feature as a DS-Bot product object over DSH's documented primitives:

- **identity/history** → DSH `Session` and `session/event`;
- **work execution** → one DSH `Agent` per Session, `followup`/`steer`/`send`/`cancel`;
- **live coordination** → documented `agent/*`, `subagent/*`, and tool/prompt events;
- **roster, Main Bot, groups, admin rights, mentions, handoff trees, and completion policy** → DS-Bot state and code;
- **recovery** → durable event/log reconciliation plus DS-Bot's inflight/work records;
- **no second Agent Runtime and no Agent Teams overlay**;
- **upgrade gate** → explicitly test compaction provider wrapping, `sessionController.prompt` replacement, scoped tool visibility, turn-event mapping, cancellation, and restart reconciliation.

## Source references

The links below are pinned to the audited revisions. DS-Bot uses the current repository URL under `rml4791lol-lang/DS-Bot`; DSH uses the official `deepseek-ai/deepseek-harness` tag source.

[db-index]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/index.js#L59-L96
[db-entry]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/entry.js#L1-L4
[db-app-package]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/app/package.json#L25-L65
[db-harness-package]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/dev/harness/package.json#L1-L10
[db-app-main]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/app/src/main.mjs#L565-L590
[db-app-import]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/app/src/import.mjs#L1-L5
[db-app-engine-patch]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/app/engine/cordis.patch.yml#L103-L128
[db-store-lock]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/store.js#L29-L68
[db-store-sessions]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/store.js#L443-L526
[db-roster-session]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/roster.js#L60-L99
[db-roster-bot]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/roster.js#L183-L274
[db-roster-main]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/roster.js#L895-L986
[db-roster-rooms]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/roster.js#L623-L808
[db-permissions]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/permissions.js#L1-L116
[db-delivery]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/delivery.js#L124-L230
[db-turns]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/turns.js#L775-L1060
[db-turn-end]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/turns.js#L1061-L1270
[db-turn-stop]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/turns.js#L298-L390
[db-turn-prompt]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/turns.js#L1308-L1346
[db-groups-header]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/groups.js#L1-L18
[db-group-schedule]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/groups.js#L849-L890
[db-group-run]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/groups.js#L1042-L1078
[db-groups-rounds]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/groups.js#L1202-L1373
[db-parts]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/parts.js#L1249-L1288
[db-parts-check]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/parts.js#L1425-L1459
[db-parts-monkey]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/parts.js#L289-L350
[db-tools-hidden]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/tools.js#L20-L39
[db-tools-authority]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/tools.js#L368-L625
[db-tools-message]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/tools.js#L239-L364
[db-tools-scope]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/tools.js#L909-L1042
[db-handoffs-open]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/handoffs.js#L108-L142
[db-handoffs-query]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/handoffs.js#L239-L305
[db-resume-live]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/resume.js#L260-L340
[db-resume-reconcile]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/resume.js#L385-L452
[db-resume-all]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/resume.js#L510-L605
[db-store-write]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/store.js#L380-L441
[db-agents]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/agents.js#L1-L20
[db-history-reader]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/chat-index.js#L53-L68
[db-context-doc]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/docs/plans/2026-10-09-context-and-memory.md#L20-L45
[db-roles-doc]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/docs/plans/2026-10-07-roles-and-permissions.md#L10-L46
[db-handoffs-doc]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/docs/plans/2026-10-16-bot-handoffs.md#L74-L133
[db-concessions]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/docs/plans/2026-10-13-dsh-concessions.md#L17-L29
[db-test-plugin-entry]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/plugin-entry.test.js#L17-L52
[db-test-scope]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/scoped-tools-creation.test.js#L208-L263
[db-test-roster-main]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/roster.test.js#L420-L518
[db-test-roster-failure]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/roster.test.js#L828-L936
[db-test-permissions]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/permissions.test.js#L45-L154
[db-test-queue]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/queue-next-turn.test.js#L59-L98
[db-test-rounds]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/rounds.test.js#L963-L1034
[db-test-round-order]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/rounds.test.js#L160-L238
[db-test-room-races]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/room-races.test.js#L89-L171
[db-test-bot-messages]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/bot-messages.test.js#L144-L353
[db-test-bot-handoff]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/bot-messages.test.js#L586-L902
[db-test-handoffs]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/handoff-results.test.js#L183-L233
[db-test-handoffs-subagent]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/handoff-results.test.js#L400-L565
[db-test-resume]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/resume-redelivery.test.js#L107-L202
[db-test-compaction]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/model-switch-compaction.test.js#L86-L147
[db-test-turns]: https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/turns-reply.test.js#L1-L56

[dsh-agent-lifecycle]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/agent-lifecycle.md#L6-L92
[dsh-agent-runtime]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent/src/runtime-types.ts#L190-L270
[dsh-agent-limits]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent/README.md#L200-L208
[dsh-session-readme]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/session/README.md#L24-L110
[dsh-session-limits]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/session/README.md#L197-L208
[dsh-session-events]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/session/src/types.ts#L287-L370
[dsh-session-controller]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/session-controller/src/index.ts#L263-L305
[dsh-session-controller-cancel]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/session-controller/src/index.ts#L511-L519
[dsh-session-controller-page]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/session-controller/src/index.ts#L521-L541
[dsh-session-store]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/session.md#L1083-L1223
[dsh-cordis-primer]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/cordis-primer.md#L7-L45
[dsh-cordis-services]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/cordis-tutorial/03-services.md#L45-L96
[dsh-compaction]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/compaction.md#L139-L205
[dsh-subagent]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/subagent.md#L174-L314
[dsh-agent-team-api]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/agent-team.md#L123-L230
[dsh-agent-team-source]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/experimental/agent-team/src/index.ts#L1-L10
[dsh-agent-team-limits]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/experimental/agent-team/README.md#L194-L207
[dsh-agent-team-test]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/experimental/agent-team/tests/team.spec.ts#L219-L263
[dsh-agent-team-persistence-test]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/experimental/agent-team/tests/persistence.spec.ts#L164-L315
[dsh-workflow-limits]: https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/workflow/workflow/README.md#L119-L130
