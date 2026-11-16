# Issue #26 — Control-center UI and real data-source audit

- **Ticket:** [rml4791lol-lang/DS-Bot#26](https://github.com/rml4791lol-lang/DS-Bot/issues/26)
- **Status:** Research complete; implementation boundary defined
- **Repository baseline:** `26228dfa1e52d536eda78a60936e5c0664e29e9c` (`ds-bot` `0.3.6`)
- **Pinned runtime:** DSH `0.2.2-rc.1`, source inspected at `deepseek-ai/deepseek-harness@66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`
- **Product-design baseline reviewed:** `DS-Bot-ai-os` at the same DS-Bot commit, especially `ARCHITECTURE_DECISIONS.md` and `docs/design/personal-ai-os.md`
- **Scope:** Read-only source audit. No real `~/.dsh`, real `DSH_HOME`, credentials, cookies, tokens, or user data were read or modified.

## Request type

**Comprehensive research / implementation-reference audit.** The evidence is the checked-in DS-Bot client, host, tests, design documents, and the pinned DSH client contracts. No third-party tutorial or comparative dependency recommendation is needed.

### Primary source locations

- DS-Bot API/state projection: [channel.js at 26228dfa](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/channel.js)
- DS-Bot client shell/navigation: [client/index.js at 26228dfa](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/client/index.js)
- DS-Bot task/organization sources: [handoffs.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/handoffs.js), [goals.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/goals.js), [task-ledger.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/task-ledger.js)
- DS-Bot context/part execution: [steward.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/steward.js), [parts.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/parts.js)
- Pinned DSH Session status: [`ui-session/src/client/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-session/src/client/index.ts)
- Pinned DSH Chat/tool projections: [`chat-snapshot-builder.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts), [`tool.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-chat/src/client/conversation-nodes/tool.ts)
- Pinned DSH context projections: [`token-meter/src/projection.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/llm/token-meter/src/projection.ts)

## Direct answer

The four pages should be built, in this order, over **one stable read model and one existing visual shell**:

1. **Foundation:** a typed control-center envelope and provenance contract.
2. **Chat:** keep DSH's real conversation as the renderer; add task/evidence/context inspectors beside it.
3. **Tasks:** project group goals, handoff work, the task ledger, board archive, resume records, and Session events into `TaskView` / `EvidenceView`.
4. **Dashboard:** aggregate the same `TaskView`s plus live Bot/work/approval state; do not create dashboard-only status truth.
5. **Organization:** join the existing roster, rooms, sections, permissions, handoffs, and task load; do not create a second org model.

Do not add Memory Hub, Activities, Skills, Tools, Models, or execution-node pages to this control center until all four core pages meet the same live-data, state, recovery, responsive, and accessibility gates.

The single most important constraint is: **mock/demo data must be a server-declared, non-writable data mode with persistent visible labeling, and production data loading must fail visibly rather than fall back to fixtures.** Data from different modes must never contribute to one count, task status, completion rate, or evidence verdict.

## 1. What exists today

### 1.1 The UI is one shell with state-driven navigation, not a URL router

The client starts with a single `ui` snapshot containing details, settings, overlays, panels, visits, and other transient route-like state (`ds-bot/src/client/index.js:84`). Actions open a Bot or group by navigating a DSH Session (`ds-bot/src/client/index.js:510-529`), open Settings by setting `ui.settings` (`ds-bot/src/client/team-actions.js:23-24,62-68`), and open the right panel with `ui.details` / `ui.view` (`ds-bot/src/client/team-actions.js:37-59`). Bot mode lands on the first Main Bot when the main view is not a team conversation (`ds-bot/src/client/index.js:489-508`).

Consequences:

- There is no existing `/dashboard`, `/tasks`, or `/organization` route to extend.
- A control-center page must not be represented as a fake DSH Session or a second document router.
- The least invasive route is one new page state inside the existing `ui` source, rendered through the existing shell, with hash/deep-link synchronization if reload and browser Back are required.
- Keep Team Sidebar as the one navigation rail. Add the four control-center destinations to that navigation rather than importing or nesting a second sidebar.
- `Chat` should delegate to the existing DSH main conversation route via `actions.openSession`, not clone the transcript renderer.

The product-design branch reaches the same architectural decision: extend the existing React shell and pass responsive visual checks; do not introduce a second navigation, theme, or permission tree (`DS-Bot-ai-os/ARCHITECTURE_DECISIONS.md:127-136`, `DS-Bot-ai-os/docs/design/personal-ai-os.md:432-441`).

### 1.2 The live snapshot is useful, but intentionally split

`state` returns durable team state plus DSH catalog/config fields; live-only fields are merged separately (`ds-bot/src/host/channel.js:77-168`). The live payload currently contains:

- `activity`: latest activity word per Bot;
- `work`: Bot work, group work, approvals, waiting handoffs, turn starts, and steering times;
- memory news/reviews, learning proposals, connector status, capability status, phone/IM/computer live state.

The client polls every 1.5 seconds while visible and 10 seconds while hidden (`ds-bot/src/client/index.js:242-269`). The host caches the serialized live payload and returns only a `liveKey` when it has not changed (`ds-bot/src/host/channel.js:169-181`); the client preserves each live slice only when its JSON changed (`ds-bot/src/client/index.js:188-218`). This is a good base for Dashboard and Organization, but it is a **current-state snapshot, not history**.

### 1.3 DSH already supplies the execution contracts

Pinned DSH exposes three independent Session facts: `running`, `pendingInteraction`, and `completionUnread` (`deepseek-ai/deepseek-harness@66491b05:packages/client/ui-session/src/client/index.ts:59-70`). DS Bot already consumes these through `useSessionStatus` and `useSessionRetainInfo` in the sidebar and member-status UI.

DSH's Chat snapshot provides turn-scoped data sources, including `assistant-step`, `tool-call`, `context`, `turn-error`, and `turn-process` (`deepseek-ai/deepseek-harness@66491b05:packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts:154-160`). Tool data is recursively structured and contains call time, arguments, result content, error, and nested subcalls (`deepseek-ai/deepseek-harness@66491b05:packages/client/ui-chat/src/client/conversation-nodes/tool.ts:12-24,41-55,100-117`). Context injections carry content, source, producer, and form (`deepseek-ai/deepseek-harness@66491b05:packages/client/ui-chat/src/client/conversation-nodes/message.ts:33-65`). This is the authoritative execution timeline substrate; DS Bot should not invent a second one.

### 1.4 "Team Board" is not a control-center data API

The current Team Board is a right-side overlay that answers "who is doing what right now" from `roster` and `work` (`ds-bot/src/client/team-board.js:1-4,145-187`; mounted at `ds-bot/src/client/index.js:1130`). It computes:

- running = a `work.bots[bot.id]` entry;
- waiting = a question or approval;
- idle = the remainder.

It has no server endpoint of its own and no durable history. Its history block reads `window.dsbot.panelHistory` (`ds-bot/src/client/team-board.js:208-228`), which is absent in DSH Web; the repository contract explicitly says that bridge is obsolete and the block therefore disappears (`ds-bot/notes/team-board-contract.md:42-48`). The code test also confirms the board uses the overlay list rather than DSH's single right-column seat (`ds-bot/test/client-bundle.test.js:43-50`).

Separately, the host has a Team Board feed for Bot-authored `delivery` / `decision` / `blocked` lines (`ds-bot/src/host/team-board-feed.js:10-18,122-159`; endpoint at `ds-bot/src/host/channel.js:896-912`). The running client does **not** consume that feed; the operations doc records the same fact (`docs/design/bot-operations.md:33`). Therefore:

- Do not treat the visible Team Board as "recent completed work" or a historical activity feed.
- Do not treat Bot-authored board lines as machine-verified evidence; they are self-reports.
- The feed is still useful as a labeled evidence/claim source after a client consumer and provenance are added.

## 2. Page-by-page audit

### 2.1 Dashboard

**Purpose:** An evidence-backed overview of what is running, blocked, awaiting approval, recently completed, unhealthy, or degraded.

**Information hierarchy**

1. Persistent mode/health strip: live vs mock/demo, read-only host, stale/partial sources, last refresh.
2. Needs attention: approvals, questions, blocked turns, failed handoffs, read-only conflicts.
3. Live work: running Bots and groups, current tool/target, elapsed time.
4. Completion and throughput: task ledger summary and recent completions, with denominators and source provenance.
5. System/capability state: model/provider readiness, diagnostics/update health, scheduler health.
6. Drill-down links into the exact Task, Bot, Session, or evidence record.

**Reusable components**

- `TeamBoardHost` / `TeamBoard` for the Bot-status grid (`ds-bot/src/client/team-board-host.js:25-42`, `ds-bot/src/client/team-board.js:130-276`).
- `BotAvatar`, `botState`, `workPhrase`, `Elapsed`, `Shimmer` for consistent status language and avatar states (`ds-bot/src/client/mark.js:11-18`; `ds-bot/src/client/cells.js:855-939`).
- `MemberDock`, `MemberState`, `MemberApprovals` for approvals and group members (`ds-bot/src/client/member-status.js:19-60,132-189`).
- `RunStats` for per-Bot turns/speed/cache/context (`ds-bot/src/client/details-drawer.js:52-72`).
- `UsagePage` and `usage-data.js` for charts, ranges, ranking, and periodic aggregation (`ds-bot/src/client/usage-page.js:1-14,430-591`).
- `SettingsPage` primitives (`SetSection`, `SetRow`), `PageBoundary`, `bt-empty`, `bt-error`, and the shared motion primitives, after extracting/reusing them rather than copying styles.

**Real data available today**

- Bots, Main Bots, rooms, sections, questions, views, agents, models, permissions, prefs, read-only reason (`ds-bot/src/host/channel.js:77-144`).
- Current Bot/group work, approvals, handoff waits, turn starts, steering times, activity (`ds-bot/src/host/channel.js:145-168`).
- Running/unread/pending-interaction facts from DSH (`deepseek-ai/deepseek-harness@66491b05:packages/client/ui-session/src/client/index.ts:59-70`).
- Per-Bot current-part Session projections through `run-stats` (`ds-bot/src/host/channel.js:325-335`).
- Usage totals, rankings, and scan completeness (`ds-bot/src/host/channel.js:336-338`, `ds-bot/src/host/usage.js:488-520`).
- Current approvals with tool, reason, optional command/path/URL detail, and answerability (`ds-bot/src/host/approvals.js:12-45,98-106`).
- Task ledger can be read and summarized host-side, but only a development CLI exposes it today (`ds-bot/src/host/task-ledger.js:60-133`; `ds-bot/dev/tasks.mjs:1-63`).

**Missing data / models**

- No historical activity feed: `activity` is process-local and explicitly never saved (`ds-bot/src/host/turns.js:401-417,523-548`).
- No endpoint for recent completions, task-ledger summaries, handoff history, or approval history.
- No normalized global severity/health model. Diagnostics, provider readiness, read-only state, update state, and task blockers are separate facts.
- No execution-node inventory; this is a local modular monolith, so a "nodes" card must be omitted or explicitly unavailable, not mocked.
- No reliable “completed” count from Bot claims. The task ledger distinguishes `answered` from `abandoned`, while the board archive stores self-reported deliveries (`ds-bot/dev/tasks.mjs:27-36`; `docs/plans/2026-11-15-task-completion.md`).

**Required loading / empty / error / recovery states**

- **Loading:** skeleton cards preserving final card geometry; no zero-valued counters before first load.
- **Empty:** distinguish "no Bots exist" from "Bots exist but nothing is running" and "task history is unavailable".
- **Partial:** per-source status (`roster ok`, `approval feed stale`, `task ledger unreadable`); show usable data and the missing scope.
- **Error:** global alert only when the Bot API is unreachable; otherwise inline errors by card with Retry.
- **Read-only:** persistent banner because another host owns writes; reads continue.
- **Recovery:** Retry/refetch, retain last successful timestamp, and never replace a failed live source with demo numbers.

### 2.2 Chat

**Purpose:** The real Main Bot conversation with execution timeline, task context, approvals/questions, files, evidence, and recovery in place.

**Information hierarchy**

1. Conversation identity and live state.
2. Transcript turn: user trigger → process steps/tools → assistant answer/error.
3. In-place interaction cards: questions, secrets, approvals, browser/computer handoffs.
4. Right inspector: task, context, evidence, artifacts, model/context budget.
5. Composer and queued/steering state.

**Reusable components**

- DSH conversation shell and DS Bot overrides for `assistant-step`, `turn-trigger`, `tool-call`, `turn-process`, `turn-error`, and turn tails (`ds-bot/src/client/index.js:1138-1162`).
- `AssistantCell` for text/reasoning/relay projection (`ds-bot/src/client/cells.js:261-319`).
- `ToolCell`, `callTree`, and card-specific tool renderers (`ds-bot/src/client/cells.js:1115-1135,1247-1270`).
- `TurnProcessCell`, `TurnTailCell`, `activity-row`, `workPhrase`, `Elapsed` for turn boundaries and live progress.
- `QuestionCard`, `WidgetDock`, `SecretDock`, `ConnectorDock`, `HandoffDock`, `ComputerHandoffDock`, `AppAccessDock`, and `MemberDock` for interaction states (`ds-bot/src/client/index.js:1174-1193`).
- `FailureCell` for code-based recovery actions (`ds-bot/src/client/turn-error.js:27-69,206-241`).
- `DetailsDrawer`, `RunStats`, `MemoryRow`, `ScheduleSummary`, and the current Bot/group overview (`ds-bot/src/client/details-drawer.js:263-385`).

**Real data available today**

- DSH turn timeline and turn-scoped node sources (`deepseek-ai/deepseek-harness@66491b05:packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts:154-160`).
- Exact tool call/result/subcall structure from the pinned DSH source (`deepseek-ai/deepseek-harness@66491b05:packages/client/ui-chat/src/client/conversation-nodes/tool.ts:100-117,131-143`).
- `chat` and `earlier` host endpoints for renderer-independent history pages (`ds-bot/src/host/channel.js:319-324`; `ds-bot/src/host/parts.js:1700-1714,1820-1826`).
- `chat(..., steps: true)` returns per-turn call names, labels, and success/failure booleans, but flattens call structure and omits arguments/results (`ds-bot/src/host/parts.js:1741-1782`).
- `run-stats` for whole-log turns, step, speed, cache, and context occupancy (`ds-bot/src/host/channel.js:325-335`).
- Current approvals/questions/views/handoffs from the state/live snapshot.
- Failure recovery through `resume`, model/key/sign-in actions, and the host's turn error facts.

**Missing data / models**

- No context inspector. DSH already has `contextPressure`, `contextBreakdown`, and Session context nodes, but DS Bot hides context nodes (`ds-bot/src/client/index.js:1159-1161`) and exposes only the compact run-stats line.
- No task/evidence inspector attached to a turn. Tool calls can be rendered, but there is no durable mapping from `taskId` or `evidenceId` to a call, result, artifact, or acceptance criterion.
- No steward audit history. See §3.
- No unified approval history. Only pending in-memory approvals are exposed.
- `chat` with `steps: true` is not a full execution-timeline read model. A deep inspector must read bounded Session events or use DSH node data while mounted.

**Required states**

- **Loading:** conversation skeleton until the DSH binding and Session snapshot exist.
- **Empty:** valid empty conversation with composer, not a blank lost surface.
- **Partial:** if the task/evidence inspector has no source, show "No linked task/evidence" rather than inventing a relationship.
- **Error:** keep the transcript; show host/API error inline. Turn failures use the existing code-based `FailureCell`.
- **Approval/question:** show one authoritative card, including stale/no-longer-open recovery.
- **Interrupted/recovery:** distinguish DSH interruption, retryable model failure, credential/configuration failure, and part-switch recovery.
- **Read-only:** keep Chat readable; disable mutations with an explanation.

### 2.3 Tasks

**Purpose:** Make product work inspectable as a tree, board, and timeline, with owners, dependencies, blockers, approvals, evidence, retries, and recovery.

**Information hierarchy**

1. Scope/filter bar: active, waiting approval, blocked, completed, failed, abandoned; Bot/group; time range.
2. Task tree/board: goal → stage → assignment → handoff/subtask.
3. Task detail: objective, acceptance, owner(s), status, attempt, next action, blocker.
4. Execution timeline: DSH turns/steps/tool calls, approvals, retries, part switches, failures.
5. Evidence: execution evidence vs acceptance evidence; source provenance and verification.
6. Recovery actions: resume/retry, approve/reject, abandon one branch, pause/resume, stop turn, open Chat.

**Reusable components**

- Group goal island and `goalView` for stage/task/evidence projection (`ds-bot/src/client/goal.js:23-82`; UI at `ds-bot/src/client/goal.js:180-220`).
- `GroupOverview`, `MemberRow`, `MemberState`, `MemberApprovals`, `StopMemberWork`, `StopRoomWork` (`ds-bot/src/client/details-drawer.js:158-230`; `ds-bot/src/client/member-status.js:155-189`).
- `HandoffDock` for browser handoffs and `MemberDock` for delegated work state.
- `TeamBoard` rows for status language, but not as the task read model.
- `FailureCell` patterns for blocked/retry states.
- Existing `abandon-work`, `resume`, `stop-member-work`, `stop-room-work`, `goal-control`, and `approval-answer` actions rather than new mutation paths (`ds-bot/src/client/team-actions.js:134-135,146-147,167,182-185`).

**Real data available today**

- **Group goal:** `room.goal` contains title, objective, acceptance, constraints, stages, per-member tasks, task status, reworks, feedback, and evidence. The valid stage/task states and pass/rework/complete behavior are in `ds-bot/src/host/goals.js:37,60-83,88-154,281-345`.
- **Handoff tree:** `state.works` contains `from`, `to`, `parent`, `open`, `results`, room/branch names, and timestamps (`ds-bot/src/host/handoffs.js:28-33,111-141`). `waitingView` exposes only the current waits, not the full tree (`ds-bot/src/host/handoffs.js:291-305`).
- **Task ledger:** append-only `open` / `close` events with ids, participants, parent, room, outcome, duration, and no message text (`ds-bot/src/host/task-ledger.js:1-9,40-57,103-133`).
- **Resume/inflight:** restart-safe handoff results and turn notes exist (`ds-bot/src/host/resume.js`; `docs/design/architecture.md`), but there is no UI projection.
- **DSH execution:** Session events, turn/step nodes, tool calls/results, approvals, and errors are available.
- **Claim/evidence surface:** Bot-authored board lines carry `what`, `number`, `evidence`, `needs`, `deadline`; they are self-reports, not verification (`ds-bot/src/host/team-board-feed.js:10-18,25-33`).

**Missing data / models**

- No `TaskView` read model or `/api/bot` task endpoint. The endpoint switch at `ds-bot/src/host/channel.js:246-839` has no tasks/control-center route.
- No stable ID mapping between a group-goal task and the handoff branch, Session turn, approval, board line, or evidence.
- Handoff `state.works` is durable but is not returned by `state`; only a summarized `waiting` map is returned.
- Task ledger is aggregate-only and intentionally has no text, call/result linkage, evidence body, or revision.
- Group goal task status accepts arbitrary strings through `taskGoal` (`ds-bot/src/host/goals.js:255-278`) even though the product design lists four statuses (`docs/plans/2026-11-01-group-goal.md`). A read model must validate/normalize without corrupting source data.
- No typed `EvidenceView`, no execution-vs-acceptance distinction, no verification result, no artifact hash/exit code/session seq linkage.
- No durable approval audit; see §3.
- No uniform retry/attempt model across group goals and handoffs.

**Required states**

- **Loading:** tree skeleton per source; do not collapse multiple loading sources into "no tasks".
- **Empty:** no goals/handoffs, with CTA to set a group goal or open Chat.
- **Partial:** group goals available but handoff history missing, or vice versa; label each source and its coverage.
- **Error:** per-source error plus unaffected tree data; Retry.
- **Stale:** task revision/source timestamp older than the live turn snapshot; show stale badge.
- **Approval stale:** "no longer open" with card refresh, not a silent failed click.
- **Handoff abandoned:** show missing result as an explicit result, including user/system reason and late-answer status.
- **Recovery:** resume/retry only when the underlying action supports it; otherwise show next action and open Chat.
- **Read-only:** inspect everything, disable mutations.

### 2.4 Organization

**Purpose:** Show who exists, who has authority, how Bots and rooms are related, current load, and recent handoffs.

**Information hierarchy**

1. Organization health and read-only/mode strip.
2. Main Bots / admins / permission presets.
3. Sections and teams, with rooms and members.
4. Per-Bot status, current task/load, model/engine, working folder, and wait state.
5. Relationship edges: room membership/admin, active and recent handoffs.
6. Drill-down into Bot details, group settings, Chat, or task.

**Reusable components**

- `TeamSidebar` and section/room/Bot rows (`ds-bot/src/client/sidebar.js:63-158,493-688`).
- `BotAvatar`, `BotMark`, `RoomAvatar`, `AgentBadge` for identity/state.
- `GroupOverview`, `MemberRow`, and `MemberPile` for membership/admin presentation (`ds-bot/src/client/details-drawer.js:158-230`).
- `GroupSettingsForm`, `BotSettingsForm`, `PermissionPicker` for read-only drill-down or existing mutations.
- `MemberDock` and `MemberState` for current work inside groups.
- Existing section actions (`section-save`, `section-order`, `section-delete`) and Main Bot/room actions (`ds-bot/src/client/team-actions.js:117-123,156-160`).

**Real data available today**

- Bots, current Session/parts, model, engine, working folder, permission, sections, hidden state, waiting/blocked facts, last activity/preview (`ds-bot/src/host/channel.js:83-94`).
- Rooms, current/earlier parts, members, admin, mode, work folder, permission, goal, todos, and last line (`ds-bot/src/host/channel.js:95-102`; group schema in the host/store and settings UI).
- Main Bot ids and section definitions (`ds-bot/src/host/channel.js:79-82,120-121`).
- Current member/group work and approvals.
- Current handoff waits; not full historical edges.
- DSH Agent identities and Session ownership (`ds-bot/src/host/channel.js:118-119`).

**Missing data / models**

- No organization read model joining each Bot to its groups, authority, permission preset, active task load, current handoff edges, and recent completion.
- No historical handoff graph; `waitingView` summarizes current waits only.
- No aggregate load metric with a defensible definition. “One running turn” is available, but “busy percentage” is not.
- No ownership/management tree beyond Main Bot, room admin, and section membership.
- Permission UI can show the selected preset, but there is no audit timeline of policy decisions or approvals.

**Required states**

- **Loading:** roster skeleton; do not show zero members.
- **Empty:** clear first-run Create Bot state.
- **Missing references:** deleted/hidden Bot or room references shown as unresolved, never silently dropped without a count.
- **Partial:** relationship graph can be unavailable while roster remains usable.
- **Read-only:** common banner; mutations disabled.
- **Recovery:** Retry/follow file refresh; preserve last good roster with timestamp.

## 3. Cross-cutting capability matrix

| Capability              | Current truth                                                              | UI today                                         | Verdict / needed action                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Task trees**          | Group-goal stage/task tree and handoff parent/child graph                  | Goal panel; handoff waits and work summaries     | **Partial.** Build one read-only `TaskView` projection; do not add a third store.                                                           |
| **Execution timelines** | DSH Session events and turn-scoped node data                               | Chat transcript, tool cards, activity row        | **Strong but not inspector-grade.** Add bounded timeline API or consume DSH node data for mounted Sessions; preserve event seq/time/callId. |
| **Bot status**          | DSH `running` + DS Bot activity/work/questions/approvals                   | Sidebar, avatars, Team Board, member docks       | **Good.** Reuse semantics; expose `statusReason` and source timestamps.                                                                     |
| **Handoffs**            | `state.works` parent/open/results plus task ledger                         | Waiting capsule/card; not a tree/history         | **Engine good, UI absent.** Add task-tree projection and result/late-reason detail.                                                         |
| **Approvals**           | In-memory pending map; DSH approval is policy engine                       | Approval cards for current work                  | **Current state only.** Add append-only governance/audit view; do not claim history exists.                                                 |
| **Activity feed**       | Latest process-local activity words; no durable history                    | Alternating live labels                          | **Missing.** Add append-only bounded event feed or omit the feed.                                                                           |
| **Context inspector**   | DSH pressure/breakdown/context nodes; DS Bot context thresholds            | One compact run-stats line; context nodes hidden | **Partial.** Add read model with model, window, projected tokens, breakdown, checkpoint count, thresholds, and source times.                |
| **Evidence**            | Group-goal free text; board free-text self-report; task ledger has no text | Goal evidence line; no global evidence view      | **Weak.** Add typed evidence with execution vs acceptance, provenance, verification, artifacts, hashes, Session seq.                        |
| **Context Steward**     | Dynamic thresholds and switch/compact decision exist                       | None                                             | **Backend only.** Expose thresholds and decision audit; `parseDecision` currently discards reason.                                          |

### 3.1 Context Steward specifics

The steward computes a model-derived check line, hard line, and reserve (`ds-bot/src/host/steward.js:25-33`), asks the model to choose `switch` or `compact` (`ds-bot/src/host/steward.js:35-47`), and runs only after the context crosses the check line at turn end (`ds-bot/src/host/parts.js:1425-1461`). Local-agent Sessions opt out because their CLI owns compaction (`ds-bot/src/host/parts.js:1429-1432`).

The current implementation discards the model's reason: `parseDecision` returns only the action (`ds-bot/src/host/steward.js:84-96`), and failures are warnings followed by a `switch` (`ds-bot/src/host/parts.js:686-698`). There is no persisted steward event, no exposed threshold/read model, and no UI trace.

Safe MVP inspector:

- model/provider and current route;
- `projectedTokens` / `pressureTokens` and `contextWindow` from DSH;
- system/tool/message breakdown from DSH;
- current check and hard thresholds;
- checkpoint count;
- last decision **only after it is captured**; until then show "Decision history unavailable".

Do not infer a steward decision from a part switch. A switch can also be manual, folder/model/engine-driven, hard-line, cutoff, overflow, or failure-driven (`ds-bot/src/host/parts.js:953-963`).

### 3.2 Approval audit specifics

DS Bot intercepts `approval/request` and keeps only pending entries in memory (`ds-bot/src/host/approvals.js:12-45`). The live view returns current pending approvals (`ds-bot/src/host/approvals.js:98-106`). Answering is race-safe against DSH's own card and returns a stale error when already settled (`ds-bot/src/host/approvals.js:46-96,101-106`).

A control-center approval view can safely reuse:

- fields: bot, room, tool, reason, optional command/path/URL detail, timestamp, answerability;
- actions: `approval-answer` / `actions.answerApproval`;
- recovery: stale/no-longer-open refresh.

It cannot show "past approvals" until a durable audit record is added. The target design already requires DSH as the only policy engine and an append-only product audit view (`DS-Bot-ai-os/ARCHITECTURE_DECISIONS.md:119-125`).

## 4. Real-data contract

### 4.1 Required envelope

Every new control-center endpoint should return the existing `{ ok, value }` transport shape, with `value` shaped as:

```ts
type DataMode = "live" | "mock" | "demo";

interface ControlEnvelope<T> {
  schemaVersion: 1;
  dataMode: DataMode;
  generatedAt: number;
  revision: string;
  coverage: {
    complete: boolean;
    sources: Array<{
      id:
        | "state"
        | "dsh-session"
        | "group-goal"
        | "handoff"
        | "task-ledger"
        | "board-archive"
        | "usage"
        | "diagnostics";
      status: "ok" | "missing" | "stale" | "error";
      observedAt?: number;
      message?: string;
    }>;
  };
  payload: T;
}
```

Rules:

- `dataMode` is mandatory and server-owned. The client never guesses it from URL, environment, or payload shape.
- Unknown `dataMode` or unknown `schemaVersion` fails closed with an explicit UI error.
- `coverage` describes missing/degraded sources; it does not turn missing data into zero.
- `revision` changes when any projected source changes. Include source-specific versions if a single revision is too coarse.
- No endpoint in `mock` or `demo` mode may write team state, Session state, approvals, memory, task ledgers, board archives, or usage.
- Raw prompts, secret values, cookies, tokens, `DSH_HOME` contents, and unredacted tool arguments do not enter the read model.

### 4.2 Required read models

| Model / endpoint    | Payload                                                                            | Authority / derivation                                                           | Needed by                      |
| ------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------ |
| `control-snapshot`  | Counts, health, approvals, active tasks, recent events, source coverage            | Derived from current state/live + TaskView + activity                            | Dashboard                      |
| `tasks-list`        | paginated/filterable `TaskView[]`                                                  | Read-only projection of group goals, handoffs, ledger, resume, Session refs      | Tasks, Dashboard, Organization |
| `task-detail`       | one `TaskView`, event timeline, evidence, approvals, artifacts                     | Join authoritative source IDs; no invented edges                                 | Tasks, Chat inspector          |
| `activities-list`   | append-only bounded `ActivityEvent[]` with cursor                                  | New durable host event sink or explicitly backed DSH/Session/ledger events       | Dashboard, Tasks, Chat         |
| `organization-view` | Bots, sections, rooms, authority, permission, load, current/recent handoff edges   | Derived from roster/rooms/work + tasks                                           | Organization                   |
| `context-view`      | route, pressure/breakdown, check/hard thresholds, checkpoint count, steward events | DSH projections + exported DS Bot context-steward state                          | Chat inspector                 |
| `approvals-history` | approved/rejected/cancelled/expired records with actor and task/session refs       | New append-only governance audit; pending data remains DSH-owned                 | Dashboard, Tasks, Organization |
| `evidence-detail`   | typed evidence, source, verification, artifact metadata                            | Existing goal evidence + tool/session/artifact records; no self-report promotion | Tasks, Chat                    |

The target design's `TaskView` and `EvidenceView` are a suitable starting contract (`DS-Bot-ai-os/docs/design/personal-ai-os.md:164-217`), but implementation must add source/provenance fields and must keep the existing stage semantics until migration tests pass (`DS-Bot-ai-os/ARCHITECTURE_DECISIONS.md:43-58`).

### 4.3 Activity event contract

Use a separate normalized event type rather than overloading the current activity word:

```ts
interface ActivityEvent {
  id: string;
  time: number;
  kind:
    | "task-status"
    | "turn-start"
    | "tool-call"
    | "tool-result"
    | "approval"
    | "handoff"
    | "context-checkpoint"
    | "error"
    | "recovery"
    | "evidence";
  actor: { kind: "user" | "bot" | "system"; id?: string; name?: string };
  taskId?: string;
  botId?: string;
  roomId?: string;
  sessionId?: string;
  turn?: number;
  step?: number;
  sourceEventId?: string;
  severity?: "info" | "warning" | "error";
  summary: string;
  evidenceIds?: string[];
}
```

Persist only the minimum needed for the feed, under the Bot home, append-only and bounded. Redact command arguments and private paths at write time. Do not reconstruct history by polling the current activity map.

### 4.4 Evidence contract

Do not use a single green check or a Bot sentence as completion.

- **Execution evidence:** DSH turn/end, tool call/result, command output, file change, browser screenshot, service check.
- **Acceptance evidence:** a check tied to a specific acceptance criterion, with verifier and result.
- **Claim evidence:** Team Board delivery/decision/blocked text. Always visually marked as self-reported.
- **Manual evidence:** user confirmation with actor and timestamp.

`TaskView.status === completed` should require every acceptance check to pass against typed evidence; a closed handoff only proves an answer returned, and a board `delivery` line only proves a Bot claimed delivery (`ds-bot/dev/tasks.mjs:27-36`; `DS-Bot-ai-os/docs/design/personal-ai-os.md:289-314`).

## 5. Component reuse map

| Need                      | Reuse                                                                                        | Decision                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Control-center navigation | Existing `TeamSidebar`, `ui` source, `actions.openSession`, existing overlay/panel mechanics | Extend; do not create second nav or fake Sessions.                                                             |
| Theme/colors              | `themes.js`, `--bt-*` tokens, `styles.js` focus/reduced-motion rules                         | Mandatory. Components must not hard-code colors.                                                               |
| Motion                    | `motion.js` springs, `useGlide`, `useLinger`, `useMorph`, `bt-veil-in`                       | Reuse. Loading uses skeleton; in-progress text uses shimmer.                                                   |
| Bot identity/status       | `BotAvatar`, `BotMark`, `botState`, `toolState`, `AgentBadge`                                | Reuse everywhere.                                                                                              |
| Current work rows         | `TeamBoard`, `MemberDock`, `workPhrase`, `Elapsed`                                           | Reuse visual language; replace TeamBoard's local waiting/status derivation with control snapshot where needed. |
| Current approvals         | `MemberApprovals`, `ApprovalCard`, `actions.answerApproval`                                  | Extract to shared approval component with stale/retry states.                                                  |
| Goal/task tree            | `goalView`, goal stepper/task rows/evidence line                                             | Extract presentational tree; feed it `TaskView`, not `room.goal` directly.                                     |
| Chat transcript           | DSH conversation slots and DS Bot cells                                                      | Keep authoritative; do not duplicate.                                                                          |
| Tool/execution timeline   | `ToolCell`, `callTree`, DSH tool nodes                                                       | Add full inspector; do not derive it from `chat(... steps:true)`.                                              |
| Turn failure/recovery     | `FailureCell` and `knownFailure` mapping                                                     | Reuse code-based recovery messages.                                                                            |
| Context budget            | `RunStats`, DSH `contextPressure` / `contextBreakdown`                                       | Expand into inspector.                                                                                         |
| Usage charts              | `UsagePage` / `usage-data.js`                                                                | Reuse chart/range primitives; avoid a dashboard-only chart language.                                           |
| Empty/error states        | `CellEmpty`, `.bt-empty`, `.bt-error`, `PageBoundary`, `ErrorToast`                          | Extract shared feedback primitives.                                                                            |
| Settings detail forms     | `BotSettingsForm`, `GroupSettingsForm`, `PermissionPicker`                                   | Drill-down only; no duplicate forms.                                                                           |
| Memory/schedules          | Existing `MemoryRow`, `ScheduleSummary`                                                      | Link to old surfaces; no secondary page in this milestone.                                                     |

### 5.1 Reuse caveats

- `TeamBoard` copy and aria labels are currently hard-coded Chinese (`ds-bot/src/client/team-board.js:17-34,234`), conflicting with the English-source/i18n rule in the UI standard (`docs/design/ui-standard.md:496-516`). Refactor through `t()` before treating it as a core reusable component.
- `TeamBoard` silently defaults config on fetch/JSON failure (`ds-bot/src/client/team-board.js:36-53`) and shows one undifferentiated empty state for no roster (`:246-248`). Control-center pages need explicit source status instead.
- `RunStats` silently keeps the previous/empty line on failure (`ds-bot/src/client/details-drawer.js:52-72`). Inspector-grade context data needs a source-specific error and timestamp.
- `PageBoundary`, `SetSection`, and `SetRow` are local to `settings.js`; extract them rather than copy. The current settings boundary shows a generic error with no Retry (`ds-bot/src/client/settings.js:287-297`), which is insufficient for network-backed pages.

## 6. Delivery order and completion gate

### Phase A — contract and navigation shell

- Add the typed control-center envelope, `DataMode`, source-coverage status, and runtime validation.
- Add one page state to the existing `ui` source with Dashboard / Chat / Tasks / Organization destinations.
- Reuse the current theme, typography, buttons, empty/error states, skeleton pattern, and motion primitives.
- Define URL/hash mapping so reload, Back/Forward, and deep links land deterministically without a second router.
- Provide shared `LoadingState`, `EmptyState`, `ErrorState`, `PartialDataBanner`, `ReadOnlyBanner`, `ModeBanner`, and `SourceBadge`.

**Exit gate:** source-mode tamper tests, keyboard navigation, focus restoration, reduced-motion, and desktop/narrow layout tests pass.

### Phase B — Chat

- Keep DSH's conversation as the real Chat page.
- Add a task/evidence inspector and context inspector to the existing right panel.
- Link a turn to task/evidence only through explicit source IDs; otherwise show "not linked".
- Reuse `FailureCell` recovery and existing approval/question/handoff cards.

**Exit gate:** a real Session can be read, failed, retried, approved, interrupted, and resumed without losing the transcript or duplicating an interaction card.

### Phase C — Tasks

- Implement read-only `TaskView` projection from group goals, handoffs, ledger, board archive, resume, and Session refs.
- Build the tree/board/timeline over the projection.
- Add evidence detail and approval links.
- Add mutations only through existing actions and carry the existing task revision/source status.

**Exit gate:** every task row identifies its source; no task is shown `completed` without acceptance evidence; group-goal and handoff states do not contradict source records; restart rebuild produces the same task ids/statuses.

### Phase D — Dashboard

- Aggregate the same TaskViews, live work, approvals, usage, health, and activity events.
- Do not calculate page-local completion or status rules.
- Add drill-down to Tasks/Chat/Organization.

**Exit gate:** every summary number is reproducible from a source query and carries completeness/denominator; no fabricated health node.

### Phase E — Organization

- Join roster, sections, rooms, authority, permission, active load, and handoff edges.
- Show unresolved/deleted references explicitly.
- Link to existing Bot/group settings and Chat.

**Exit gate:** organization totals reconcile to the roster; every relationship points to a real room/handoff/source record.

### Four-page acceptance gate before secondary pages

All four pages must pass:

- live data only, with visible mode/source provenance;
- loading, empty, partial, stale, error, read-only, and recovery states;
- one authoritative interaction for approval/question/handoff;
- keyboard and screen-reader operation;
- desktop and narrow screenshots checked against `docs/design/ui-standard.md`;
- no second navigation/theme/permission/task store;
- every task/activity/evidence row traceable to a source id;
- no mock/demo fallback in production;
- automated tests for contracts, stale data, source degradation, mode labeling, and destructive/retry recovery.

Only then add secondary Memory/Activities/Skills/Tools/Models/node pages.

## 7. Mock and demo data policy

### 7.1 Separate the meanings

Use these distinct modes:

- `live`: real host, real DSH Sessions, real persisted team state.
- `mock`: real host/runtime exercised with the scripted mock model in an isolated bench.
- `demo`: fixed product fixtures for visual/interaction demonstrations.

Do not use a generic `preview` as the only discriminator. The target draft currently uses `preview`, while the harness uses `mock` and `live` (`DS-Bot-ai-os/docs/design/personal-ai-os.md:379`; `DS-Bot-ai-os/docs/plans/2026-11-16-ai-os-reality-harness.md`). Resolve that terminology before implementation. If maintainers retain `preview`, it must map visibly to `demo` and never mean a successful mock model run.

### 7.2 Non-negotiable rules

1. Mode is returned by the host/API, not inferred by the browser.
2. Every control-center page shows a persistent banner for `mock`/`demo`; every affected card/row has a visible `Mock` or `Demo` badge.
3. Banner text is available to assistive technology and is not color-only.
4. Demo/mock data is excluded from live counts, exports, task completion, evidence verdicts, and activity history.
5. Demo/mock endpoints are read-only. They cannot call mutations or persist to `state.json`, Session logs, approvals, board archive, task ledger, memory, or usage.
6. A failed live request never falls back to fixtures. It renders an error/partial state and retains the last good live timestamp.
7. Demo code is excluded from production bundles, or production starts with a server-side hard deny.
8. Tests assert that an unknown/missing mode fails closed and that a demo row cannot pass into a live aggregate.

### 7.3 Safe bench use

The existing bench already isolates data under `.dsh-test-<name>` and forbids real DSH data access in its workflow (`ds-bot/dev/bench.sh:1-18`). Keep that boundary. A control-center demo may use the same isolated bench with `dataMode: mock`, but it must still be labeled because the model is scripted and the run is not real-model evidence.

## 8. Existing test coverage and required additions

### Existing coverage worth preserving

- `team-board-feed.test.js`: tolerant feed reading, per-Bot limit, archive dedupe.
- `goal-client.test.js`: all goal states, stage/evidence rendering, moved room ids, task states, controls.
- `group-status.test.js` / `group-work.test.js`: approval races, group work, stop/recovery.
- `handoff-abandon.test.js` / `handoff-results.test.js`: branch abandonment, late results, restart-safe results.
- `member-status.test.js`: member wait/work ordering, approval/stop states.
- `run-stats.test.js`: DSH statistics formatting.
- `right-panel.test.js`, `surface.test.js`, `sidebar-switch.test.js`: layout/navigation state.
- `styles.test.js`, `message-layout.test.js`, accessibility/color and responsive style checks.
- `turn-error.test.js`: failure codes, repair actions, stale failure records.
- `settings-shell.test.js`: page routing/fallback, header actions, page boundaries.
- `archived-parts.test.js`: Session history across parts.

### Missing coverage

- No direct UI-state test for Team Board loading, partial, error, stale, or recovery; existing tests cover its feed and placement, not these states.
- No control-center page/navigation contract.
- No `TaskView` projection or source-merge tests.
- No activity-event durability/order/redaction tests.
- No typed evidence/provenance/verification tests.
- No approval-history audit tests.
- No context-inspector/steward-decision tests or exposed threshold tests.
- No mock/demo mode enforcement or aggregate-separation tests.
- No cross-page deep-link/reload/focus-restoration tests.

### Required test files

- `control-center-contract.test.js`: schema, mandatory mode, source coverage, unknown schema/mode fail-closed.
- `control-center-task-view.test.js`: source merge, stable ids, contradiction handling, restart rebuild.
- `control-center-activity.test.js`: append-only order, cursor, redaction, bounded retention.
- `control-center-ui.test.js`: four-page navigation, loading/empty/error/partial/read-only states, drill-downs.
- `control-center-approval.test.js`: stale approval, race-safe answers, audit event.
- `control-center-evidence.test.js`: execution vs acceptance vs claim, completion gate.
- `control-center-context.test.js`: DSH pressure/breakdown, steward thresholds, no inferred decision history.
- `control-center-demo-mode.test.js`: visible badges, production deny, writes disabled, no aggregate contamination.
- Responsive/a11y snapshots for desktop and narrow widths using the existing style-test approach.

## 9. Prioritized gap list

### P0 — blocks correct four-page delivery

1. Typed control-center envelope and source coverage.
2. One read-only `TaskView` / `EvidenceView` projection.
3. Durable activity/event feed.
4. Context inspector read model and steward decision capture.
5. Append-only approval audit.
6. One top-level four-page navigation state within the existing shell.
7. Mock/demo provenance and write isolation tests.

### P1 — required for usable pages

8. Dashboard health/blocker aggregation over real sources.
9. Organization relationship/load projection.
10. Shared loading/empty/partial/error/read-only/recovery primitives.
11. Deep links and source-id drill-downs.
12. Responsive + accessibility visual verification.

### P2 — after the four-page gate

13. Secondary Memory/Activities/Skills/Tools/Models pages.
14. Execution-node inventory and health, only if a real multi-node requirement appears.
15. Long-range analytics/export beyond the task ledger and usage projections.

## 10. Stop conditions and ambiguity flags

- **No unified task truth exists yet.** A UI can be complete as a read-only projection, but it cannot honestly claim a single completion model until the projection and evidence rules are implemented.
- **No activity history exists today.** Do not ship a “Recent activity” card backed by the polling `activity` map.
- **No approval history exists today.** Current approval UI is valid; historical audit is a new durable record.
- **No steward decision history exists today.** Thresholds can be shown; decisions/reasons cannot be shown without new capture.
- **The Team Board feed and visible Team Board are different surfaces.** Reconcile before naming either one a Dashboard.
- **`preview`, `mock`, and `demo` are currently inconsistent terms.** Canonicalize before coding.
- **DSH is pinned.** Do not assume newer upstream client slots or projections are available. The capability map must be checked against `0.2.2-rc.1` before implementation.
- **No real user data should be used for visual acceptance.** Use the isolated mock bench for behavior and explicitly labeled demo fixtures for visual states.

## 11. Reusable takeaway

Build the control center as a **read-only projection layer over existing authorities**, inside the existing React shell:

- DSH owns execution sessions/events, turns, tool calls, approvals, and model/context projections.
- DS Bot owns Bot identity, rooms, goals, handoffs, task ledger, board claims, memory, and product actions.
- A new `TaskView` / `EvidenceView` joins those authorities with stable ids and source coverage.
- Dashboard and Organization aggregate the same projection; Chat renders DSH execution and links to the projection; Tasks is the projection's primary tree/timeline surface.
- Complete those four pages before any secondary page.
- Make data mode and source provenance first-class, visible, test-enforced, and non-writable for mock/demo.
