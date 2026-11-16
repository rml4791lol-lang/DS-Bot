# Issue #30: Source-audit mature memory systems and retrieval architectures

- **Status:** Research complete; V1 reuse and rejection decision
- **Date:** 2026-11-16
- **DS-Bot baseline:** `26228dfa1e52d536eda78a60936e5c0664e29e9c`
- **Scope:** Public upstream source and official documentation only. No real `~/.dsh`, `DSH_HOME`, credentials, cookies, user memory, or other private data was read.

## Outcome

V1 should keep DS-Bot's current Markdown memory trees and append-only journal as the only memory write authority. The useful result of this audit is not a new backend. It is a smaller set of invariants and retrieval patterns that can harden the existing system without introducing a second default store:

1. **Directly reuse** the Agent Memory Repo Markdown contract already implemented by DS-Bot.
2. **Directly reuse** SQLite FTS5/BM25 as a derived, rebuildable search projection; DS-Bot already does this for chat history through Node's built-in `node:sqlite`.
3. **Borrow as design** Obelisk's scope-first retrieval, `path + summary` memory index, stable source anchors, soft deletion, and no-silent-overwrite rule. Do not make Obelisk a V1 dependency.
4. **Borrow as design** Hermes's hard separation between an observing memory provider and a context engine, its single-external-provider rule, and its optional fail-closed checkpoint before lossy compaction. Do not import its Python runtime or replace Context Steward.
5. **Borrow as design** OpenViking's L0/L1/L2 progressive disclosure, trusted provenance preservation through model-driven merges, and conservative, schema-aware consolidation. **Reject** OpenViking as the default V1 memory service or linked dependency because it duplicates memory authority and adds a Python/Rust service, model/index dependencies, and AGPL obligations.

No measured recall failure in DS-Bot currently justifies a vector database, external memory service, or second write path.

## Current DS-Bot boundary

| Concern | Current authority | What must remain true |
| --- | --- | --- |
| Canonical memory | Per-scope `MEMORY.md`, topic Markdown files, and `journal.jsonl` | Markdown plus journal remains the source of truth; any index is disposable |
| Scope and permissions | Bot/group/team scope closures and existing role checks in `memory.js` | Retrieval filters visibility before scoring and never becomes its own permission engine |
| Resident context | Frozen Session snapshot of `MEMORY.md`, topic index, and optional group snapshot | Prompt snapshots remain byte-stable; later changes arrive as separate messages |
| Recall | In-memory BM25 over permitted entries, plus whole-topic reads | No mandatory embedding service; preserve multilingual behavior and scope-first filtering |
| History search | `chat-index.sqlite`, FTS5 trigram, BM25 ranking, derived from Session logs | Rebuildable projection only; Session logs remain authoritative |
| Correction and deletion | Review/tidy operations, append-only journal, `pending.json`, `retired.jsonl`, undo | Corrections remain recoverable and never silently overwrite concurrent content |
| Context management | Context Steward chooses `switch` or `compact`; Session logs and `read_own_chat` retain evidence | Compaction must remain a DSH/DS-Bot lifecycle operation, not a second context engine |
| Skills | DSH plugin skills and project/user skill roots | Skills remain separately loaded instructions, not another mutable memory type |

The current read layers are documented as resident, incremental, automatic recall, and on-demand in [DS-Bot's memory-layer design](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/docs/plans/2026-11-09-memory-layers.md#L11-L64). The implementation confirms the same boundary: `MEMORY.md` and topics are scoped Markdown, each Session freezes its own prompt section, topic recalls use local BM25, and newer journal entries are appended as a separate update message ([memory.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory.js#L1-L26), [memory.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory.js#L670-L757), [memory.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory.js#L875-L920)).

Context Steward is already the DS-Bot-specific analogue of Hermes's context engine: above a model-relative check line it asks a smaller model to choose a fresh conversational part at a stopping point or an in-place checkpoint while work continues ([steward.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/steward.js#L1-L47)). The full transcript remains searchable, and the checkpoint prompt explicitly tells the Bot to preserve open work, decisions, exact data, and rejected approaches ([steward.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/steward.js#L116-L170)). Replacing this with an external ContextEngine would create a second context authority.

## Source audit

### 1. OpenViking

**Audited source:** `volcengine/OpenViking@5f53cbf01128d76575c8b2ffce69bfcd3eb96045` on 2026-11-16; latest release `v0.5.5` was published 2026-11-13 ([release](https://github.com/volcengine/OpenViking/releases/tag/v0.5.5)).

**Organization.** OpenViking models three first-class context types: resources, memories, and skills, with experimental rules as a fourth mandatory constraint type. Memories are further split into profile, preferences, entities, events, cases, trajectories, and experiences, stored in user/peer namespaces rather than one flat store ([context types](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/concepts/02-context-types.md#L1-L13); [memory API](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/api/16-memory.md#L3-L21)). This is stronger typing than DS-Bot needs in V1. DS-Bot's Bot/group/team scopes already encode the product's permission and sharing boundaries; adding OpenViking's types would create extra schema and migration surface before a demonstrated issue.

**Markdown schema and indexing.** OpenViking keeps content in AGFS/VikingFS and a separate vector index. Directories can carry `.abstract.md` (L0, default 256 characters) and `.overview.md` (L1, default 4,000 characters); L2 is the original or parsed body. The L0/L1 sidecars use minimal Markdown with YAML fields for directory, source, generator, and freshness ([context layers](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/concepts/03-context-layers.md#L1-L114)). Retrieval records store URI, parent URI, context type, dense and sparse vectors, abstract, name, description, timestamps, and access count ([storage](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/concepts/05-storage.md#L101-L136)).

**Hierarchical and on-demand retrieval.** The important pattern is progressive disclosure, not the vector database: L0 filters, L1 navigates, and L2 is read only when needed. Context-mode retrieval applies quotas and a token budget, can return only a URI for later reading, and can bucket results by memory/resource/skill category ([retrieval](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/concepts/07-retrieval.md#L46-L104); [retrieval API](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/api/06-retrieval.md#L697-L731)). DS-Bot already has a smaller version: resident `MEMORY.md`, a topic catalog, automatic recall, `recall(topic)`, and full chat search. L0/L1/L2 is only worth adding if topic catalogs or resource volumes outgrow that model.

**Deduplication, correction, provenance, and deletion.** OpenViking's strongest reusable rule is its merge policy: similarity or shared topic is only a candidate signal; merge only on schema-defined identity; preserve every atomic fact; keep uncertain identities separate; never satisfy a length target by deleting facts ([merge policy](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/openviking/session/memory/merge_policy.py#L1-L22)). Consolidation is conservative and can rename, split, merge, or compact in place ([consolidation](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/context-compilation/06-memory-consolidation.md#L1-L65)). Each model-produced operation carries trusted runtime provenance including extraction run, session, archive URI, task ID(s), trace ID, and extraction time ([MemoryOperationSource](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/openviking/session/memory/dataclass.py#L157-L173)); a later model merge must not become authoritative for task ownership, so the runtime restores provenance from its inputs ([streaming updater](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/openviking/session/memory/streaming_memory_updater.py#L1345-L1416)). Resource snapshots support diff and restore, and delete/move operations synchronize the vector projection ([versions](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/getting-started/14-versions.md#L1-L56); [storage](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/concepts/05-storage.md#L138-L157)). Session commit is crash-recoverable through a persisted queue, although retrying model extraction does not guarantee identical text ([transactions](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/concepts/09-transaction.md#L34-L42), [transaction](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/concepts/09-transaction.md#L151-L176)).

**Local operation, dependencies, tests, and license.** Local filesystem and local vector backends exist, but the documented local path requires `uv`, Python 3.13, an embedding model, and a VLM with tool-call support; remote/cloud services are also supported ([quickstart](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/getting-started/02-quickstart.md#L9-L55)). The Python package has broad web, parsing, telemetry, storage, model-SDK, and server dependencies, plus optional Redis/PostgreSQL/MySQL integrations ([pyproject.toml](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/pyproject.toml#L15-L137)). The repository contains 817 `tests/test_*.py` files, including 113 memory/merge/retrieval/version/snapshot-focused files in the shallow checkout. The project is AGPL-3.0 ([license](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/LICENSE)). GitHub metadata observed on 2026-11-16 showed heavy activity, but also substantial open-issue volume.

**V1 decision.** **Reject direct reuse and adapter integration for V1.** The product requirement does not justify a service, vector index, model indexer, or AGPL boundary. **Borrow as design** only the already-simple hierarchy, category-aware budgets, trusted-provenance restoration, and conservative merge rules. An optional standalone `MemoryAdapter` remains a post-measurement option under the existing reopen condition in `DS-Bot-ai-os/ARCHITECTURE_DECISIONS.md:71-80`, with legal review and no linked AGPL source.

### 2. AgentMemoryRepo

**Audited source:** `AgentMemoryRepo/agentmemoryrepo@8798cb26c817d451a5ed6cba0ad8d9eca8d5ec3e` on 2026-11-16. No GitHub release was published; the last source commit was 2026-10-06.

**Organization and Markdown schema.** This repository is a specification and installable agent skill, not a runtime. It defines a repository rooted at `MEMORY.md`, optional topic files/folders, one-fact bullet entries, open-ended `[key: value; key: value]` metadata, recommended `source`/`added` fields, `[[path]]` cross-links, and a short resident index ([SPEC](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/8798cb26c817d451a5ed6cba0ad8d9eca8d5ec3e/SPEC.md#L1-L63)). DS-Bot already implements this family of format with additional IDs, expiry, pinning, provenance, actor, journal, review, tidy, and undo ([memory-entries.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory-entries.js#L1-L87), [memory.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory.js#L1-L26)).

**Retrieval and lifecycle.** The intended loop is load `MEMORY.md`, grep or follow links, update entries in place, and commit; a periodic "Dreaming" agent is specified to add patterns, merge duplicates, remove stale entries, and check sources to resolve contradictions ([README](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/8798cb26c817d451a5ed6cba0ad8d9eca8d5ec3e/README.md#L51-L75)). The repo describes Git commits and merge conflicts as the multi-writer mechanism, but the format itself does not implement indexing, semantic conflict detection, deletion tombstones, schema versions, or recovery. The skill directs agents to read `MEMORY.md`, grep/read links, edit in place, and commit after every change ([SKILL.md](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/8798cb26c817d451a5ed6cba0ad8d9eca8d5ec3e/skills/agent-memory-repo/SKILL.md#L41-L73)).

**Local operation, tests, and license.** It is local-first and depends only on an agent plus Git for the documented workflow; there is no executable implementation or test suite in this repository. It is MIT-licensed ([license](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/8798cb26c817d451a5ed6cba0ad8d9eca8d5ec3e/LICENSE)). GitHub metadata observed on 2026-11-16 showed no commits in the preceding 30 days and two open issues.

**V1 decision.** **Directly reuse the format contract; do not import a second writer or Git as memory authority.** DS-Bot's current implementation is a superset and should remain compatible where practical. No adapter is needed.

### 3. Hermes memory and context code

**Audited source:** `NousResearch/hermes-agent@e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e` on 2026-11-16; latest release `Hermes Agent v0.23.1` was published 2026-11-10 ([release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.1)).

**Memory and skill organization.** Hermes's built-in memory is two small profile-scoped Markdown files, `MEMORY.md` (default 2,200 characters) and `USER.md` (1,375 characters), injected as a frozen Session-start snapshot. Writes are `add`, `patch`, and `remove`; exact duplicates are skipped, memory-full returns an error rather than silently dropping data, and writes use a whole-file lock plus atomic replace ([memory docs](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/website/docs/user-guide/features/memory.md#L11-L58), [memory docs](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/website/docs/user-guide/features/memory.md#L90-L131), [memory store](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/tools/memory_tool_store.py#L403-L419), [memory store](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/tools/memory_tool_store.py#L701-L745)). Skills are separate directories with metadata and progressive disclosure: list metadata first, load full `SKILL.md` second, then specific references ([skills docs](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/website/docs/user-guide/features/skills.md#L172-L230)).

**Retrieval and context.** Hermes stores sessions in SQLite with FTS5 search and uses a pluggable context engine; only one context engine may be active, and it explicitly owns compaction policy. A memory provider, by contrast, is an observer that may sync/index a turn but does not own the Session surface ([memory docs](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/website/docs/user-guide/features/memory.md#L235-L260), [context-engine docs](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/website/docs/developer-guide/context-engine-plugin.md#L7-L24), [context-engine docs](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/website/docs/developer-guide/context-engine-plugin.md#L220-L243)). An external memory provider runs alongside built-in memory, but only one may be active at once to avoid conflicting backends and tool-schema bloat ([provider docs](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/website/docs/developer-guide/memory-provider-plugin.md#L613-L615)).

**Correction, provenance, and compaction safety.** Built-in memory has unique-substring matching, ambiguity refusal, exact-duplicate rejection, atomic writes, and drift backups, but no general append-only journal or arbitrary version tree. Provider hooks receive Session/turn metadata, and an opt-in checkpoint contract can make compaction fail closed until an external archiver durably captures the transcript ([provider lifecycle](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/website/docs/developer-guide/memory-provider-plugin.md#L116-L155), [checkpoint contract](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/website/docs/developer-guide/memory-provider-plugin.md#L249-L307)). This last rule is the useful boundary: lossy compaction must not proceed without durable evidence, but DS-Bot already retains full Session logs and exposes `read_own_chat`; it should encode the invariant as a test rather than import Hermes's compressor.

**Local operation, dependencies, tests, and license.** The project is local-capable and heavily configurable, but it is a large Python 3.11-3.14 application with hundreds of dependencies and its own agent/gateway/session stack ([pyproject.toml](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/pyproject.toml#L15-L137)). The shallow checkout contains 8,245 `test_*.py` files; 859 paths match memory/context/session/FTS/skill tests. It is MIT-licensed and highly active, but its runtime model conflicts with DS-Bot's DSH-only architecture.

**V1 decision.** **Borrow as design; reject direct reuse and adapter integration.** Keep the memory-observer/context-owner separation, one-external-authority rule, approval/staleness protections, and fail-closed evidence checkpoint. Do not embed the Python application, memory manager, provider registry, or ContextEngine.

### 4. SQLite FTS5/BM25 and Obelisk

**Official SQLite facts.** FTS5 is an SQLite virtual-table module for full-text search; its `bm25()` ranking function returns smaller values for better matches, and the trigram tokenizer supports substring matching and case-insensitive matching for general text ([SQLite FTS5](https://www.sqlite.org/fts5.html), [trigram tokenizer](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)) — current documentation retrieved 2026-11-16. DS-Bot already uses this architecture for chat history: `node:sqlite`, WAL mode, a rebuildable FTS5 trigram table, BM25 ordering for terms of three or more characters, and `LIKE` fallback for one- and two-character terms ([chat-index.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/chat-index.js#L1-L43)). This avoids a native SQLite dependency because `node:sqlite` is built into the pinned Node runtime.

**Audited reference implementation:** `eric8810/obelisk@ce81c40f99be20716040fe62b5888dfee11bfbf4` on 2026-11-16; latest release `obelisk-v0.4.3` was published 2026-09-17 ([release](https://github.com/eric8810/obelisk/releases/tag/obelisk-v0.4.3)).

**Organization and schema.** Obelisk normalizes transcript evidence from several coding agents into one SQLite schema, while its durable memory records remain human-approved Markdown files. The `memories` projection stores ID, source session, project, source message range, normalized Markdown path, optional anchors, English retrieval summary, creation time, soft-delete time, and delete reason; `memories_fts` indexes only path and summary ([schema](https://github.com/eric8810/obelisk/blob/ce81c40f99be20716040fe62b5888dfee11bfbf4/crates/obelisk-core/src/schema.sql#L83-L108); [schema guide](https://github.com/eric8810/obelisk/blob/ce81c40f99be20716040fe62b5888dfee11bfbf4/skill-doc/references/schema.md#L191-L235)). Its design is therefore close to DS-Bot's desired rule: Markdown is durable truth; SQLite is a query projection.

**Hierarchical retrieval and on-demand loading.** Obelisk recommends scope first, then structure, then text: exact project/session/file/time filters before broad search; `overview()` for orientation; FTS, summaries, and small raw windows only after a scope is selected ([retrieval semantics](https://github.com/eric8810/obelisk/blob/ce81c40f99be20716040fe62b5888dfee11bfbf4/skill-doc/references/retrieval-semantics.md#L8-L32)). Memory search filters scope and `deleted_at IS NULL`, then orders by FTS rank and creation time ([query.rs](https://github.com/eric8810/obelisk/blob/ce81c40f99be20716040fe62b5888dfee11bfbf4/crates/obelisk-core/src/query.rs#L1527-L1581)). This is a useful future implementation pattern for DS-Bot if memory growth makes repeated full-entry tokenization expensive.

**Correction, provenance, and deletion.** `remember()` inserts a new ID and regenerates on collision rather than silently replacing another record; `forget()` soft-deletes with a reason and is idempotent ([query.rs](https://github.com/eric8810/obelisk/blob/ce81c40f99be20716040fe62b5888dfee11bfbf4/crates/obelisk-core/src/query.rs#L1683-L1806)). Corrections are archive-plus-write, and the retrieval guidance requires user approval for mutations when a conflict is discovered without an explicit correction request ([retrieval semantics](https://github.com/eric8810/obelisk/blob/ce81c40f99be20716040fe62b5888dfee11bfbf4/skill-doc/references/retrieval-semantics.md#L129-L159)). The reference does **not** implement semantic duplicate detection or per-row history, and it deliberately indexes only English summaries.

**Local operation, dependencies, migration, tests, and license.** Obelisk is local/offline: a Rust CLI/desktop using bundled SQLite, QuickJS, and file watching, with no server requirement ([Cargo.toml](https://github.com/eric8810/obelisk/blob/ce81c40f99be20716040fe62b5888dfee11bfbf4/Cargo.toml#L1-L24)). It stores incremental cursors in `index_state` and treats the SQLite schema as a versioned contract. Its DSH integration is a plugin-owned skill invoking the CLI while preserving DSH's native history channel, not a second DSH runtime ([DSH plugin ADR](https://github.com/eric8810/obelisk/blob/ce81c40f99be20716040fe62b5888dfee11bfbf4/docs/adr/0012-obelisk-as-dsh-optional-retrieval-plugin.md#L19-L68)). The repo has 255 Rust test attributes plus Node DSH/E2E/golden tests. It is AGPL-3.0-only. It is technically well documented but has low adoption and no commits in the 30 days before retrieval; maintenance risk is higher than OpenViking or Hermes.

**V1 decision.** **Directly reuse SQLite FTS5/BM25 as a derived projection; borrow Obelisk's design; reject Obelisk itself as a V1 dependency.** DS-Bot should copy no AGPL code. If memory search later needs SQLite, add an internal, delete-safe, rebuildable index containing only `{entry id, scope, topic/path, summary, source anchor, status/version}` and rebuild it from Markdown/journal. Keep multilingual tokenization; do not adopt Obelisk's English-only summaries or route all memory writes through a second CLI.

## Comparison

| System | Organization and loading | Dedup/conflict/correction | Provenance/versioning | Local/dependencies | Tests/license | Maintenance signal | V1 call |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenViking | Typed resource/memory/skill; L0/L1/L2; budgeted context assembly | Conservative identity-based consolidation; conflict markers; source-preserving merges | Runtime extraction/session/archive/task/trace provenance; snapshots; delete projection sync | Local service possible; Python/Rust, embedding/VLM/reranker, broad deps | 817 Python test files; 113 relevant memory/retrieval files; AGPL-3.0 | Very active; large surface | Reject V1 service; design-borrow hierarchy/provenance |
| AgentMemoryRepo | Short `MEMORY.md` + linked Markdown topics; grep/link loading | Dreaming process specified; Git conflicts; in-place correction | Per-entry source field; Git history; no implemented runtime | Git/local files; no code runtime | No runtime tests; MIT | No release; no 30-day commits | Direct-reuse format contract |
| Hermes | Built-in Markdown memory + separate skills + SQLite session FTS; optional external provider; pluggable context engine | Exact-duplicate skip; unique patch/remove; atomic writes/drift backup; no semantic tidy in built-in store | Session/turn metadata; optional durable checkpoint; no general memory journal | Local-capable; large Python app and dependency graph | 8,245 test files, 859 related; MIT | Very active | Design-borrow boundaries/checkpoint; reject runtime |
| Obelisk | SQLite evidence index + Markdown memory; scope-first; bounded raw windows | New-ID insert, soft delete/reason, archive-plus-write, human approval; no semantic dedupe | Session/message/path anchors; index cursors; no per-row history | Rust CLI/desktop; bundled SQLite/QuickJS; no server | 255 Rust tests plus DSH/E2E/golden; AGPL-3.0-only | Low adoption; no recent commits | Design-borrow projection pattern; reject dependency |

## Mapping to DS-Bot V1

### Keep and harden, do not replace

- Keep `memory.js`, `memory-entries.js`, `memory-review.js`, `memory-tidy.js`, `memory-pending.js`, and the journal as the only authority.
- Keep Agent Memory Repo-compatible Markdown, but treat that as a format contract rather than an instruction to import its current skill or Git workflow.
- Keep local BM25 recall over the small curated corpus. It preserves Chinese substring behavior and avoids per-entry embedding calls ([memory-search.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory-search.js#L1-L29)).
- Keep `node:sqlite` FTS5 for chat history. It is already a derived index with explicit `INDEX_VERSION`, WAL, rebuild-on-damage, scope restrictions, and log-scan fallback.
- Keep Context Steward plus DSH Session persistence. Add only an invariant test: every lossy compaction path must leave the original evidence readable through `read_own_chat`, and every checkpoint must preserve unresolved requests and exact identifiers.

### Design borrows that fit V1

1. **Scope-first retrieval contract.** Expose one internal read shape that always resolves caller visibility, scope, status (`active`, `expired`, `retired`, `archived`), and provenance before scoring. This borrows Obelisk's first principle and preserves DS-Bot's existing permission model.
2. **Derived `path + summary + anchor` index only if measured.** Current in-memory BM25 is appropriate for curated entry counts. If profiling shows a problem, add a rebuildable SQLite projection; never make it canonical.
3. **Trusted provenance survives model merges.** DS-Bot already derives `source`, actor, session, and journal data outside model output. Make that an explicit invariant in tidy outputs and tests, borrowing OpenViking's rule that a model may merge content but may not rewrite trusted task/session provenance.
4. **Conservative consolidation.** Keep the current tidy order from `memory-copy.js`: contradictions first, then repeats, then stale status, then detail movement; cap changes, do not touch pinned entries, and retain retired content. OpenViking's same-identity/no-fact-loss rule is a useful wording and test oracle ([tidy prompt](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory-copy.js#L158-L172); [tidy implementation](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory-tidy.js#L1-L80)).
5. **Fail-closed evidence checkpoint.** Before any future compaction backend is enabled, require proof that transcript evidence is durable and addressable. DS-Bot meets this today through Session logs and the chat index; the invariant should survive future storage changes.
6. **One optional external authority at a time.** If DS-Bot ever adds a `MemoryAdapter`, activation must be mutually exclusive with any other external provider, read-only unless the adapter implements the full scoped journaled write contract, and removable without losing local Markdown.

### Explicitly reject for V1

- OpenViking as default or linked storage, a required local service, or a copied code path.
- Obelisk as a second memory writer, a mandatory Rust CLI, or a source of English-only retrieval semantics.
- Hermes's Python runtime, ContextEngine, or provider registry as a replacement for DSH/Context Steward.
- A vector database, knowledge graph, Git-backed memory authority, or whole-transcript mirror merely to improve recall.
- Any external write path that bypasses scope checks, `pending.json`, journal receipts, expiry/pinning, archive semantics, or undo.

## Migration and rollout rules

Any future derived memory index should follow a disposable-projection migration:

1. Declare a schema/index version separate from the Markdown format.
2. Build into a new table or new database file while the old projection remains readable.
3. Backfill from canonical Markdown/journal; never require exported vectors.
4. Compare counts, scope visibility, expired/retired filtering, and orphan detection before switching readers.
5. Abort switch-over on mismatch; retain the old projection for rollback.
6. Delete and rebuild the projection from canonical files in a test to prove it is not a second authority.
7. Keep migrations additive and dual-read during the transition; do not rewrite canonical entry metadata solely for the index.

Agent Memory Repo supplies no migration mechanism. Hermes demonstrates provider-specific migration but is not a compatible runtime. OpenViking's OVPack validates manifest checksums and format versions, but that package format belongs to its service ([transfer](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/getting-started/15-transfer.md#L149-L151)). Obelisk's schema/index-state discipline is the closest lightweight reference.

## Recommended acceptance tests

- A caller cannot retrieve a private Bot, non-member group, expired, retired, or deleted entry; visibility is resolved before ranking.
- Search over equivalent Chinese, mixed-language, punctuation, and short-term queries remains at least as good as the current BM25/LIKE behavior.
- A duplicate add is reported unchanged; ambiguous correction is refused; concurrent stale correction fails rather than rewriting the wrong line.
- A tidy merge preserves pinned entries, actor/session provenance, exact source anchors, every atomic fact, and leaves an undoable retired batch.
- A journal update after a frozen snapshot appears only as a separate memory-update message; the original system-prompt prefix remains byte-stable.
- A checkpoint or fresh-part switch leaves every removed message readable through `read_own_chat`; unresolved work and exact identifiers survive in the checkpoint/handoff.
- A damaged derived index can be deleted and rebuilt from Markdown/journal or Session logs with identical permitted hits.
- The system works with no network, no embedding model, no external service, and no new process.

## Retrieval sufficiency and caveats

This audit used exact shallow checkouts of the four upstream repositories, read their primary README/specification/docs, storage schemas, merge/provenance code, retrieval code, and test inventory, and inspected the DS-Bot implementation at `26228dfa`. Upstream test suites and benchmarks were not executed; test counts are static inventory, not pass evidence. GitHub activity and issue counts were observed on 2026-11-16 and will drift.

The main unresolved product question is not which storage engine to adopt. It is whether current recall quality and topic scale are actually inadequate. Until a DS-Bot evaluation demonstrates a recall or latency failure that cannot be fixed inside the existing Markdown/BM25/FTS5 design, an external memory adapter would add authority, migration, licensing, and operational risk without evidence of user value.

## Primary sources

### OpenViking

- [Context types](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/concepts/02-context-types.md#L1-L105)
- [L0/L1/L2 context layers](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/concepts/03-context-layers.md#L1-L188)
- [Storage and vector schema](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/concepts/05-storage.md#L1-L164)
- [Retrieval mechanism](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/concepts/07-retrieval.md#L1-L140)
- [Memory consolidation](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/context-compilation/06-memory-consolidation.md#L1-L104)
- [Memory merge policy](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/openviking/session/memory/merge_policy.py#L1-L22)
- [Operation provenance](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/openviking/session/memory/dataclass.py#L157-L173)
- [Provenance-preserving merge](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/openviking/session/memory/streaming_memory_updater.py#L1345-L1416)
- [Crash recovery and compaction](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/concepts/09-transaction.md#L34-L42)
- [Versions and snapshots](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/docs/en/getting-started/14-versions.md#L1-L56)
- [`pyproject.toml` dependencies](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/pyproject.toml#L15-L137)
- [AGPL-3.0 license](https://github.com/volcengine/OpenViking/blob/5f53cbf01128d76575c8b2ffce69bfcd3eb96045/LICENSE)

### Agent Memory Repo

- [Format specification](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/8798cb26c817d451a5ed6cba0ad8d9eca8d5ec3e/SPEC.md#L1-L63)
- [Memory loop and Dreaming](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/8798cb26c817d451a5ed6cba0ad8d9eca8d5ec3e/README.md#L51-L125)
- [Agent skill workflow](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/8798cb26c817d451a5ed6cba0ad8d9eca8d5ec3e/skills/agent-memory-repo/SKILL.md#L41-L73)
- [MIT license](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/8798cb26c817d451a5ed6cba0ad8d9eca8d5ec3e/LICENSE)

### Hermes Agent

- [Persistent memory](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/website/docs/user-guide/features/memory.md#L11-L260)
- [Memory provider plugins](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/website/docs/developer-guide/memory-provider-plugin.md#L87-L307)
- [Single external provider rule](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/website/docs/developer-guide/memory-provider-plugin.md#L613-L615)
- [Context engine contract](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/website/docs/developer-guide/context-engine-plugin.md#L7-L243)
- [Context compression and checkpoints](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/website/docs/developer-guide/context-compression-and-caching.md#L39-L120)
- [Progressive skill disclosure](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/website/docs/user-guide/features/skills.md#L172-L230)
- [Memory store implementation](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/tools/memory_tool_store.py#L177-L745)
- [MIT license](https://github.com/NousResearch/hermes-agent/blob/e96221fa73d2dac7ba9f3bc5a8b866b3d0fc188e/LICENSE)

### SQLite and Obelisk

- [SQLite FTS5](https://www.sqlite.org/fts5.html)
- [SQLite trigram tokenizer](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)
- [Obelisk schema SQL](https://github.com/eric8810/obelisk/blob/ce81c40f99be20716040fe62b5888dfee11bfbf4/crates/obelisk-core/src/schema.sql#L83-L108)
- [Obelisk retrieval code](https://github.com/eric8810/obelisk/blob/ce81c40f99be20716040fe62b5888dfee11bfbf4/crates/obelisk-core/src/query.rs#L1527-L1581)
- [Obelisk remember/forget](https://github.com/eric8810/obelisk/blob/ce81c40f99be20716040fe62b5888dfee11bfbf4/crates/obelisk-core/src/query.rs#L1683-L1806)
- [Obelisk retrieval semantics](https://github.com/eric8810/obelisk/blob/ce81c40f99be20716040fe62b5888dfee11bfbf4/skill-doc/references/retrieval-semantics.md#L8-L168)
- [Obelisk DSH integration](https://github.com/eric8810/obelisk/blob/ce81c40f99be20716040fe62b5888dfee11bfbf4/docs/adr/0012-obelisk-as-dsh-optional-retrieval-plugin.md#L19-L68)
- [AGPL-3.0-only license](https://github.com/eric8810/obelisk/blob/ce81c40f99be20716040fe62b5888dfee11bfbf4/LICENSE)

### DS-Bot source

- [memory.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory.js#L1-L26)
- [memory-entries.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory-entries.js#L1-L87)
- [memory-search.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory-search.js#L1-L29)
- [memory-tidy.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory-tidy.js#L1-L80)
- [memory-copy.js tidy policy](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/memory-copy.js#L158-L172)
- [Context Steward](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/steward.js#L1-L171)
- [chat-index.js](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/chat-index.js#L1-L260)
- [memory tests](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/memory.test.js)
- [Context Steward tests](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/test/steward.test.js)

### Advisory architecture draft

- `DS-Bot-ai-os/ARCHITECTURE_DECISIONS.md:71-80` — single Memory Hub; Markdown plus journal is canonical; external retrieval must preserve DS-Bot semantics and AGPL needs legal review.
- `DS-Bot-ai-os/ARCHITECTURE_DECISIONS.md:149-158` — evidence-gated external code adoption.

## Reusable takeaway

Keep the current DS-Bot memory and Context Steward boundaries. Directly reuse only the Agent Memory Repo format and Node/SQLite FTS5 as derived search. Borrow Obelisk's scope-first derived index and hard provenance/soft-delete discipline, Hermes's observer-versus-context-owner and fail-closed checkpoint boundaries, and OpenViking's progressive disclosure and conservative merge policy. Reject all four as a second runtime or default memory authority. Add an external adapter only after a measured recall or scale failure and a migration/rollback test prove that the local Markdown/BM25/FTS5 design is insufficient.
