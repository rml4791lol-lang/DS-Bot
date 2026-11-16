# Issue #23: Task continuity, recovery, and evidence sources

- **Date:** 2026-11-16
- **Research type:** Comprehensive source and persistence audit
- **DS-Bot baseline:** `26228dfa1e52d536eda78a60936e5c0664e29e9c` (`0.3.6`)
- **DSH baseline:** `0.2.2-rc.1` at `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`
- **Scope:** read-only source audit and a proposed read-only projection. No DSH patch, product behavior change, live `DSH_HOME` inspection, or task-state migration was performed.
- **Planning input, not a source of record:** `DS-Bot-ai-os/ARCHITECTURE_DECISIONS.md:43-69` and `DS-Bot-ai-os/CODE_REUSE_MAP.md:19-24` are uncommitted drafts. Their accepted direction is useful: one task boundary over existing evidence surfaces, with DSH remaining the only agent runtime. They do not override the implementation below.

## Direct answer

A useful read-only `TaskView` can be built now, but a unified authoritative task store cannot be justified without duplicating state.

The v0 projection should:

1. enumerate the stable task-like records that already have owners:
   - DS-Bot group-goal tasks in `state.json`;
   - DS-Bot handoff work in `state.works` plus their result files;
   - DSH scheduled tasks in the Schedule domain;
2. preserve each source's own status verbatim and attach a source reference instead of inventing a universal mutable status;
3. attach evidence by exact IDs/session event references where available, and label the rest `inferred` or `self-report`;
4. report conflicts, missing evidence, stale links, and unknown outcomes instead of resolving them by precedence;
5. treat DSH same-session goals, `todo/write`, board lines, task-ledger rows, checkpoint notes, message books, artifacts, and usage as adjacent evidence, not as additional task owners by default.

The system can honestly say **reported** or **executed** today. It cannot honestly say **verified complete** from the existing stores alone. Existing completion is often an authorized model assertion, a returned message, a schedule receipt, or a self-reported board line. Those are different facts.

## Evidence hierarchy used in this note

| Level | Meaning | Examples |
|---|---|---|
| **Authority** | The current product state that other components must obey. | `room.goal`; `state.works`; DSH Schedule task row; DSH `goal/change` for a same-session goal |
| **Execution fact** | The runtime recorded what was actually attempted or observed. | Session `turn/*`, `step/*`, `tool/call`, `tool/result`, `assistant/*`; DSH schedule delivery receipt |
| **Immutable content** | Bytes or identity can be verified independently of prose. | DSH content-addressed attachment references |
| **Projection** | Rebuildable from an authority; convenient but not independently writable. | `todos`; DSH goal view; board feed; usage view; `TaskView` |
| **Self-report** | A model/user claim that may be useful but does not prove execution or completion. | Board lines; checkpoint notes; assistant prose; free-form goal evidence |
| **Measurement** | Counts, timing, or cost metadata without task lifecycle authority. | `tasks-YYYY-MM-DD.jsonl`; `usage.sqlite` |

## Source map and authority matrix

| Source | Current owner/authority | Storage and write path | Crash/restart character | Evidence value | Main conflict or missing invariant |
|---|---|---|---|---|---|
| DS-Bot group goal, stages, tasks | DS-Bot room state | `<home>/state.json`, nested `room.goal` / `room.pastGoals`, atomic whole-file replace | Last successful save wins; no journal | Objective, acceptance, stage and assignment intent; authorized reported status | Free-form evidence, heuristic task status, no evidence hash/evaluator, no stable link to handoffs |
| DSH same-session goal | DSH `goal/change` Session event | Append-only Session log; strict projection | Persisted with Session and resumed | Durable objective and phase, CAS revision | No stages/tasks, scheduling, evaluator, or currency budget |
| DSH todo list | `todo/write` Session event | Whole-list event in owner Session | Replay latest event; live projection clears at next turn start | Local model-authored checklist only | No IDs, no partial edits, no cross-agent sharing, no proof |
| DS-Bot group call batch | DS-Bot room state | `state.roomBatches` | Persisted; settled after interrupted turns | Who still owes whom for a group batch; result row references | Fire-and-forget saves; not a task ledger; no durable evidence text |
| DS-Bot handoff work | DS-Bot `state.works` | `state.json` plus `<home>/handoff-results/<id>.txt` | Restart-safe waits and long-result fallback | Delegation ancestry and system-generated close/abandon facts | Text answer is not acceptance; state/ledger/file writes are separate |
| DS-Bot task ledger | Derived measurement log | `<home>/ledger/tasks-YYYY-MM-DD.jsonl` | Append-only but not fsynced; write failure warns | Open/close timing, answered/abandoned counts | No text, no unique-row constraint, not a current-state authority |
| Team board / archive | Bot self-report | external Atlas state dir, `board/*.json` and `board/archive/*.jsonl` | Board atomic replace; archive append may be missed | A claim/status declaration and time | No task ID, no proof; archive dedupe ignores several fields |
| DS-Bot schedules | DSH Schedule service | DSH durable domain table; DS-Bot wrapper | Active due tasks redispatch; recovery reuses a queued receipt message | Due/queued/ended status and delivery receipt | Receipt proves inbox acceptance, not turn success; narrow uncommitted-delivery crash window |
| DSH jobs | DSH `jobs-local` | Process-local runtime plus `job/registered` / `job/settled` Session events | Live job dies; events survive; missing settlement means incomplete | Execution lifecycle fact | No resumable execution; final settlement can be missing during teardown |
| DSH workflow | PTC workflow engine | Live process; four log-only lifecycle events | No journal/resume | Run/member lifecycle facts | Intermediate values and logs are not durably resumable |
| DS-Bot inflight | Recovery hint | `<home>/inflight.json`, atomic whole-file replace | Replayed after restart and reconciled with Session log | Exact interrupted turn/delivery candidates | Note is not transactionally written with the delivery/Session event |
| DS-Bot part/checkpoint note | Derived conversation summary | `bot.segments`, `room.segments`, `room.parts`; handoff `user/message` | Rebuilt/copied into fresh Session | Continuity narrative and stated next step | Model-generated or fallback text; not completion evidence |
| DSH Session events | DSH | Append-only durable Session log | Torn tail discarded; open turn repaired as `interrupted` | Strongest execution chronology and tool result record | Tool result does not prove external effect; assistant text is self-report |
| Group and pair message books | DS-Bot message ledger | `<home>/ledger/*.jsonl` | Append-only; torn lines skipped | Authored message content, round summaries, delivery marks | No task relation; write failures/duplicate marks; group append is not awaited |
| Workspace artifacts | DSH attachment/deliverables | Attachment store; `deliverables/presented`; `workspace/changes` | Attachments durable; workspace summaries are process-local | Immutable attachment ID or observed turn changes | `present` stores path declaration, not bytes; workspace diff disappears on Session disposal/restart |
| Usage/cost | Derived DS-Bot ledger | `<home>/usage.sqlite`; in-memory fallback | Rebuilds logged calls; metered non-log calls can be lost | Token usage by owner/model/time | No task ID or monetary cost; rows are quarter-hour aggregates |
| DSH experimental Agent Team tasks | DSH experimental package | `team/task` events in Lead Session, append + flush | Durable replay and strict projection | Best in-tree example of task DAG, CAS, readiness, tombstones | Experimental; not in DS-Bot profile bundles; must not become a parallel authority by accident |

## Detailed source audit

### 1. DS-Bot group goals, stages, and group tasks

**Schema and write path.** The authoritative value is nested in `room.goal`: `{id, revision, status, title, brief?, objective, acceptance, constraints, stages, current, nudges, idle?, by, createdAt, updatedAt, events, counter, startedAt?, summary?, evidence?, reason?, endedAt?}`. Each stage has `{id, title, acceptance, status, tasks, reworks, feedback?, evidence?, passedAt?}`; each task has `{id, botId, task, status, note?}`. The constructor and stable ID counter are in `ds-bot/src/host/goals.js:60-155`. The state container is `<DSH_HOME>/bot/state.json`, selected at `ds-bot/index.js:71-79`.

**Authority.** `room.goal` is authoritative for the group's plan and source-declared status. Goal mutations are committed with `rt.save()` from the admin/Main Bot tool at `ds-bot/src/host/goals.js:714-799`; user controls also save at `ds-bot/src/host/goals.js:547-587`. State use is guarded by a single-writer lock; writes use a queued snapshot, temporary file, and atomic replace at `ds-bot/src/host/store.js:355-435`. There is no journal and no nested goal/work schema validation on load; `state.version === 1` is the only file-level gate (`ds-bot/src/host/store.js:72-107`).

**Lifecycle.** Goal phases are `drafting -> active <-> paused`, with `active -> complete | stopped` and `drafting | paused -> stopped`. A stage moves `pending -> active -> passed`. A task moves:

- `pending -> working` when the admin calls that member (`ds-bot/src/host/groups.js:1015-1040`);
- `working -> reported` when a member's final post answers that admin call (`ds-bot/src/host/groups.js:1157-1175`);
- `working -> pending` on failure or user stop (`ds-bot/src/host/groups.js:1173-1176`, `ds-bot/src/host/groups.js:1848-1856`, `ds-bot/src/host/groups.js:1900-1908`);
- `* -> pending` by rework (`ds-bot/src/host/goals.js:302-326`);
- all current-stage tasks to `done` when the admin passes the stage (`ds-bot/src/host/goals.js:281-300`).

`pass` requires only a non-empty evidence string and then marks every task `done`; `complete` requires non-empty evidence and summary after every stage has passed (`ds-bot/src/host/goals.js:281-348`). `taskGoal` accepts a status or note from the admin (`ds-bot/src/host/goals.js:255-279`); the tool schema restricts status values, but persisted values are not revalidated.

**Crash/restart behavior.** A tool mutation awaits `rt.save()`, so a resolved save is the persistence boundary. Automatic task transitions (`goalTaskWorking`, `goalTaskReported`, `goalTaskReset`) use `void rt.save().catch(...)` (`ds-bot/src/host/goals.js:664-667`). A crash before that queued write completes restarts from the last committed `state.json`. A disk/state error can therefore leave memory and disk divergent until the next successful save. Corrupt JSON is copied aside and the active team is loaded as empty before a migration save (`ds-bot/src/host/store.js:88-107`); there is recovery material, but no journal replay.

**Evidence value.** Strong for the intended objective, acceptance text, stage order, assignment, goal revision, and authorized status transitions. Weak for completion:

- `stage.evidence`, `goal.evidence`, and task notes are unconstrained prose;
- no digest, attachment, command result, or acceptance evaluator is bound to `pass` / `complete`;
- 300-character event copies are capped to the latest 50 events (`ds-bot/src/host/goals.js:25-27`, `ds-bot/src/host/goals.js:43-51`);
- archived goals are capped at five (`ds-bot/src/host/goals.js:27`, `ds-bot/src/host/goals.js:53-57`);
- task status can be manually asserted, inferred from a post, or overwritten by stage pass.

**Conflicts / duplicates / missing invariants.** Goal task IDs are stable only inside one goal revision chain and are not referenced by handoffs. `reported` means a reply arrived, not that its claim was checked. `done` means the admin passed the stage or asserted the task, not that a deterministic acceptance check ran. There is no persisted `blockedBy`, approval inheritance, evidence hash, or task-to-Session-event foreign key. Stage and goal state are one current snapshot; only five completed/stopped goals are retained beside it.

**Tests.** `ds-bot/test/group-goal.test.js:137-173` covers validation and stage progression; `:394-427` covers automatic `working -> reported` and failure reset; `:569-594` covers parallel batch reporting. The suite verifies serialized disk contents but has no goal restart/crash-recovery test.

### 2. DSH same-session goals

**Schema and write path.** DSH has a separate goal authority for one Session. `GoalSnapshot` contains `{id, revision, objective, phase, blockedReason?, maxGoalRounds}`; every non-clear mutation appends a complete `goal/change` event. Phases are `active | paused | blocked | complete` (`docs/subsystems/goal.md:7-69`, `:91-117`). DSH base mounts this capability at `packages/bundle/base/cordis.patch.yml:327-334`.

**Authority and lifecycle.** The append-only Session log owns the record; the `goal` Session projection is a strict, rebuildable view. CAS by goal revision rejects stale writes. A goal can be created, edited, paused, resumed, blocked, completed, or cleared. Completion/blocking is recorded by the caller; there is no independent evaluator (`packages/goal/goal/README.md:50-68`, `:150-161`). Continuation permission is process-local and is not part of the durable goal.

**Crash/restart behavior and evidence.** The goal persists through Session resume, fork, and process restart. It proves the objective and recorded phase, not that the objective was achieved. It has no stages, task ownership, evidence object, scheduling, or token/currency budget (`packages/goal/goal/README.md:12`, `:157-160`).

**Use in TaskView.** Treat it as an objective/context attached to an owner Session, not as a DS-Bot group stage or task. It must not be flattened into the group-goal state machine.

### 3. DSH todo lists

**Schema and write path.** `todo/write` carries the complete `{todos: [{content, status}]}` snapshot; status is `pending | in_progress | completed`. The model-facing `todo_write` appends one log event and the `todos` projection returns the latest whole list (`packages/todo/tool-todo/src/index.ts:120-135`, `:193-209`; `docs/subsystems/todo.md:9-33`). DSH base mounts the tool at `packages/bundle/base/cordis.patch.yml:437-445`.

**Authority and limits.** The Session log owns the list, but it is explicitly a model-authored checklist: no stable item ID, no priority, no partial edits, no read-back, and one owning Session only (`packages/todo/tool-todo/README.md:148-158`). Whole-list replacement means history is an audit trail, not a mergeable task graph. The live `todos` projection also clears at the next `turn/start`, while older `todo/write` events remain in the Session log.

**Crash/restart behavior.** Once flushed, replay deterministically selects the latest event. A crash before the Session durability barrier can lose the latest snapshot. The event proves the model wrote a checklist, not that any item ran or completed.

**Use in TaskView.** Attach the current list under its owner Session as a local checklist with `source: session/<id>@seq`; do not promote its entries into stable tasks unless a later design adds stable IDs and an explicit owner bridge.

### 4. DS-Bot group call batches

**Schema and write path.** `state.roomBatches[key]` is `{key, roomId, by, pending[botId], done[name], doneIds[botId], results[{name, seq}], worked, answered, at}` (`ds-bot/src/host/groups.js:554-615`). The store drops a batch unless `pending`, `done`, and `results` are arrays and `key` matches its map key (`ds-bot/src/host/store.js:194-200`). Mutations use both awaited and fire-and-forget `rt.save()` calls.

**Authority and lifecycle.** It is authoritative only for a group call's outstanding callees, not for whether their work succeeded. A batch is created when one Bot calls one or more members together. Members leave as their turns settle; a finished `worked && answered` batch is woken once; `worked` alone can be posted back. After interrupted turns are resumed, `settleRoomBatches` removes targets that can no longer work and maybe wakes the caller (`ds-bot/src/host/groups.js:640-704`).

**Evidence value and conflicts.** `done`/`results` are strong evidence that a group message was posted and where its ledger row is. `worked` means a non-team tool was observed (`ds-bot/src/host/groups.js:828-840`). It is not a goal-task record and does not carry task acceptance. Results are ledger sequence references, while goal tasks have no batch key, so joins are room/time/inference-based.

**Tests.** `ds-bot/test/group-goal.test.js:569-594` verifies a batch member is reported while its peer still works. Restart settlement is covered indirectly by the existing group-round tests but not by a dedicated cross-source TaskView fixture.

### 5. DS-Bot handoff works

**Schema and write path.** `state.works[id]` is an open work tree node with optional `from`, `to`, `room`, `parent`, `fromRoom`, `name`, `child`, plus `open[]`, `results[]`, `at`, and optional `late`/`held`. `openWork` creates the node and logs an open row (`ds-bot/src/host/handoffs.js:103-117`). A child close deletes the child node, appends a task-ledger close row, attaches `{id, name, text, length?, file?, at, ...}` to the parent's `results`, and keeps a full result in `<home>/handoff-results/<id>.txt` when it exceeds the inline cap (`ds-bot/src/host/handoffs.js:37-100`, `:119-141`).

**Authority and lifecycle.** `state.works` is authoritative for which delegation waits exist and their parent/child ancestry. A work is open when its target owes an answer; a result is held under the parent until a turn reads it (`ds-bot/src/host/handoffs.js:239-289`). A user or a deleted target may abandon a branch with a synthetic missing-answer result (`ds-bot/src/host/handoffs.js:335-381`). The result file is written before `state.json` names it; old files are deleted only after a replacement state save resolves (`ds-bot/src/host/handoffs.js:51-83`, `:130-140`).

**Crash/restart behavior.** Restart preserves open waits. It abandons only waits whose Bot or group no longer exists; it deliberately leaves a subagent wait alone when liveness is unknown (`ds-bot/src/host/handoffs.js:367-390`). If a long result file is missing, truncated, or was never written, `resultText` explicitly returns a cut/unknown result instead of fabricating a whole one (`ds-bot/src/host/handoffs.js:85-101`).

**Evidence value.** Strong for assignment ancestry, recipient, open/waiting state, and the fact that a reply was returned or abandoned. Weak for quality: the closing text is an assistant answer, not a verified deliverable. `closeWork`'s `outcome: answered` means a result came back, not that the task objective passed.

**Conflicts / missing invariants.** `openWork` calls state save and task-ledger append independently; either can survive without the other. Result files are not content-addressed. The close row has no task acceptance code, evidence digest, or model/tool result ID beyond the work ID. `abandonedWorks` retains only the newest 100 (`ds-bot/src/host/handoffs.js:307-329`).

**Tests.** `ds-bot/test/handoff-results.test.js:183-211` covers open/close rows and a long-result restart; `:282-315` covers missing/cut/unwritable result files; `:335-384` covers save/result retention ordering. `ds-bot/test/handoff-abandon.test.js:285-365` covers durable abandonment and deleted-target reconciliation.

### 6. DS-Bot inflight turn and delivery notes

**Schema and write path.** `<home>/inflight.json` is `{turns: Record<sessionId, {botId, roomId?, since, trigger?, approval?, resumed?}>, queued: Record<sessionId, [{at, args}]>}` (`ds-bot/src/host/resume.js:119-176`). Deliveries are noted before send (`ds-bot/src/host/resume.js:239-255`); a Session's `turn/start`, first `user/message`, and `turn/end` update/remove the turn note (`:273-311`). Notes are replaced whole through a temporary file and atomic rename (`:151-163`, `:181-195`).

**Authority.** It is a recovery hint, not authority. On restart DS Bot reads the Session's durable log, checks whether the exchange was already taken up/finished, and only then resends or resumes (`ds-bot/src/host/resume.js:387-486`, `:511-598`). A `resumed` turn is not resumed forever; a second cut stays stopped (`:317-339`).

**Crash/restart behavior.** The note write is not awaited by the send path, so the Session log remains the tie-breaker. A hard stop can leave the note; a fast crash can lose the note. Re-delivery uses the same `exchangeId` and the Session log suppresses a duplicate turn. A DSH `disposed` turn is treated as cut and picked up; other ended turns are settled from their recorded reason.

**Evidence value.** Good for identifying likely interrupted work and unknown outcomes. It is not completion evidence and does not carry task output. Specific tool side effects can have unknown status after a crash; DS Bot tells the next turn not to repeat blindly.

**Tests.** `ds-bot/test/resume-redelivery.test.js:107-225` covers one-time uptake, cut/disposed sends, and a Session that consumed the exchange while DS Bot was down.

### 7. DS-Bot task ledger

**Schema and write path.** `<home>/ledger/tasks-YYYY-MM-DD.jsonl` receives one JSON row per open/close event with `{...event, day, time}`. Handoff open rows contain `{kind: open, id, from, to, parent, room, child, name}`; close rows contain `{kind: close, id, from, to, parent, room, outcome, chars}` (`ds-bot/src/host/handoffs.js:116`, `:125`; `ds-bot/src/host/task-ledger.js:40-58`). Writes are synchronous appends, but failures only warn and the described work continues (`ds-bot/src/host/task-ledger.js:46-57`).

**Authority and summary.** It is an append-only measurement/projection, not current task state. The reader skips malformed lines; the summary uses the first open and latest close for each ID, and reports closes without opens rather than inventing a duration (`ds-bot/src/host/task-ledger.js:60-134`). Duplicate opens and closes are therefore tolerated but can skew `opened`/`closed`/pending counts. There is no content, acceptance result, or unique constraint.

**Crash/restart behavior.** Rows survive a restart. Rows created while the host is read-only are intentionally absent (`ds-bot/src/host/task-ledger.js:49-57`). A missing row means "not measured here", not "no work happened". There is no fsync barrier before the associated state save.

**Evidence value.** Best source for lifecycle timing and answered/abandoned rates. It cannot by itself prove task existence, current status, completion quality, or evidence content. It also does not record DS-Bot group-goal tasks.

**Tests.** `ds-bot/test/task-ledger.test.js:8-129` covers answered/abandoned counting, close-without-open, duplicate/invalid rows, timezone file naming, read-only behavior, and write failure.

### 8. Team board and board archive

**Schema and write path.** Each board line is normalized to `{bot, kind, what, number, evidence, needs, default, deadline, at}` with missing fields as `null`; accepted kinds are `delivery | decision | blocked` (`ds-bot/src/host/team-board-feed.js:14-32`). `update_team_board` lets a Bot replace only its own file and reports how many lines it holds (`ds-bot/src/host/tools.js:1451-1482`). The current file is atomically replaced; acceptable lines are also appended to `board/archive/*.jsonl` (`ds-bot/src/host/team-board-feed.js:35-81`).

**Authority.** None. This is self-report, and the source explicitly says it may be edited by hand and by scripts (`ds-bot/src/host/team-board-feed.js:1-4`). The archive is a record, not the source of truth (`:83-120`).

**Crash/restart behavior.** The current board survives atomic replacement. An archive append can fail after the board write and is swallowed (`:48-51`). The archive dedupe key uses only `{bot, at, what, kind}` (`:55-56`), so a later correction that changes `evidence`, `needs`, `number`, `default`, or `deadline` but leaves those four fields unchanged can be lost from the archive. A `delivery` line means the Bot says it delivered something.

**Evidence value.** Useful as an authored status/decision/blocker signal and a time hint. It must be lower trust than goal state, a Session tool result, or a content hash. It has no task ID, no foreign key, and no completion verifier.

**Tests.** `ds-bot/test/team-board-feed.test.js:25-118` covers malformed files, three-line display cap, field normalization, per-Bot ownership, and archive dedupe/torn-row behavior.

### 9. DSH scheduled tasks, jobs, and workflow

#### Scheduled tasks

**Schema and write path.** DSH Schedule v2 stores `{record, target, involvedSessionIds?, status, createdAt?, updatedAt?, lastDelivery?, deliveryHistory?, pendingDelivery?}`. `status` is `active | paused | ended | inactive` on disk and normalizes to `active | paused | ended`; `record` carries the schedule rule and prompt; delivery history stores `{scheduledAt, deliveredAt, messageId, targetSessionId?, prompt?}` (`packages/schedule/schedule/src/storage.ts:62-131`; `packages/schedule/schedule/src/types.ts:451-474`). The DS-Bot wrapper lists and edits these service records without owning another copy (`ds-bot/src/host/schedules.js:1-7`, `:113-190`).

**Lifecycle and crash behavior.** The runtime serializes delivery and management, flushes the reminder into the target Session, then commits the advanced schedule plus receipt (`packages/schedule/schedule/src/runtime.ts:233-283`, `:352-375`, `:389-415`). On restart an active overdue task is redriven; `recoverOutstandingExecution` finds an existing last-delivery message still queued in the target inbox and requeues that same message rather than a second logical copy (`:304-346`). An archived target is rejected. A `lastDelivery` receipt proves durable inbox acceptance, not model execution completion. The narrow crash window after inbox flush and before receipt commit is not represented by a receipt and needs an explicit uncertainty/warning in TaskView rather than a completion claim.

**Evidence value and conflicts.** Schedule status answers what the trigger will do, and `lastDelivery.messageId` is stronger evidence that one occurrence reached the Session. It does not answer whether the turn passed its goal or produced a verified artifact. DS-Bot's UI additionally derives `overdue | scheduled | paused | finished` from current time and status (`ds-bot/src/host/schedules.js:113-129`); that is a projection, not stored state.

**Tests.** The pinned DSH has restart-focused tests at `packages/schedule/schedule/tests/execution.spec.ts:36-164` and `packages/schedule/schedule/tests/domain-restart.spec.ts:42-258`. DS-Bot wrapper tests cover create/list/delete, group target, ownership filtering, and failed moves at `ds-bot/test/schedules.test.js:120-272`.

#### Jobs and workflows

`dsh-jobs-local` is process-local. `job/registered` and `job/settled` are durable Session records, but a missing settlement means incomplete, including when teardown loses the final write (`docs/subsystems/jobs.md:25-31`). Workflow has no journaling or resume; a process restart cannot continue a run (`packages/workflow/workflow/README.md:119-130`). Root workflow run and member lifecycle are log-only Session events (`packages/workflow/tool-workflow/src/types.ts:13-63`), but intermediate script values and lines are not durable execution state.

**TaskView treatment.** Show scheduled records as `kind: schedule` and jobs/workflow runs as execution evidence. Do not turn a workflow child's message or a job's output into a completed task without a source task relation and acceptance evidence.

### 10. Session events, durability checkpoints, and part handoffs

**Session events are the execution source of truth.** The v4 event map includes `turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`, `developer/message`, `assistant/message`, `assistant/attempt`, `tool/call`, `tool/result`, `request/header`, `request/context`, `goal/change`, `todo/write`, `deliverables/presented`, `workspace/changes`, `job/registered`, `job/settled`, `team/task`, `turn/*`, and plugin records (`packages/core/session/src/types.ts:281-436`; `packages/core/session/src/known-event-types.ts:22-85`). `turn/end` reasons distinguish `completed`, `aborted`, `blocked`, `error`, `max-tokens`, `interrupted`, and `forked` (`packages/core/session/src/types.ts:193-238`). `assistant/message` carries provider usage with the message; there is no separate usage event (`:337-363`).

**Durability.** Append is visible but persistence is best effort until flush. A resolved flush is the crash-durability barrier (`docs/subsystems/persistence.md:67-91`). The flush checkpoint occurs before model request dispatch, before a top-level tool body, and at the next pre-step after completed work (`packages/session/session-checkpoint-policy/README.md:20-58`). A crash can leave an open turn; persistence preserves the valid prefix, and resume appends missing tool errors/open step closers plus `turn/end {kind:'interrupted'}` (`docs/subsystems/persistence.md:104-114`). A recorded `tool/call` without a result means **unknown external outcome**, not automatic retry.

**DS-Bot part checkpoints.** Context switches store a segment `{sessionId, endedAt, tokens?, note?, noteFrom?, fallback?}` in `bot.segments`, `room.segments`, or `room.parts`, then create a fresh Session, persist the new pointer, and send one `[Handoff · part N]` message containing the note and selected earlier messages (`ds-bot/src/host/parts.js:1168-1219`, `:751-795`). The note is model-generated and must follow the checkpoint template; if generation fails, DS-Bot falls back to an earlier note or the selected messages (`ds-bot/src/host/steward.js:116-169`, `ds-bot/src/host/parts.js:1099-1149`). The fresh `user/message` source carries `handoff: true`, the original trigger/exchange when resuming, and a new exchange ID when needed (`ds-bot/src/host/parts.js:801-809`, `:1229-1234`).

**Evidence value and conflicts.** Session tool calls/results and turn reasons are execution facts. Checkpoint notes are summaries written by the same model; they can say what remains but cannot certify completion. A Session log can show a `group_goal` tool call, a schedule reminder, or a `present`, but it does not by itself bind the tool result to a goal-task acceptance claim. Use exact `sessionId:seq` references in TaskView and label checkpoint prose as `self-report`.

**Tests.** DS-Bot has checkpoint-free restart tests in the handoff/resume suites. DSH has persistence/format and semantic-checkpoint tests; the TaskView layer still needs its own cross-source golden fixtures because no current test validates the combination of goal state, handoff state, ledger rows, schedule receipts, and Session sequences together.

### 11. Group and pair message books

**Schema and write path.** `ledger/*.jsonl` is append-only. `parseBook` skips blank, malformed, and torn lines; `append` queues writes per book and removes a failed in-memory record (`ds-bot/src/host/ledger.js:25-35`, `:63-128`). Pair books use `pair-<sorted IDs>` and carry message rows plus `{event:'delivered', id, sessionId, time}` marks (`ds-bot/src/host/delivery.js:85-106`, `:156-224`). Group books use `group-<roomId>` and carry member lines, notices, `round` summaries, and presentation anchors; the group's `state.json` log is only a latest-60 cache (`ds-bot/src/host/groups.js:203-295`, `:325-360`, `:1422-1444`).

**Authority and lifecycle.** A pair request row is written and awaited before send; a delivered mark is appended after the recipient Session flush (`ds-bot/src/host/delivery.js:156-224`). A group line is appended before reads, but `say` does not await its write (`ds-bot/src/host/groups.js:280-295`). Group rounds append a final `{from,to,passed,failed,stopped?}` row only when the round reaches its finally block (`:1438-1444`). Anchors are UI ranges, not task evidence.

**Crash/restart behavior.** Torn lines are skipped and the next append starts on a new line (`ds-bot/src/host/ledger.js:96-126`). A pair request can be visible without a delivery mark; readers hide it until delivered. A group `room.seq` can advance even if an append fails, and `ensureRoomLog` only reconciles when the book is ahead of saved state (`ds-bot/src/host/groups.js:238-250`), so gaps must be surfaced rather than assumed contiguous. A group process crash can end a round without a durable round row.

**Evidence value.** Very useful for authored message content, delivery acceptance, and round outcome. Not a task authority. `answered`, `done`, or a final post do not prove the claim in the post. The task-ledger and handoff IDs are the only strong handoff joins; group goal tasks have no batch/round/task foreign key.

**Tests.** `ds-bot/test/ledger.test.js` covers parse/write/teardown; group round and failure behavior is exercised in `ds-bot/test/group-goal.test.js` and message tests. A projection fixture must include a torn trailing line and a duplicate delivered mark.

### 12. Workspace artifacts and immutable attachments

**Attachments.** DSH attachments are content-addressed and durable before a Session event references them (`docs/subsystems/attachment.md:5-9`). A local image reference carries an opaque `attachmentId`, media type, byte count, and dimensions; reads verify the stored bytes (`:20-61`). This is the strongest available artifact evidence: the reference is immutable and the bytes can be verified. It says nothing about whether an objective was achieved.

**Presented files.** `deliverables/presented` is `{turn, callId, files[{path, description?}]}`. The tool checks that each path is an existing regular file at call time and stores an absolute path, but it does not copy the bytes (`packages/deliverables/tool-present/src/types.ts:12-16`; `packages/deliverables/tool-present/src/index.ts:78-107`; `packages/deliverables/tool-present/README.md:30-58`). The file can be changed, moved, or deleted after the event (`packages/deliverables/tool-present/README.md:88-94`). A restart can preserve the declaration but not prove current content.

**Changed files.** `workspace/changes` records only `{turn}`; the actual summary and turn-start/turn-end comparisons live in Host memory until Session disposal (`packages/deliverables/workspace-changes/src/types.ts:24-40`, `:99-107`). The docs explicitly say reopened Sessions after a Host restart have no card or comparison (`packages/deliverables/workspace-changes/README.md:84-98`). Therefore a changed-path card is evidence only while the same Host lives, unless an external snapshot or attachment was persisted.

**TaskView treatment.** Attach `attachmentId` and verified byte metadata as strong evidence. Attach a presented path only as a declared artifact plus a verification warning if the path is missing or its bytes cannot be re-hashed. Never treat a path alone as proof of content.

### 13. Usage and cost records

**DS-Bot usage.** `usage.sqlite` has calls keyed by session/turn/step/model/use and token fields `input`, `cache_read`, `cache_write`, `output`; logged calls are folded from `assistant/message` / `assistant/attempt`, while non-log requests are metered live (`ds-bot/src/host/usage.js:1-93`, `:139-207`, `:615-649`). A later usage sample for one attempt replaces the earlier sample and `llm/retry-started` begins a new attempt (`:48-93`). The ledger is explicitly derived; deleting it loses only live-metered calls and deleted-Bot names (`:1-9`). It has no task ID and no monetary fields.

**DSH token meter.** DSH separately projects request pressure and token estimates. It is not billing: occupancy is a reference figure and pricing is for request representation, not a currency ledger (`packages/llm/token-meter/README.md:68`, `:143-158`). Provider usage attached to a Session event is the best source for token accounting, but it does not identify a group task.

**Conclusion.** First TaskView should show usage as an owner/time aggregate or an evidence reference only when the Session event and task relation are exact. It should not claim per-task cost, and it must not invent a currency conversion. Existing data supports tokens, not monetary cost.

### 14. DSH experimental Agent Team task board

This package is a valuable design reference but is not a current DS-Bot task authority. Its `team/task` records are whole snapshots with `{id, revision, subject, description, status, ownerId?, blockedBy, writeScopes}` and statuses `pending | in_progress | completed | deleted` (`packages/experimental/agent-team/src/types.ts:71-98`). Mutations use expected-revision CAS, validate the whole dependency graph, append the event, and `flush` the Lead Session before publishing (`packages/experimental/agent-team/src/task-board.ts:98-210`, `packages/experimental/agent-team/src/journal.ts:57-74`). Its projection derives `ready` and write-scope warnings from committed state (`packages/experimental/agent-team/src/task-view.ts:20-61`).

It demonstrates the right write-through discipline: stable ID, revision CAS, cycle/duplicate checks, append + durable flush, and a pure view. It is experimental and requires durable Session storage; it is not listed in the desktop app's active DS-Bot bundle list (`app/src/profile.mjs:7-9`). It must not be mounted as a second task authority merely to obtain a task view. Use its invariants as conditions for a later bounded adapter, not as a replacement for `group.goal` or `state.works`.

## Minimal read-only TaskView v0

The smallest useful projection is a **read-through, rebuildable view**, not a new table and not a second write path.

```js
TaskViewV0 {
  schema: 0,
  computedAt: epochMs,
  asOf: {
    stateRevision: number,
    sessionSeq: { [sessionId]: number },
    ledgerBytes: { [book]: number },
    scheduleUpdatedAt: { [scheduleId]: string }
  },
  items: [{
    id,                       // stable source-scoped identity
    source,                   // 'group_goal_task' | 'handoff' | 'schedule'
    kind,                     // 'goal_task' | 'handoff' | 'schedule'
    title,
    owner,                    // {botId?, roomId?, sessionId?}
    parentId,                 // source-scoped or null
    dependsOn: string[],      // source-scoped stage/parent gates
    sourceStatus,             // value from the owning record
    statusSource,             // exact file/row/event reference
    projectedPhase,           // display-only: pending|active|waiting|reported|done|paused|ended|unknown
    refs: SourceRef[],        // authority, trigger, session, artifact, ledger
    evidence: EvidenceRef[],  // typed, bounded, with trust and verification
    usageRefs: SourceRef[],   // only exact joins; omit otherwise
    warnings: string[]        // stale, conflicting, missing, inferred, unknown
  }],
  unattached: {
    todoLists: [],            // owner Session checklists, never promoted
    goals: [],                // DSH same-session objectives, context only
    boardLines: [],           // self-report only
    usage: []                 // owner/time aggregates
  }
}
```

### Stable IDs and source status

- **Goal task:** `goal:<goal.id>/stage:<stage.id>/task:<task.id>`. The IDs are stable only within the goal revision chain; include `goal.revision` and the stage/task IDs in every reference.
- **Handoff:** `work:<work.id>`; the ID is the exchange/work identity used by `state.works` and the Session trigger. Parent/child edges come from `work.parent` and `work.open`/`work.results`.
- **Schedule:** `schedule:<task.record.id>`; the record ID also appears in the reminder framing (`packages/schedule/schedule/src/domain.ts:1151-1191`), so a delivered occurrence can be joined without guessing.

Dependencies are references, not a second graph authority: a goal task is gated by its stage sequence, a handoff child is gated by the parent `open` relationship, and a schedule has no task dependency. A handoff parent's `open[]`/`results[]` is the source of whether it is waiting; a goal stage's `status`/`current` is the source of whether the next stage is ready.

The source status must remain a quoted value. `projectedPhase` is a deterministic display mapping and must name its source; it cannot be written back to `room.goal`, `state.works`, or the Schedule table.

### Evidence references

Use a closed, small evidence vocabulary:

```js
SourceRef = {
  kind: 'state' | 'session_event' | 'ledger_row' | 'file' | 'attachment' | 'schedule_receipt',
  ref: string,
  observedAt?: number
}

EvidenceRef = SourceRef & {
  trust: 'authority' | 'execution' | 'immutable_content' | 'self_report' | 'measurement',
  verification: 'none' | 'declared' | 'observed' | 'digest_verified' | 'acceptance_verified',
  relation: 'exact' | 'inferred'
}
```

Required joins:

- Handoff: `state.works[id]` + exact Session `user/message.source.exchangeId == id` / `work == id`; result file or inline result is the returned content.
- Schedule: schedule catalog row + `lastDelivery.messageId`; reminder text/source can be linked by `schedule_id_json` when present.
- Goal task: `room.goal` state + group message/turn references by room, stage number, bot, and time. Mark these `inferred` unless a future field or tool contract stores the task ID in the triggering event.
- Artifacts: attachment IDs are `digest_verified` only after the attachment provider verifies bytes; `present` paths are `declared` only; `workspace/changes` is `observed` only while its Host summary exists.

### Completion rule

```text
unverified  = source says pending/working/active, or no evidence
reported    = a source says reported/done/answered/complete, but evidence is prose or a returned answer
executed    = Session events show the tool/turn happened, but no acceptance predicate is bound
verified    = an immutable artifact digest or an explicit acceptance evaluator/reviewer is bound to the task
unknown     = interrupted, missing result, missing session log, ambiguous join, or conflicting sources
```

Do not let board `delivery`, todo `completed`, goal `pass`, task-ledger `answered`, schedule `lastDelivery`, or a final assistant message advance an item beyond `reported`/`executed` without evidence at the required level. This is the main protection against a new task system that merely republishes self-reports as truth.

## Safe write-through conditions

No TaskRuntime write path should be introduced until all of these hold:

1. **One owner per field.** A TaskView item has one source status owner. A projected or cached TaskView is never independently mutable.
2. **Stable foreign keys.** Goal tasks, handoffs, schedule occurrences, Session triggers, and artifacts have IDs that survive revisions, part switches, and restarts. Today only handoffs and schedules meet this fully; goal tasks need an explicit task/evidence reference before a write-through goal adapter.
3. **CAS and idempotency.** Every mutation carries an expected source revision/id or a stable idempotency key. Follow the existing goal revision, handoff exchange ID, and Schedule `updatedAt`/expected revision patterns.
4. **Durable order.** Write the owning source first and await its durability barrier: `rt.save()` for DS-Bot state, `rt.ledger.written()` for a message book, `ctx.sessions.flush()` for Session events, or the DSH Schedule transaction commit. The aggregate view refreshes only after that barrier resolves.
5. **Atomic evidence binding.** Evidence must be written before a task records a reference to it, or the record must carry an explicit `missing/unverified` state. A long handoff result and Schedule receipt show the right ordering shape; goal `pass` does not yet.
6. **Crash uncertainty.** Never infer success from an incomplete Session turn, a missing tool result, a torn ledger tail, a missing result file, or an uncommitted schedule receipt. Preserve `unknown` and require an explicit check or user decision.
7. **No hidden retries of side effects.** A resumed `tool/call` with no result is unknown outcome; retry only when the operation is read-only/idempotent or after external state verification, as DSH checkpoint recovery states.
8. **Authorization at the source.** Goal/admin permissions, handoff ownership, Schedule ownership, and Session scope remain enforced by their current owners. A TaskRuntime adapter must not become a bypass.
9. **Retention and tombstones.** Preserve stable IDs across goal archive, handoff abandonment, schedule deletion/end, and workspace restart. Do not truncate the only evidence and then call the task verified.
10. **Compatibility and migration.** Any added field must be backward-compatible with `state.version: 1` and Session format v4, with an explicit reader behavior for older records and no silent coercion of unknown statuses.
11. **Read-only host behavior.** A host that cannot acquire the DS-Bot state lock must not write task state or caches; it may only serve a stale/marked view.
12. **Golden replay.** The same fixture must produce byte-stable TaskView output across process restart, input order, timezone, and a second session part.

Until conditions 1-5 and 11 hold, the correct integration is a read-only projection plus source-native tools. If they later justify orchestration beyond local records, add a backend interface and evaluate a durable executor outside the default path rather than turning `TaskView` into a second journal.

## Deterministic recovery and evidence tests

These tests are proposals; no new test file was added in this research branch.

| Test | Fixture and failure | Expected assertion |
|---|---|---|
| `taskview.goal.crash-before-save` | Seed an active goal/task `working`; mutate working/reported without completing the queued state save; reopen the same fixture. | Reopened view equals the last valid `state.json`; no phantom transition or duplicate task ID. |
| `taskview.goal.part-switch` | Move a member to a fresh Session mid-stage; replay the handoff `user/message` and old/new segment pointers. | Same goal-task ID remains; evidence relation is `inferred` unless it carries the task in its source; no duplicate task. |
| `taskview.handoff.long-result-restart` | Parent work with a long child result; write result file, save state reference, restart before parent answers. | Parent stays waiting; result content is exact/whole; child appears once in the parent's `results`; task-ledger open/close row counts are one each. |
| `taskview.handoff.file-missing` | Repeat the previous fixture with the result file absent or byte-short. | View reports `unknown/missing` and does not mark completion; the next step is an explicit check, not a retry. |
| `taskview.handoff-save-vs-ledger-failure` | Make the task-ledger append fail while `state.works` succeeds, and inverse it with a rejected state save. | Sources are reported as divergent; the view never silently chooses one as a verified completion or drops the open wait. |
| `taskview.resume-session-log-wins` | Queue a delivery, stop before the recipient takes it, inject a durable Session log with the exchange taken up and completed, restart. | No resend; the item retains the same exchange ID; evidence points to the Session event; queue note is removed. |
| `taskview.resume-repeated-cut` | Resume, cut again before the turn ends, restart twice with the same note. | The `resumed` guard stops an infinite loop; status is unknown/blocked-for-user, not complete. |
| `taskview.session-tool-unknown` | Write `turn/start`, `tool/call`, no result, then crash/reopen. | DSH repair adds an unknown-outcome tool result and `turn/end interrupted`; TaskView shows `unknown`, not success or retry. |
| `taskview.schedule-restart-queued` | Schedule receipt committed; target inbox still holds the same message; restart and drive. | One logical delivery is recovered/requeued; no duplicate message ID; receipt remains the evidence. |
| `taskview.schedule-pre-receipt-crash` | Flush a scheduled message to the target inbox, crash before receipt/advanced occurrence commit, restart. | If implementation allows this window, TaskView flags possible duplicate/unknown delivery; it must not claim exactly-once execution. |
| `taskview.board-is-not-proof` | Goal task is `working`; board says `delivery=done`; no matching Session tool result/artifact. | Board line remains `self_report`; task phase is not advanced to verified; warning names the conflicting board line. |
| `taskview.todo-is-not-stable` | Multiple `todo/write` whole-list replacements with same text but different order/status; restart. | Latest whole list is replayed; no IDs are invented; the prior entries remain historical events, not duplicate active tasks. |
| `taskview.ledger-torn-duplicate` | Group book has a torn tail, a round row, and duplicate delivered marks; pair book has a request without delivery. | Parser skips only the torn row, round is counted once, delivered mark is idempotent, undelivered request is hidden/marked pending. |
| `taskview.present-path-changes` | `present` a file, then delete/change it before reopening the Session. | Declaration remains visible; verification is `missing` unless an attachment snapshot/hash proves bytes; no completion upgrade. |
| `taskview.workspace-changes-expired` | `workspace/changes` event is present but Host summary is gone after Session disposal/restart. | Path/count evidence is absent, not reconstructed from memory; only the event reference remains. |
| `taskview.usage-duplicates` | Retry produces two `assistant/message` samples for one attempt; another call has no usage. | Later sample replaces earlier; no invented cost; no exact per-task usage without a relation. |
| `taskview.deterministic-order` | Reset and rerun with shuffled file-read order, duplicate timestamps, a timezone boundary, and an injected clock. | Stable ordering is `(source, at, id)`; `asOf` is identical; repeated invocation returns deep-equal output. |

### Minimum acceptance set before implementation

1. The three stable source kinds render read-only without touching source files or Session logs.
2. Every item has a source reference and every warning has a matching conflict/missing fixture.
3. A declared completion with only prose cannot become `verified`.
4. A crash after a source write but before aggregate refresh yields the same view after restart.
5. A Session `tool/call` without a durable result becomes `unknown`, never an automatic retry or a completion.
6. A schedule receipt remains `delivered`, not `complete`.
7. A board or todo update cannot create a task ID or change a source-owned status.
8. The projection is safe in a DS-Bot read-only host.

## Retrieved evidence index

### DS-Bot files

- `ds-bot/index.js:71-79` — team home and `state.json` path.
- `ds-bot/src/host/store.js:22-23`, `:72-107`, `:355-435` — state shape, load, lock, atomic save.
- `ds-bot/src/host/goals.js:60-155`, `:255-409`, `:714-799` — goal/task schema, transitions, writes.
- `ds-bot/src/host/groups.js:203-295`, `:540-704`, `:800-840`, `:1015-1182`, `:1422-1444` — group books, batches, automatic goal-task status, rounds.
- `ds-bot/src/host/handoffs.js:37-141`, `:239-390` — work tree, long results, close/abandon/reconcile.
- `ds-bot/src/host/resume.js:119-195`, `:239-340`, `:387-598` — inflight schema and recovery.
- `ds-bot/src/host/task-ledger.js:40-134` — measurement rows and summary.
- `ds-bot/src/host/team-board-feed.js:14-120` — board/archive schema and limits.
- `ds-bot/src/host/schedules.js:1-7`, `:44-190` — DS-Bot Schedule service boundary.
- `ds-bot/src/host/turns.js:523-633`, `:780-1270` — live work projections and turn event routing.
- `ds-bot/src/host/parts.js:751-809`, `:1099-1234`, `:1425-1460` — part switches, notes, handoff packages, context checkpointing.
- `ds-bot/src/host/steward.js:116-169` — checkpoint template and self-report limits.
- `ds-bot/src/host/ledger.js:25-128` — append-only book parsing/writing.
- `ds-bot/src/host/inbox.js:101-158`, `:161-239` — mailbox idempotency, cursor, gap ledger.
- `ds-bot/src/host/delivery.js:85-106`, `:156-224` — pair books and delivery marks.
- `ds-bot/src/host/claims.js:1-90` — self-report claim markers.
- `ds-bot/src/host/usage.js:1-93`, `:139-207`, `:615-649` — token-derived usage ledger.
- `ds-bot/src/host/store.js:194-200` — lossy batch validation.
- `ds-bot/test/group-goal.test.js:137-173`, `:394-427`, `:569-594` — current goal/task tests.
- `ds-bot/test/handoff-results.test.js:183-315`, `:335-384` — result/restart tests.
- `ds-bot/test/handoff-abandon.test.js:285-365` — abandonment restart tests.
- `ds-bot/test/resume-redelivery.test.js:107-225` — redelivery/idempotency tests.
- `ds-bot/test/task-ledger.test.js:8-129` — ledger tests.
- `ds-bot/test/team-board-feed.test.js:25-118` — board tests.
- `ds-bot/test/schedules.test.js:120-272` — schedule wrapper tests.
- `ds-bot/test/usage.test.js:16-45`, `:258-365` — usage folding and watermark tests.
- `app/src/profile.mjs:7-9` — DS-Bot profile bundles; DSH experimental Agent Team is not a product bundle there.

### DSH files at `66491b05`

- `packages/core/session/src/types.ts:193-238`, `:281-436` — event vocabulary and turn end reasons.
- `packages/core/session/src/known-event-types.ts:22-85` — owned event catalog.
- `packages/bundle/base/cordis.patch.yml:327-334`, `:437-445` — DSH base mounts same-session goals, its driver/command, and `todo_write`.
- `packages/session/session-checkpoint-policy/README.md:20-58`; `docs/subsystems/persistence.md:67-114` — flush checkpoints, crash repair, unknown tool outcome.
- `docs/subsystems/session.md:680-755` — authority, execution enclosure, interruption, seed boundary.
- `packages/goal/goal/README.md:50-68`, `:150-161`; `docs/subsystems/goal.md:7-117` — durable same-session goals and limits.
- `packages/todo/tool-todo/src/index.ts:120-209`; `docs/subsystems/todo.md:9-33` — todo event and projection.
- `packages/experimental/agent-team/src/types.ts:71-98`; `packages/experimental/agent-team/src/task-board.ts:98-210`; `packages/experimental/agent-team/src/journal.ts:57-74`; `packages/experimental/agent-team/src/task-view.ts:20-61` — CAS/DAG/flush reference.
- `packages/schedule/schedule/src/storage.ts:62-131`; `packages/schedule/schedule/src/runtime.ts:233-346`, `:389-450`; `packages/schedule/schedule/src/domain.ts:1151-1191` — schedule schema, receipt, recovery, reminder ID.
- `docs/subsystems/jobs.md:25-31`; `packages/workflow/workflow/README.md:119-130`; `packages/workflow/tool-workflow/src/types.ts:13-63` — process-local jobs and non-resumable workflow.
- `docs/subsystems/attachment.md:5-61` — durable content-addressed attachments.
- `packages/deliverables/tool-present/src/types.ts:12-16`; `packages/deliverables/tool-present/src/index.ts:78-107`; `packages/deliverables/workspace-changes/src/types.ts:24-40`, `:99-107`; `packages/deliverables/workspace-changes/README.md:84-98` — presentation and ephemeral workspace summaries.
- `packages/llm/token-meter/README.md:68`, `:143-158` — token estimates are not billing.

### Architecture drafts read

- `DS-Bot-ai-os/ARCHITECTURE_DECISIONS.md:43-69` — draft ADR: one TaskRuntime over existing surfaces; local durable execution first.
- `DS-Bot-ai-os/CODE_REUSE_MAP.md:19-24`, `:31-48` — draft non-negotiables and task/recovery capability mapping.

## Caveats and residual uncertainty

- The DSH checkout is tagged `dsh-v0.2.2-rc.1` but has unrelated deleted image fixtures; source lines were read from the pinned commit and no data or worktree files were changed.
- The desktop app's dependency graph contains the experimental Agent Team package transitively, but the active app profile does not list it as a bundle. Presence in `node_modules` is not evidence that its task board is usable or authoritative.
- No task-to-artifact verifier exists today. The proposed `acceptance_verified` level is a design requirement, not an implemented capability.
- The proposed TaskView tests are specifications, not executed tests; this branch intentionally contains one research note only.
