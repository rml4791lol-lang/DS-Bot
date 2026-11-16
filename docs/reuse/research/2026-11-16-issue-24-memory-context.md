# Issue #24: Memory, context, retrieval, and correction boundaries

- **Status:** Research complete; reuse map and V1 contract
- **Date:** 2026-11-16
- **Audited product commit:** DS-Bot `26228dfa1e52d536eda78a60936e5c0664e29e9c`
- **Audited runtime:** DSH tag `dsh-v0.2.2-rc.1`, commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`
- **Scope:** source audit only. No real `DSH_HOME`, `~/.dsh`, credentials, cookies, or user memory was read.

## Outcome

DS-Bot already has a coherent memory subsystem. V1 should expose and harden it as a **Memory Hub facade**, not create a second memory store, index authority, permission engine, or context assembler.

The boundary is:

| Concern                        | Single authority                                                                       | What the Memory Hub may do                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Canonical memory entries       | DS-Bot `memory.js` install closure and its sibling review/tidy modules                 | Delegate reads and mutations; add a typed facade                                           |
| Memory durability and recovery | `pending.json` + per-scope Markdown + append-only journal under the DS-Bot data home   | Surface revisions, history and receipts; never write these files directly                  |
| Scope and role policy          | DS-Bot roster plus `writable`, `writeDenied` and `readScopes`                          | Reuse that policy; never duplicate or weaken it                                            |
| Bot/group/team identity        | DS-Bot `state.json` under the one process holding `state.lock`                         | Resolve IDs and visibility through `store.js`; never keep a rival roster                   |
| Session history                | DSH Session log                                                                        | Read through DSH APIs; never mirror the whole Session as a second canonical store          |
| Context prompt assembly        | DSH `ctx.systemPrompt` plus DS-Bot prompt/snapshot contributions                       | Return permitted facts/contributions; never build or send a competing prompt               |
| Context compression            | DSH compaction transaction; DS Bot supplies policy/checkpoint content for Bot Sessions | Observe or request compaction through the public service; never write the surface directly |
| Retrieval                      | Existing DS-Bot BM25, chat FTS5, and group ledger scans                                | Federate through adapters; any index remains derived and rebuildable                       |

The architecture drafts reach the same conclusion: `ARCHITECTURE_DECISIONS.md:71-80` says `memory.js` and siblings remain the only memory write authority, Markdown plus journal stays canonical, and external retrieval must preserve scopes, provenance, expiry, pinning and undo. That draft is advisory and is not part of the audited DS-Bot commit.

## Current architecture

### 1. Identity, Sessions and parts

- A Bot's stable id is the Session id of its first own-chat part. `bot.sessionId` is the current own-chat part; `bot.segments` contains earlier parts. Each group has a hidden Session per Bot (`room.sessions[botId]`) and archived parts in `room.segments[botId]`; the group's own relay Session has `room.sessionId` and earlier `room.parts`.
- `store.js` reconstructs `chatOwners`, `groupOwners`, `roomOwners`, and `pastOwners`, and maps a Session back to its Bot/group. This mapping is authoritative for scope checks.
- DSH persists each Session as an append-only event log. Current Session format is v4 (`packages/core/session/src/types.ts:90`); supported historical formats are migrated by the persistence provider, and unknown/newer formats fail closed.
- DS Bot archives old Session parts through `ctx.workspaceRegistry.archiveSession`; the messages remain readable through DSH Session pages and `read_own_chat`.

**Source:** `ds-bot/src/host/store.js:443-525`; `ds-bot/src/host/parts.js:353-373`; `deepseek-harness packages/session/session-persistence/README.md:59-67,83-108`.

### 2. Scope model

| Scope                | Canonical location                          | Default readers                                           | Default writers                                       |
| -------------------- | ------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| Bot-private          | `memory/bots/<botId>/MEMORY.md` + topics    | That Bot; Main Bots and user through explicit read paths  | That Bot; Main Bots when the user asks; user          |
| Group                | `memory/groups/<roomId>/MEMORY.md` + topics | Current members, only from that group's conversations     | Current members, only while membership is valid; user |
| Team                 | `memory/team/MEMORY.md` + topics            | Every Bot; user                                           | Main Bots, group admins, user                         |
| Another Bot's memory | That Bot's folder                           | Public Bot through `recall`; never injected automatically | Only a Main Bot when the user asks                    |
| Private Bot          | Its own folder and private journal          | Itself and the user                                       | Itself and the user; other Bots are closed out        |

The current tool policy is more precise than the high-level matrix:

- `writesTeam(botId)` is true for a Main Bot **or any group admin**. This is intentional in current code and differs from a simplistic “only Main Bot writes team memory” summary.
- A Main Bot may write another non-private Bot's memory. Privacy is checked again by the privacy guard.
- Group writes require current membership at execution time, not merely membership when the Session started.
- A private Bot cannot be a Main Bot or a group member.

**Source:** `ds-bot/src/host/memory.js:377-421`; `ds-bot/src/host/privacy.js:166-218,318-367`; `ds-bot/src/host/store.js:449,567`; `docs/plans/2026-10-07-roles-and-permissions.md:17-29`.

### 3. Memory record schema and layers

A memory entry is one Markdown bullet:

```text
- <one self-contained fact> [id: 7f3a; source: part 2 #1234; by: Chief; added: 2026-11-16; until: 2026-12-01; pinned: user; merged: abcd ef01]
```

Metadata is optional and parsed generically. Important fields are:

| Field    | Meaning                                                                     |
| -------- | --------------------------------------------------------------------------- |
| `id`     | Four-hex entry identity. Legacy entries derive a stable short id from text. |
| `source` | Own-chat part anchor, group name + sequence, or `memory panel`.             |
| `by`     | Cross-scope author, such as the Main Bot that wrote into a Bot's memory.    |
| `added`  | Date added.                                                                 |
| `until`  | Last day the entry remains active.                                          |
| `pinned` | User pin; automatic tidy and overflow movement must not alter it.           |
| `merged` | Tidy provenance linking a merged entry to source ids.                       |

`MEMORY.md` is resident memory and contains entries plus `## Index` links to topic files. Topic files hold details retrieved on demand. Defaults are 300 characters per entry, 8,000 for a Bot, 12,000 for a group, 4,000 for the team, 16,000 per topic, 40 topics; the resident section is capped at 2% of the routed model window when known.

The four read layers are:

1. **Resident:** own and team `MEMORY.md` are frozen into the DSH system-prompt section at the start of a Session part. Group memory is a separate user-role snapshot before the first group step.
2. **Incremental:** journal rows newer than the Session's `.seen` timestamp become one user-role memory-update message before a step.
3. **Automatic recall:** matching topic entries from own, current-group and team scopes are selected by local BM25, at most five and 3,000 text characters, once per Session part.
4. **On demand:** `recall` reads a topic or searches permitted scopes; `read_own_chat` opens Session history; `read_group_chat` opens the group ledger.

**Source:** `ds-bot/src/host/memory-entries.js:5-20,31-103,106-177`; `ds-bot/src/host/memory.js:671-958`; `docs/plans/2026-11-09-memory-layers.md:11-64`.

### 4. Prompt and context assembly

DSH owns prompt assembly through `ctx.systemPrompt.section(...)` and orders all contributions into one system prompt. Sections must be stable for provider prefix-cache reuse; runtime context and changing facts should be supplied through the documented context/pre-step mechanisms.

DS Bot registers `bot-memory` at order 645 with `interpolate: false`. Its callback returns the frozen own+team section for the current Bot Session. A committed snapshot survives restart; an unfinished memory transaction prevents a new freeze and serves the last safe snapshot where possible. Compaction or a part switch calls `renewMemory`, causing the next render to freeze a new section.

Group memory and dynamic memory changes are not added to the system-prompt string. They are user-role snapshot messages placed before the next step. This keeps private and group Session system prompts byte-identical for prefix caching and keeps group data out of a Bot's private prompt.

**Source:** `ds-bot/src/host/memory.js:731-882,922-963`; `deepseek-harness packages/core/system-prompt/README.md:28-68,121-170`; `deepseek-harness packages/core/agent-loop/README.md:160-178`.

### 5. Context Steward and compression

The Context Steward is a separate small model call. It sees up to 40 recent lines, bounded to about 6,000 tokens, plus `midTurn`, `group`, and checkpoint count. It returns only `switch` or `compact`. Missing/invalid output defaults to `switch`; messages that try to instruct the Steward are treated as data.

Thresholds are model-derived:

```text
usable = max(declaredWindow - replyReserve, declaredWindow / 2)
hard   = 0.95 * usable
check  = min(checkRatio * usable, hard, checkTokens)
```

Defaults are a 500,000-token fallback window, `checkRatio = 0.8`, and absolute `checkTokens = 380,000`. A part checks again only after growing another `check / 4`.

The split of responsibilities is:

- DS Bot decides **when and why** for Bot Sessions and writes the semantic checkpoint/handoff content.
- DSH performs the compaction transaction: validate a balanced surface range, append `compaction/start`, summarize, append `compaction/summary`, replace the selected range with one user-role summary message, and append `compaction/end`. Shadowed events remain in the raw log.
- DS Bot intercepts the compaction service instance for Bot Sessions: backend automatic pressure and `/compact` are suppressed, while explicit model-switch compaction is adapted to a DS Bot checkpoint. This is runtime service adaptation, not a DSH source patch.
- Local-agent CLI Sessions bypass DS Bot size compaction; the CLI owns its in-session compaction while DSH keeps the full Session log.

**Source:** `ds-bot/src/host/steward.js:11-171`; `ds-bot/src/host/parts.js:170-351,654-729,1399-1461`; `deepseek-harness packages/compaction/compaction/README.md:67-111`; `deepseek-harness packages/compaction/compaction-basic/README.md:62-90,119-139`; `deepseek-harness packages/compaction/compaction/src/index.ts:110-193`.

### 6. Retrieval and search

There are three deliberately separate retrieval implementations:

| Retrieval surface                | Store                                       | Algorithm                                                                        | Scope/authorization                                                     |
| -------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Memory `recall` / auto-recall    | Active Markdown entries                     | In-process BM25 over term sets; Han character pairs and Latin tokens             | Scope-filter first, then rank                                           |
| `read_own_chat`                  | DSH Session logs across every own-chat part | SQLite FTS5 trigram + BM25; short terms use `LIKE`; linear Session scan fallback | The calling Bot's own chat; group use is logged as a visible lookup     |
| `read_group_chat` / group search | Append-only group ledger                    | Literal AND term search, newest first, with neighbor context                     | Member or Main Bot visibility policy; exact sequence opens full history |

The chat FTS table is derived state, versioned as `INDEX_VERSION = 3`, catches up from DSH Session events, seals ended parts, and is rebuilt if deleted/corrupt. Memory search does not use FTS because two-character Chinese words are important. Group search does not create an index; it scans the ledger.

DSH also exposes `ctx.sessionQuery` with exact reads, filters, relationship traces, and optional SQLite FTS search. It is trusted infrastructure with **no caller authorization**; any model-facing use still needs DS-Bot scope checks. Current DS-Bot code reaches Session pages directly and maintains its own chat index, so replacing that now would create an unnecessary compatibility project.

**Source:** `ds-bot/src/host/memory-search.js:1-29`; `ds-bot/src/host/chat-index.js:1-292`; `ds-bot/src/host/group-search.js:1-54`; `ds-bot/src/host/groups.js:203-365,1522-1608`; `deepseek-harness packages/session-query/session-query/README.md:28-52,79-115,142-152`.

## Single write authority and every path

### Canonical transaction path

The single canonical memory authority is the closure created by `install(rt)` in `ds-bot/src/host/memory.js`. It owns the memory root, scope resolution, authorization, serialization, recovery, entry mutations, lifecycle archives, and the public memory endpoint. `memory-review.js` and `memory-tidy.js` do not reopen or own storage; they receive the authority's callbacks and call back into it.

Every canonical entry mutation follows this transaction:

1. Enter the per-host `queued(...)` chain.
2. Recover any unfinished `pending.json` change.
3. Re-run `writable(scope, actor)` against current roster/membership/privacy and host lock.
4. Reload the current scope files.
5. Build all file writes/removals plus the journal row as one `pending.json` record.
6. Replace files atomically.
7. Append the unique journal row.
8. Remove `pending.json`.
9. Update the in-memory recent-change feed used by running Sessions.

`publish()` is the transaction function for ordinary entry changes. Lifecycle operations also remain inside the same authority:

- `archiveBotMemory` and `archiveGroupMemory` first recover pending work, then `rename` the whole folder into `memory/archive/` and journal the archive row. They do not use `publish`, but they do not escape the authority closure.
- `retired.jsonl` and tidy batch files are written through `publish` steps for a tidy.
- Snapshot files, `.seen` markers, `reviewed.json`, panel summaries, `tidied.json` no-op stamps, and the chat index are **derived state**, not canonical memory. Some bypass `publish`; a Hub must not mistake them for authority or reconstruct truth from them.

Cross-process exclusion comes from `state.lock`: one host owns the writable team; other hosts become read-only. Memory/compaction/review paths check `rt.readOnly()` and refuse writes.

**Source:** `ds-bot/src/host/memory.js:87-184,241-375,377-421,333-360,515-669,845-851,1781-1797`; `ds-bot/src/host/memory-pending.js:1-95`; `ds-bot/src/host/memory-tidy.js:84-223`; `ds-bot/src/host/home-lock.js:1-98`; `ds-bot/src/host/store.js:330-370`.

### Read paths

| Path                  | Entry point                                             | What it reads                                                 | Important behavior                                               |
| --------------------- | ------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| Resident prompt       | `ctx.systemPrompt.section('bot-memory')` → `sectionFor` | Own + team `MEMORY.md`, topic index                           | Frozen per part; persisted under `memory/snapshots/`             |
| Group prompt snapshot | `agent/pre-step` → `groupSnapshot`                      | One group's `MEMORY.md` + topic index                         | User-role snapshot, members only, reinserted after compaction    |
| Incremental update    | `agent/pre-step` → `memoryUpdate`                       | Journal tails for own/team/current group                      | Only rows newer than `.seen`; excludes this Session's own writes |
| Automatic recall      | `agent/pre-step` → `autoRecall`                         | Own/group/team topics                                         | BM25 threshold; deduplicated by entry id in the Session          |
| Agent recall          | tool `recall`                                           | Requested visible scopes                                      | Topic whole-file read or BM25 text search                        |
| Memory panel          | `memory-view`, mobile memory-aware calls                | Bot own+team or group memory; summary JSON                    | User UI path; model summarizer is read-only over entries         |
| Memory review         | `memory-review.js`                                      | New DSH Session lines or group ledger lines + current entries | Cursor-based, one review at a time                               |
| Tidy                  | `memory-tidy.js`                                        | Entries in one scope                                          | At most 1/5 changed; soft-archive removed entries                |
| Own chat              | tool `read_own_chat`                                    | DSH Session pages/FTS index                                   | All own-chat parts, compressed lines included                    |
| Group chat            | tool `read_group_chat`                                  | Group ledger + latest room log                                | Exact `seq`, search, or latest lines                             |
| Prompt/context sizes  | `tokenMeter` + `resolveModelInfo`                       | DSH Session and model metadata                                | Fallback estimate if adapter/meter fails                         |

### Write paths

| Path                      | Public API                                               | Canonical operation                                                                       |
| ------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Bot tool                  | `remember`                                               | Add or replace one entry                                                                  |
| Bot tool                  | `forget`                                                 | Remove exactly one matched entry                                                          |
| Automatic memory review   | `installReview`                                          | Add/edit/remove after an idle turn; may route to team/another Bot/group only under policy |
| Memory panel conversation | `memoryAsk`                                              | Model proposes add/edit/remove; each change re-enters add/replace/remove                  |
| Memory panel direct edit  | `memoryEdit` / `memoryAdd`                               | Mobile/user edit through same authority                                                   |
| Memory panel controls     | `memoryForget`, `memoryPin`, `memoryLayer`, `memoryMove` | Remove, pin, resident/topic move, cross-scope move                                        |
| History undo              | `memoryRestore`                                          | Inverse journal transaction with drift/duplicate/secret checks                            |
| Tidy undo                 | `memoryTidyUndo`                                         | Restore the latest unchanged tidy batch only                                              |
| Background tidy           | `tidyNow` / timer                                        | Merge, retire, move, or annotate topic entries                                            |
| Bot lifecycle             | `archiveBotMemory`                                       | Rename Bot memory folder into archive                                                     |
| Group lifecycle           | `archiveGroupMemory`                                     | Rename group memory folder into archive                                                   |

UI endpoints are routed by `channel.js`; `memory-edit` and `memory-add` also come through the mobile endpoint. The model-facing tools are registered in `rt.teamTools`.

**Source:** `ds-bot/src/host/memory.js:1038-1220,1222-1797`; `ds-bot/src/host/channel.js:147-185,585-610`; `ds-bot/src/host/mobile.js:485-495`; `ds-bot/src/host/roster.js:811-828,929-990`.

### Derived write paths that are not memory authority

| Artifact                                                 | Writer                      | Why it is derived                                                                                                     |
| -------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `memory/snapshots/<session>.md` and `.seen`              | `sectionFor` / `markSeen`   | Frozen view and update cursor; can be regenerated                                                                     |
| `memory/reviewed.json`                                   | `memory-review.js`          | Review progress cursor                                                                                                |
| `memory/summaries/<id>.json`                             | `memoryView`/`startSummary` | Model-written UI summary with source hash                                                                             |
| `memory/.../tidied.json`, `tidy/*.json`, `retired.jsonl` | Tidy                        | Tidy checkpoint/batch state derived from journal-backed operations; `retired.jsonl` is evidence, not the active truth |
| `chat-index.sqlite`                                      | `chat-index.js`             | Rebuildable FTS projection of DSH Session logs                                                                        |
| `ledger/*.jsonl`                                         | `ledger.js` / `groups.js`   | Append-only group message record                                                                                      |
| DSH Session events and compaction events                 | DSH                         | Execution/history authority, not DS-Bot memory                                                                        |

## Provenance, versioning, correction and deletion

| Concern                | Current guarantee                                                                                                                         | Limit/gap                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry provenance       | Server adds `source` and `added`; cross-scope writes add `by`; group source names group + sequence; own-chat source names part + sequence | Source is usually the latest relevant user message/batch anchor, not a citation for every claim; memory-review rows do not persist model/provider         |
| Read provenance        | `recall` displays metadata; prompt entries show id/date; `read_own_chat` and `read_group_chat` resolve anchors                            | Source resolution is textual and depends on the relevant Session still being readable                                                                     |
| Entry identity         | `id` is four hex; legacy entries derive id from text                                                                                      | Not globally collision-proof across history; `newEntryId` avoids only current collisions                                                                  |
| Memory format version  | None explicit in `MEMORY.md`                                                                                                              | No migration header/schema version; parser must remain backward-compatible                                                                                |
| Mutation revision      | Journal row id + exact before/after lines; restore checks current line equality and duplicates                                            | No public opaque entry revision/ETag; callers must match text or infer from journal                                                                       |
| Session format version | DSH Session format v4, with supported migrations and fail-closed unknown versions                                                         | Memory snapshots do not carry the Session format version                                                                                                  |
| Chat index version     | `INDEX_VERSION = 3`, rebuildable                                                                                                          | Probe/index failures fall back to linear scans; `around` requires the index                                                                               |
| Correction             | `remember(replace)`, direct user edit, tidy edit/merge, restore inverse                                                                   | Ambiguous text matches are refused; panel/model edits can fail per change while returning partial success                                                 |
| Deletion               | `forget` removes active line, journal retains before/after; tidy `retired.jsonl`; whole-scope archive moves folder                        | No archive-restore endpoint; delete semantics are not uniform across memory, DSH Sessions, and group ledger                                               |
| Group delete           | DS Bot archives group memory and DSH member/group Sessions                                                                                | Product text says “history is archived,” but `deleteRoom` calls `dropGroupLines`, which deletes the group ledger file. This is a retention contradiction. |

### Group deletion evidence

`delete_group` says, “Delete a group chat; its history is archived.” `deleteRoom` archives memory and Sessions, but also calls `dropGroupLines(id)`. `dropGroupLines` calls `rt.ledger.drop(...)`, and `ledger.drop` removes the JSONL book. Therefore the group memory folder and DSH Sessions are archived, while the canonical team-visible group ledger is physically deleted. The Hub must not promise “all group history is archived” until product semantics are decided and the implementation is corrected.

**Source:** `ds-bot/src/host/tools.js:739-751`; `ds-bot/src/host/roster.js:811-828`; `ds-bot/src/host/groups.js:273-278`; `ds-bot/src/host/ledger.js:136-140`.

## Main Bot authority

`rt.isMain(id)` is a membership test against `state.mainBotIds`. Main Bot powers are enforced in individual tools, not by the model prompt:

- Create/update other non-private Bots, stop other Bots, create any group, change any group, delete a group, post into any group.
- Write team memory.
- Read and write another non-private Bot's memory when the user asks.
- Automated memory review can route a new entry to another Bot only when its keeper is a Main Bot.

The group admin is a narrower authority over one room, but current memory policy also lets any group admin write team memory. User-only actions include changing sandbox permissions, setting/unsetting Main Bots, privacy and deletion. A Main Bot cannot be private or be deleted until its Main role is removed.

**Source:** `ds-bot/src/host/store.js:449`; `ds-bot/src/host/memory.js:393-421`; `ds-bot/src/host/memory-review.js:118-133`; `ds-bot/src/host/tools.js:79-88,370-470,558-650,739-751`; `ds-bot/src/host/roster.js:584-725,896-932`.

## Reuse map

| Capability                  | Reuse as-is                                                       | Adapt / facade                                | Do not rebuild                             |
| --------------------------- | ----------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------ |
| Bot/group/team scope checks | `memory.js` `namedScope`, `writeDenied`, `readScopes`, `writable` | Expose typed scope resolution                 | Another RBAC matrix                        |
| Canonical add/edit/delete   | `addEntry`, `replaceEntry`, `removeEntry`                         | Hub mutation commands map 1:1 to these        | Direct file writes or a second DB          |
| Atomic durability/recovery  | `queued`, `publish`, `pending.json`, agent recovery               | Map failures to stable Hub errors             | New outbox/queue as authority              |
| Journal/history/undo        | Existing rows, `memoryHistory`, `memoryRestore`                   | Return receipt/revision and paginated history | Git-backed or event-sourced second history |
| Tidy                        | `installTidy`, `retired.jsonl`, batch undo                        | Expose tidy status/batch receipt              | Vector-store lifecycle replacing journal   |
| Resident layers             | System-prompt section + persisted snapshot                        | Optional `ContextContribution` read model     | A Hub-owned prompt renderer                |
| Incremental updates         | Journal-tail user messages                                        | Optional subscription/change feed             | Duplicating journal into a pubsub store    |
| Auto/manual recall          | BM25, scope filtering, prompt budget                              | `search()` facade and provenance DTO          | New mandatory embedding index              |
| Own-chat retrieval          | DSH pages + FTS5 rebuildable index                                | Wrap behind `history.search` adapter          | Copying Session history into memory files  |
| Group history               | Group ledger and exact `seq` addresses                            | Wrap behind `history.search` adapter          | Separate group transcript database         |
| Context compression         | DSH compaction + DS Bot Steward/checkpoint hooks                  | Expose context policy/status read model       | A second compaction engine                 |
| Session durability          | DSH Session persistence/query                                     | Use DSH APIs for history/provenance           | Mirroring sessions into a Hub store        |

## Minimal V1 Memory Hub contract

V1 should be an **in-process typed facade over existing authorities**, not a new service process. The following is intentionally narrower than the current UI surface:

```ts
type Caller =
  | { kind: "user" }
  | { kind: "bot"; botId: string; sessionId: string; roomId?: string };

type Scope =
  | { kind: "bot"; botId: string }
  | { kind: "group"; roomId: string }
  | { kind: "team" };

type Revision = {
  journalId: string;
  lineHash: string;
};

type MemoryHit = {
  id: string;
  scope: Scope;
  topic: string | null;
  text: string;
  status: "active" | "expired" | "retired" | "archived";
  meta: {
    source?: string;
    by?: string;
    added?: string;
    until?: string;
    pinned?: boolean;
    merged?: string;
  };
  revision: Revision;
};

type Mutation =
  | {
      op: "add";
      scope: Scope;
      text: string;
      topic?: string;
      until?: string;
      pin?: boolean;
    }
  | {
      op: "replace";
      scope: Scope;
      entryId: string;
      expected: Revision;
      text: string;
      topic?: string;
      until?: string;
      pin?: boolean;
    }
  | { op: "remove"; scope: Scope; entryId: string; expected: Revision }
  | {
      op: "move";
      from: Scope;
      entryId: string;
      expected: Revision;
      to: Scope;
      topic?: string;
    }
  | {
      op: "pin";
      scope: Scope;
      entryId: string;
      expected: Revision;
      pinned: boolean;
    }
  | {
      op: "restore";
      scope: Scope;
      journalId: string;
      expectedCurrent?: Revision;
    };

type Receipt = {
  changed: boolean;
  journalId?: string;
  entries: Array<{ id: string; revision: Revision }>;
  message: string;
};

interface MemoryHub {
  visibleScopes(caller: Caller, requested?: Scope): Promise<Scope[]>;
  search(
    caller: Caller,
    request: {
      text?: string;
      topic?: string;
      scopes?: Scope[];
      includeExpired?: boolean;
      budgetTokens?: number;
      limit?: number;
    },
  ): Promise<MemoryHit[]>;
  mutate(caller: Caller, mutation: Mutation): Promise<Receipt>;
  history(
    caller: Caller,
    request: {
      scope: Scope;
      before?: string;
      limit?: number;
    },
  ): Promise<
    Array<Receipt & { time: string; op: string; actor: string; text: string }>
  >;
}
```

### Contract invariants

1. **One writer.** `mutate()` must call the existing memory authority and never write `MEMORY.md`, topics, journal, pending record, archive, or retired file itself.
2. **Server-derived actor/source.** The caller never supplies `actor`, `by`, `source`, or `added`; the authority derives them from Session/group context.
3. **Permission at execution time.** `visibleScopes()` is advisory UX. Every read and mutation calls existing `readScopes`/`writable`/privacy checks at execution time.
4. **Opaque revision.** `Revision` is an adapter over the journal row plus exact current line/hash, not a new persisted memory field.
5. **No silent conflict resolution.** Replace/remove/move require the expected revision or raise a stable conflict; never “edit whatever currently matches best.”
6. **One transaction, one receipt.** A successful mutation returns the committed journal id. A failed partial multi-change request returns per-change outcomes rather than implying atomicity across separate entries.
7. **Derived indexes only.** Any Hub search index must be deletion-safe and rebuildable from canonical Markdown/journal or DSH Session logs. It cannot be the source of truth.
8. **Prompt ownership stays in DSH.** Hub returns facts/contributions with scope and provenance; DSH/DS-Bot prompt code remains the only place that chooses resident/system/user-snapshot placement.
9. **Compaction ownership stays in DSH.** Hub may report context status or request a documented compaction operation, but never mutate a Session surface.
10. **Archive is not delete.** A missing active record and an archived record are distinct states. V1 must not claim archive restoration unless a real authority endpoint exists.
11. **Stable error taxonomy.** At minimum: `memory/denied`, `memory/not-found`, `memory/conflict`, `memory/unreadable`, `memory/pending`, `memory/gone`, `memory/invalid`, `memory/too-large`.
12. **No cross-scope leakage.** Search filters visibility before scoring; private Bot memory and group memory remain closed unless their existing path explicitly permits it.

## Gaps and adapter needs

### Reuse now

- Agent Memory Repo Markdown format.
- Existing scope directories, entry metadata, limits, expiry and pinning.
- `publish`/`pending.json`, journal, archive and restore semantics.
- Memory review/tidy scheduling and batch undo.
- Resident snapshots, incremental updates, auto recall and the `recall` tool.
- DSH Session persistence, token meter and compaction transaction.
- Existing FTS5 chat index and group ledger search as retrieval adapters.

### Adapter required

1. **Core Memory Adapter:** typed `visibleScopes/search/mutate/history` wrapping current functions. This is the V1 Hub.
2. **Policy Adapter:** maps `Caller` and Session/room context into current `rt` predicates; no policy fork.
3. **Revision Adapter:** derives `Revision` from journal ids and exact rendered lines. If the line cannot be matched uniquely, fail with conflict.
4. **Retrieval Adapter:** federates memory BM25, `read_own_chat` FTS, and group ledger; deduplicates by canonical identity/anchor and preserves source kind.
5. **Provenance Resolver:** translates `part N #seq` or `group "X" #seq` into a read call through existing tools/APIs; does not copy the source message into memory.
6. **Context Contribution Adapter:** exposes `{sourceKind, ids, text, frozenAt}` to DS-Bot prompt code. It must not register its own competing system prompt or call `agent.inject` directly.
7. **Error Adapter:** maps `MemoryWriteError` codes, `NO_MATCH`, `GONE`, `DENIED`, unreadable/pending/too-large failures into stable Hub errors.

### New implementation required before expanding the promise

1. **Group retention decision and implementation.** Resolve the `delete_group` copy versus physical ledger deletion. Either archive the ledger or change the promise and UI.
2. **Archive recovery API.** Current code archives whole Bot/group memory folders but has no product endpoint to restore them. Add only if product requirements demand it.
3. **Explicit memory format version.** Current files have no schema version. Introduce only with a migration plan and dual-read tests.
4. **Global entry revision/identity hardening.** Current four-hex ids are short. Use journal-backed revision now; consider a format migration only if collisions or distributed import become real.
5. **Review model provenance.** Journal records actor/auto/session, but not the model/provider that generated a review. Add only if audit requirements need model-call provenance.
6. **Retention/legal policy for DSH Session logs.** DSH persistence exposes no deletion/retention API; DS Bot archives Sessions but does not delete raw Session artifacts.

## Concrete failure modes

| Failure                                 | Current behavior                                                                  | Hub implication                                                |
| --------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `pending.json` malformed/oversized      | Memory unavailable; writes/reads fail closed until repaired                       | Return `memory/pending`; never “repair” by discarding silently |
| Journal unreadable                      | Mutation/read stops; file left untouched                                          | Surface recovery-required state                                |
| Torn journal tail                       | Quarantine to `journal.torn`; ignore half row; append one whole row               | Preserve evidence; do not infer a successful mutation          |
| Crash after file writes, before journal | Pending recovery reapplies idempotently                                           | Receipt must not claim success before recovery completes       |
| Unreadable `MEMORY.md`/topic            | Resident prompt shows a failure line; writes fail rather than overwrite           | Hub read must mark degraded, not empty                         |
| Ambiguous `forget`/replace              | Refuses and asks for a longer quote/id                                            | Return conflict/ambiguous, never delete multiple               |
| Two concurrent writers                  | Same process: serialized queue. Cross-process: home lock makes one host read-only | No browser-side or adapter-side write bypass                   |
| Bot/group deleted while queued          | Rechecked before write; returns gone/denied                                       | Do not recreate scope folder                                   |
| Member left group                       | Immediate membership check blocks read/write; Session archived                    | Cached Hub scopes must be revalidated                          |
| Private Bot target                      | Privacy guard closes read/write to other Bots                                     | No generic “team search” over private entries                  |
| Review model malformed output           | Cursor may advance after warning, intentionally avoiding an infinite retry        | Audit gap is possible; record diagnostics                      |
| Review write fails                      | Cursor generally remains so lines can be retried                                  | Surface review backlog/failure                                 |
| Summary failed                          | Old summary is retained; failure attached to content/model hash                   | Do not treat summary as canonical memory                       |
| FTS unavailable/corrupt                 | Rebuild once; otherwise linear Session scan                                       | Search result completeness/diagnostic must be visible          |
| `around` without index                  | Explicit error; text search still works                                           | Provenance UI needs a fallback                                 |
| DSH context overflow                    | DSH/DS Bot switches or compacts according to route and policy                     | Hub must not mutate context directly                           |
| Huge system/tool envelope               | DSH compaction cannot shrink it                                                   | Switch/model/folder strategy remains separate                  |
| Local-agent Session                     | CLI owns compaction; DS Bot skips size compaction                                 | Do not apply Steward thresholds to local-agent history         |
| Unknown/newer Session format            | DSH fails closed                                                                  | Hub history unavailable; never misparse                        |

## Test map

### DS-Bot

- `ds-bot/test/memory.test.js:18-86` — format, topic index, entry matching, secret rejection.
- `ds-bot/test/memory.test.js:218-258` — remember/forget and journal rows.
- `ds-bot/test/memory.test.js:259-817` — restore, drift, duplication, topic rebuild, secret and path hardening.
- `ds-bot/test/memory.test.js:818-873` — Chinese/Latin recall ranking and query caps.
- `ds-bot/test/memory.test.js:875-939` — Main Bot/group-admin/other-Bot write boundaries and full-file overflow.
- `ds-bot/test/memory.test.js:940-1010` — snapshot freeze across restart, unreadable memory, role-based re-freeze.
- `ds-bot/test/memory.test.js:1010-1024` — deleted Bot memory archive.
- `ds-bot/test/memory.test.js:2012-2080` — automatic recall, old group lines, group-only review.
- `ds-bot/test/memory.test.js:2094-2190` — tidy drift, 1/5 limit, batch undo, per-scope records and team exclusions.
- `ds-bot/test/memory.test.js:2248-2350` — group isolation, defaults, snapshot reinsertion, deletion archive and panel isolation.
- `ds-bot/test/memory.test.js:2384-2585` — queued/deleted/moved review behavior, long messages, first review, part switches and feature flags.
- `ds-bot/test/memory-pending.test.js:68-303` — pending recovery, crash windows, tombstone journal rows and oversized record refusal.
- `ds-bot/test/steward.test.js:5-120` — dynamic lines, Steward JSON, budget, checkpoint framing and outstanding-request retention.
- `ds-bot/test/history.test.js:44-105` — history extraction, FTS/LIKE query construction and heading normalization.
- `ds-bot/test/model-switch-compaction.test.js:86-147` — Bot model-switch checkpoint adaptation and `/compact` refusal.
- `ds-bot/test/privacy.test.js:229-241,445-482` — private memory read/write denial and separate journal.
- `ds-bot/test/group-work.test.js:271-303` — whole group message recovery by sequence.
- `ds-bot/test/memory-history.test.js:79-109` — history UI, second-click undo and pagination.

### DSH

- `packages/core/system-prompt/tests` — ordered sections, dynamic context and tool ordering.
- `packages/compaction/compaction/tests/tool-pairing.spec.ts` — balanced range boundaries.
- `packages/compaction/compaction-basic/tests/compaction-basic.spec.ts` — threshold, retention, surface replacement.
- `packages/compaction/compaction-basic/tests/compaction-loop-repro.spec.ts` and `runtime-context-admission.spec.ts` — next-step pressure and post-compaction context admission.
- `packages/session/session-persistence/tests/storage-contract.spec.ts:57-96` — current/older/newer format behavior.
- `packages/session-query/session-query/tests/tracing.spec.ts:311-514` — replacement/source-event traces and surface validation.

## Recommended V1 sequence

1. Add a pure `MemoryHub` facade over `memory.js`; no new persistence.
2. Add revision derivation and stable errors; exercise existing memory tests against the facade.
3. Add a retrieval adapter that composes memory BM25, own-chat FTS and group ledger without a new index.
4. Add provenance rendering that resolves anchors through existing read tools.
5. Add only deletion-safe, rebuildable derived indexes if measured latency requires them.
6. Keep DSH context compression outside the Hub; expose context status as a read-only adapter.
7. Resolve group-ledger deletion semantics before promising retention or “delete everywhere.”
8. Consider optional external retrieval/OpenViking only behind this contract after measured BM25 failures and legal review.

## Open decisions

- Should deleting a group archive or deliberately destroy the group ledger? Current copy and implementation disagree.
- Is “Main Bot may change another Bot's memory only when the user asks” a tool-policy rule, a prompt convention, or both? Current code enforces role but relies on instruction for the “when the user asks” condition.
- Does V1 expose archive discovery/recovery, or explicitly leave archives administrator-only?
- Should review entries record the model/provider that generated them, as DSH compaction summaries already do?
- Is a memory format version needed before external adapters, or is dual-reading current Markdown + journal sufficient for V1?

## Source ledger

### Official/product design documents

- [DS-Bot vision](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/docs/vision.md#L9-L36) — long-term memory, Bot/group/team scope, user and Main Bot powers.
- [Context and memory design](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/docs/plans/2026-10-09-context-and-memory.md#L20-L125) — parts, Steward, checkpoints, memory storage and write path.
- [Memory restore design](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/docs/plans/2026-11-01-memory-restore.md) — journal undo and corruption behavior.
- [Memory layers design](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/docs/plans/2026-11-09-memory-layers.md#L11-L64) — resident, incremental, automatic and on-demand reads.
- [DSH system prompt](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/system-prompt/README.md#L28-L170) — prompt section registry and cache behavior.
- [DSH agent loop](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/README.md#L160-L178) — retained history and model surface.
- [DSH compaction contract](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/compaction/compaction/README.md#L67-L115) — lock, event bracket and single surface replacement.
- [DSH basic compaction](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/compaction/compaction-basic/README.md#L62-L139) — thresholds, retention, model switch and limitations.
- [DSH Session persistence](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/session/session-persistence/README.md#L51-L108) — append-only logs, recovery and format migrations.
- [DSH Session query](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/session-query/session-query/README.md#L28-L115) — exact history reads, traces and search boundary.

### Source references

- [memory.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory.js#L87-L1797) — authority, scopes, transactions, prompt injection, review/tidy, panel and restore.
- [memory-entries.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory-entries.js#L1-L298) — schema, parser, limits, matching and secret checks.
- [memory-pending.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory-pending.js#L1-L95) — durable pending transaction.
- [memory-review.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory-review.js#L23-L405) — idle review, cursors and routing.
- [memory-tidy.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory-tidy.js#L32-L264) — merge/retire/move and batch undo.
- [memory-search.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory-search.js#L1-L29) — local BM25.
- [chat-index.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/chat-index.js#L1-L293) — FTS5/trigram Session history projection.
- [group-search.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/group-search.js#L1-L54) and [ledger.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/ledger.js#L1-L175) — group transcript/search and deletion.
- [parts.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/parts.js#L1-L1535) — parts, checkpoint, handoff, Steward integration and compaction interception.
- [steward.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/steward.js#L11-L171) — thresholds, decision and checkpoint prompts.
- [store.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/store.js#L330-L590) — lock, Session ownership, Main Bot lookup.
- [roster.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/roster.js#L584-L990) — group authority, deletion and archive lifecycle.
- [privacy.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/privacy.js#L166-L367) — private memory/group/session guard.

### Supplemental planning drafts (not shipped at the audited commit)

- `DS-Bot-ai-os/ARCHITECTURE_DECISIONS.md:71-80` — single Memory Hub and Markdown authority decision.
- `DS-Bot-ai-os/docs/design/personal-ai-os.md:81-93,367-376,443-451` — authority table, Memory view requirements and Phase 5.
- `DS-Bot-ai-os/docs/reuse/code-reuse-registry.json:990-1042` — long-term memory, retrieval, correction decisions and acceptance criteria.

## Reusable takeaway

Keep `memory.js` and its journal as the only canonical memory authority. Build V1 as a typed, permission-preserving read/write facade over that authority, reuse BM25/FTS/ledger as derived retrieval adapters, and leave prompt assembly plus Session compaction with DSH. The first product ambiguity to resolve is group-ledger deletion, not storage technology.
