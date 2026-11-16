# Issue #27: Source audit of mature agent runtimes

- **Date:** 2026-11-16
- **Issue:** [rml4791lol-lang/DS-Bot#27](https://github.com/rml4791lol-lang/DS-Bot/issues/27)
- **Base:** DS-Bot `26228dfa1e52d536eda78a60936e5c0664e29e9c`
- **Request type:** Comprehensive source, architecture, release, dependency, licence, security and maintenance audit.
- **Decision posture:** Keep DSH as the only Agent Runtime. Reuse only bounded protocols, libraries or patterns that do not create a second execution authority.

## Outcome

The first safe vertical slice is **not another loop, session store, permission system or subagent manager**. It is a **B-class SDK replacement of DS-Bot's hand-written loopback MCP transport** with the official MCP TypeScript SDK v2.4.0 server and Node HTTP adapter, while preserving the existing `LoopbackMcp` API and DSH-backed tool execution.

The runtimes audited below contain useful production patterns, but none should be embedded as DS-Bot's runtime. Hermes, OpenCode and Pi are alternative runtimes in Python, Effect/TypeScript and Node respectively; Goose is a Rust agent platform; DSH already owns DS-Bot's model calls, tools, step boundaries, cancellation, compaction and Session replay.

## Scope and evidence method

Inspected exact release/tag commits rather than moving branches:

| Project | Release | Inspected commit | Release date | Last observed push | Licence |
|---|---|---|---|---|---|
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | [v0.23.1](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.1) | `3b421578588243f920886e6fe79a6faa87ea026e` | 2026-11-10 | 2026-11-16 | MIT |
| [OpenCode](https://github.com/anomalyco/opencode) | [v2.3.0](https://github.com/anomalyco/opencode/releases/tag/v2.3.0) | `a6b15d33daf6ab7d35569f6d711fdb630b9f04e7` | 2026-11-13 | 2026-11-16 | MIT |
| [Pi](https://github.com/earendil-works/pi) | [v1.5.2](https://github.com/earendil-works/pi/releases/tag/v1.5.2) | `b4afdddf44e059c67ccf5097e5317d913521b470` | 2026-11-10 | 2026-11-15 | MIT |
| [Goose](https://github.com/aaif-goose/goose) | [v1.59.1](https://github.com/aaif-goose/goose/releases/tag/v1.59.1) | `e62a656f460d6399b34c747014d810727ff70b05` | 2026-11-14 | 2026-11-16 | Apache-2.0 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | [dsh-v0.2.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1) | `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` | 2026-11-04 | 2026-11-13 | MIT |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | [v2.4.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.4.0) | `951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5` | current v2 line | n/a in this run | Apache-2.0 plus legacy MIT material |

All source links below are pinned to those commits. Test counts are file counts from those checkouts, not claims that every test was run here.

Version note: DSH [`dsh-v0.2.2-rc.3`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3) was published on 2026-11-13, but DS-Bot still pins `dsh-v0.2.2-rc.1`; this audit makes no behavioural claim about rc.3. The current [MCP specification line](https://modelcontextprotocol.io/specification/2026-07-28) was `2026-07-28` on the audit date, while DS-Bot's handwritten loopback server still advertises `2025-03-26`. SDK upgrades and DSH upgrades must remain separate pinned compatibility changes.

## DS-Bot's runtime boundary

DS-Bot already declares DSH as the execution authority in its architecture and runtime design. The separate AI-OS draft read during this audit (`DS-Bot-ai-os/ARCHITECTURE_DECISIONS.md`, ADR-001 and ADR-002) states the same boundary explicitly: model calls, tool calls, step boundaries, cancellation, compaction and Session replay remain DSH responsibilities; DS-Bot owns Bot identity, teams, rooms, handoffs and memory semantics. That directly rules out embedding any inspected loop as a second runtime. The current DS-Bot branch predates that ADR file, so the conclusion is grounded in the checked-in product architecture and source below rather than treating the draft as already merged.

DSH's loop is a turn/step state machine over a Session: it owns one phase and AbortController per activity, accepts `followup`, `steer`, `inject` and `cancel`, executes a tool batch, and ends a turn only when no tool continuation or pending input remains. See [`agent.ts:170-197`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/src/agent.ts#L170-L197), [`agent.ts:327-432`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/src/agent.ts#L327-L432) and [`agent.ts:435-609`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/src/agent.ts#L435-L609).

The tool path snapshots JSON arguments, freezes them, runs ordered pre-execute approval/guards, supports abort/denial results, and records durable `tool/call` and `tool/result` events. See [`pipeline.ts:130-229`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/pipeline.ts#L130-L229) and [`batch.ts:236-283`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/batch.ts#L236-L283).

DSH already has the hard parts DS-Bot must not duplicate:

- **Approval:** fail-closed when no approval channel exists, with turn-enclosed audit events ([`user-approval/src/index.ts:242-332`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/interaction/user-approval/src/index.ts#L242-L332)).
- **Sandboxing:** `read-only`, `workspace-write` and `danger-full-access`; local runners use bwrap/Landlock on Linux, Seatbelt on macOS and an ACL restricted token on Windows, and fail closed when confinement is unavailable ([`sandbox-policy/src/index.ts:134-215`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/sandbox/sandbox-policy/src/index.ts#L134-L215), [`profiles.ts:16-59`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/sandbox/sandbox-local/src/profiles.ts#L16-L59)).
- **Compaction:** pressure triggers, a retained tail, anti-growth refusal, a summary event and an atomic surface replacement; failed summaries do not overwrite the input ([`compaction-basic/src/index.ts:142-175`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/compaction/compaction-basic/src/index.ts#L142-L175), [`region.ts:385-422`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/compaction/compaction-basic/src/region.ts#L385-L422), [`region.ts:470-521`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/compaction/compaction-basic/src/region.ts#L470-L521)).
- **Resume:** an interrupted open turn receives a durable interrupted close; an accepted tool call without a result becomes `TOOL_OUTCOME_UNKNOWN`, while an unstarted call becomes `TOOL_NOT_STARTED` ([`resume.spec.ts:514-575`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/tests/resume.spec.ts#L514-L575), [`resume.spec.ts:1046-1112`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/tests/resume.spec.ts#L1046-L1112)).
- **MCP client:** the pinned DSH package already depends on the official SDK and has atomic tool-generation swaps, bounded reconnect, stale-tool removal and tests that change the advertised tool list after reconnect ([`mcp-client/package.json`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/package.json), [`tools.ts:113-161`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/src/tools.ts#L113-L161), [`connection.ts:211-245`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/src/connection.ts#L211-L245), [`reconnect.spec.ts:183-240`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/tests/reconnect.spec.ts#L183-L240)).

## Cross-runtime comparison

| Concern | Hermes Agent | OpenCode | Pi | Goose | DSH / DS-Bot decision |
|---|---|---|---|---|---|
| Loop and termination | Explicit iteration budget plus retry/compression backstops; tool-call or final text ends a step ([`conversation_loop.py:1751-1805`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/agent/conversation_loop.py#L1751-L1805)). | `drain` loops steps until no continuation; max-step fallback injects a text-only instruction ([`llm.ts:63-225`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/runner/llm.ts#L63-L225), [`max-steps.ts:1-16`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/runner/max-steps.ts#L1-L16)). | Generic loop continues while tool calls, steering or follow-ups exist; stop reasons include error/aborted/length ([`agent-loop.ts:172-330`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/agent/src/agent-loop.ts#L172-L330)). | Explicit ordered operation state machine with `Continuing`, `Yielded`, `Cancelled`; max-turn operation yields a user prompt ([`machine.rs:154-247`](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose-agent/src/machine.rs#L154-L247), [`ops_maxturns.rs:53-67`](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose/src/agents/state_machine/ops_maxturns.rs#L53-L67)). | DSH owns the loop. Do not add a parallel loop. |
| Tool selection | Sequential/parallel batches, duplicate/stall guardrails, subagent/search caps ([`tool_executor.py:1-7`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/agent/tool_executor.py#L1-L7), [`tool_guardrails.py:249-309`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/agent/tool_guardrails.py#L249-L309)). | Registry snapshot filters wholly denied tools before model exposure; MCP calls check permission per invocation ([`tool.ts:254-324`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/tool.ts#L254-L324), [`tool/mcp.ts:53-76`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/tool/mcp.ts#L53-L76)). | `beforeToolCall` hook validates/block; direct core has no sandbox or permission engine ([`agent-loop.ts:718-787`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/agent/src/agent-loop.ts#L718-L787), [`agent-session.ts:713-741`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/agent-session.ts#L713-L741)). | State-machine tools, approval and execution effects are separate operations ([`tool_approval.rs:94-130`](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose-agent/src/tool_approval.rs#L94-L130)). | DSH `tools/pre-execute`, guards, approvals and executor already provide the seam. |
| Permissions and isolation | Approval is in-process heuristic; only OS-level isolation is treated as a security boundary ([`SECURITY.md`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/SECURITY.md)); deny rules and hardline blocks survive yolo ([`approval.py:1215-1243`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/tools/approval.py#L1215-L1243)). | Rule engine: configured deny wins, then saved rules, default ask; unattended requests fail closed; no OS sandbox ([`permission.ts:94-104`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/permission.ts#L94-L104), [`permission.ts:169-209`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/permission.ts#L169-L209), [`SECURITY.md`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/SECURITY.md)). | Core has no permission layer; coding-agent provides an example extension, tool allow/deny lists and project trust ([`permission-gate.ts`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/examples/extensions/permission-gate.ts), [`agent-session.ts:295-302`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/agent-session.ts#L295-L302), [`SECURITY.md`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/SECURITY.md)). | Persistent allow/ask/deny policy, human confirmation, scanner/classifier, optional Docker execution; default local shell is not a sandbox ([`config/permission.rs:18-33`](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose/src/config/permission.rs#L18-L33), [`SECURITY.md`](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/SECURITY.md)). | DSH has the strongest actual isolation surface; DS-Bot should consume it rather than reproduce permission logic. |
| Compaction | Summarises into a checkpoint, supports in-place archive or parent-child rotation, requires a durable checkpoint optionally, and works hard around retries/timeouts ([`conversation_compression.py:3958-4063`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/agent/conversation_compression.py#L3958-L4063), [`conversation_compression.py:3546-3590`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/agent/conversation_compression.py#L3546-L3590)). | Background precompute, token reserve, retained tail, structured summary, native provider compaction and overflow retry ([`compaction.ts:42-49`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/compaction.ts#L42-L49), [`compaction.ts:301-365`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/compaction.ts#L301-L365)). | Reserve 16,384 tokens, keep 20,000 recent tokens, split an in-progress turn and merge two summaries ([`compaction.ts:120-130`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/compaction/compaction.ts#L120-L130), [`compaction.ts:926-1056`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/compaction/compaction.ts#L926-L1056)). | In-process compaction rewrites visibility, carries one current turn context and structured summary ([`context_mgmt/mod.rs:95-254`](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose/src/context_mgmt/mod.rs#L95-L254)). | DSH compaction is already what DS-Bot invokes; reuse the presented checkpoint/anti-growth ideas only as test expectations. |
| Persistence and recovery | SQLite messages with `active`/`compacted` flags, session lineage, dedicated child DB connections ([`hermes_state_common.py:485-558`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/hermes_state_common.py#L485-L558), [`delegate_tool.py:124-153`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/tools/delegate_tool.py#L124-L153)). | SQLite message log, completed-compaction boundary, durable orphan claims and per-turn resume budget ([`history.ts:28-54`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/history.ts#L28-L54), [`restart.ts:24-64`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/execution/restart.ts#L24-L64), [`restart.ts:95-116`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/execution/restart.ts#L95-L116)). | Append-only session JSONL with parent links and compaction entries; experimental durable package adds outbox/task graph recovery ([`session-manager.ts:41-105`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/session-manager.ts#L41-L105), [`durable/README.md`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/durable/README.md)). | SQLite sessions/messages/usage; explicit interrupted tool responses on cancellation ([`session_manager.rs:1172-1247`](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose/src/session/session_manager.rs#L1172-L1247), [`machine.rs:74-87`](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose-agent/src/machine.rs#L74-L87)). | DSH JSONL persistence and resume semantics are already the source of truth. |
| Subtasks | Parent-linked child sessions, dedicated DB handles, interrupt propagation, guards against runaway delegation ([`delegate_tool.py:110-117`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/tools/delegate_tool.py#L110-L117), [`tool_guardrails.py:285-309`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/agent/tool_guardrails.py#L285-L309)). | Background child session, depth limit, permission gate, durable subagent job and restart recovery ([`subagent.ts:119-145`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/tool/plugin/subagent.ts#L119-L145), [`subagent-job.ts:17-40`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/subagent-job.ts#L17-L40)). | Core does not own subagents; durable package documents task-owned conversations and a restart-safe background-child example ([`durable/README.md`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/durable/README.md)). | Parent-linked child Session, foreground runner and cancellation token ([`subagent_handler.rs:32-121`](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose/src/agents/subagent_handler.rs#L32-L121)). | DS-Bot already models handoffs and deliberately disables DSH subagents; do not import a second subagent system. |
| Model abstraction | Many provider adapters behind an OpenAI-shaped agent boundary with retries, fallbacks and native Anthropic support ([`agent_init.py:322-409`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/agent/agent_init.py#L322-L409)). | Dedicated `pi-ai` protocol/provider tree with streamed canonical events and provider-specific adapters ([`packages/ai/src/llm.ts:79-151`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/ai/src/llm.ts#L79-L151)). | `pi-ai` owns models and providers; agent loop injects a `StreamFn` and model metadata ([`types.ts:344-410`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/agent/src/types.ts#L344-L410)). | Generic `Provider` trait with streaming, completion, resume, model inventory and context limits ([`base.rs:529-604`](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose-provider-types/src/base.rs#L529-L604)). | DSH selects models and calls adapters; DS-Bot may compare policies but must not route through a second provider stack. |

## Per-runtime findings and reuse verdict

### Hermes Agent

**What is reusable as a pattern:** tool-call fingerprinting, repeated-failure/no-progress breaking, hardline deny floors that survive “yolo”, durable pre-compaction checkpoints, and session lineage across compaction. These are excellent adversarial tests and guardrail ideas for DSH/DS-Bot capability packs.

**What is not directly reusable:** the runtime is a large Python personal-agent product. Its core project declares Python `>=3.11,<3.15`, 45 base dependencies and 58 optional extras; the agent loop is coupled to CLI/gateway/desktop state, provider fallbacks, memory and compression services. A direct import or extraction would pull an entire execution model into a Node/DSH product.

**Maintenance and security:** active daily canary releases and a push on the audit date. The security policy is explicit that approvals and scanners are not containment and that OS-level isolation is the only boundary ([`SECURITY.md`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/SECURITY.md)). MIT is compatible with DS-Bot Apache-2.0, but copying source still requires preserving the copyright/permission notice.

**Verdict:** pattern-only, D class. Reject as a second runtime.

### OpenCode

**What is reusable as a pattern:** the layered permission evaluator (configured deny → saved allow → default ask), tool-generation swap that fetches the next registry before disposing the old one, per-session provider/tool snapshots, and durable orphaned-turn recovery with a per-turn attempt budget.

Its MCP adapter is the most directly relevant reference: it uses the official SDK server/client types and `createMcpHandler` in its HTTP fixture, registers tools with `McpServer.registerTool`, carries session metadata through `_meta`, and keeps MCP permission checks in the ordinary tool pipeline ([`fixture/mcp-echo.ts:1-14`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/test/fixture/mcp-echo.ts#L1-L14), [`tool/mcp.ts:53-76`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/tool/mcp.ts#L53-L76), [`tests/mcp-attach.test.ts:56-72`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/test/mcp-attach.test.ts#L56-L72)). This is a usage example for the SDK, not code DS-Bot needs to copy.

**What is not directly reusable:** it is an Effect-based TypeScript runtime with its own SQLite world, process daemon, TUI, provider stack and Bun-first tooling. Its core package has 38 runtime dependencies and 1,721 test/spec files in the checkout. Its security policy explicitly says permissions are UX, not a sandbox.

**Maintenance:** v2.3.0 released 2026-11-13; repository pushed 2026-11-16. MIT, with subpackage MIT licences; extract only after a separate legal review and an adapter boundary.

**Verdict:** D class for permission/registry/recovery patterns; B class only for the official SDK example, not an OpenCode import. Reject as a second runtime.

### Pi (`earendil-works/pi`, formerly `badlogic/pi-mono`)

**What is reusable as a pattern:** the agent package is impressively small (two direct runtime dependencies), exposes `beforeToolCall`/`afterToolCall`, `prepareNextTurn`, steering/follow-up queues and explicit stop reasons. That makes it a good source of lifecycle test cases. Its durable package documents durable submissions, outboxes, task graphs, child tasks and restart-safe subagents.

**What is not directly reusable:** the small loop has no built-in permission or sandbox boundary. Permission is an example extension, and the security policy explicitly excludes local execution and sandboxing. The durable package labels itself **Experimental**, changes API without notice, and owns a different persistence/runtime model. Its coding-agent core separately has 22 direct dependencies and requires Node `>=22.19.0`.

**Compaction signal:** it keeps 20,000 recent tokens, reserves 16,384 tokens and splits an in-progress turn when the cut point crosses it; those are concrete test scenarios, not a justification to replace DSH compaction.

**Maintenance:** v1.5.2 released 2026-11-10; repository pushed 2026-11-15. MIT. The package includes third-party notice files for MCP/schema dependencies, so source extraction would require carrying those notices into DS-Bot's notice ledger.

**Verdict:** D class for hook and durable-recovery patterns; no direct package reuse in the MCP slice. Reject as a second runtime.

### Goose

**What is reusable as a pattern:** the explicit ordered state machine is the cleanest audit-oriented loop of the five. Each operation returns `NotApplicable`, `Applied` with a `RunStatus`, or an error; cancellation selects the active operation, finalizes it, synthesizes interrupted tool responses, then persists the session. Its max-turn operation yields a user-facing continuation decision rather than silently looping.

Its safety stack is also useful as a test vocabulary: persistent allow/ask/never policy, per-call human confirmation, a permission judge/scanner with egress and adversarial inspection, and optional Docker placement. But the default local shell path is not a complete sandbox; the security policy recommends a VM/container and human confirmation.

**What is not directly reusable:** Rust service/runtime with a 138-direct-dependency `goose` crate, SQLite session manager, MCP extension manager, providers and UI. It would be a second runtime and a second product architecture.

**Maintenance:** v1.59.1 released 2026-11-14; repository pushed 2026-11-16; 370 Rust files contain test attributes in the checkout. Apache-2.0 is compatible, but any copied code would need licence/NOTICE analysis.

**Verdict:** D class for explicit state-machine and cancellation semantics. Reject as a second runtime.

## Reuse ranking

### 1. B-class: adopt the official MCP SDK server transport (recommended)

Use `@modelcontextprotocol/server@2.4.0` plus `@modelcontextprotocol/node` for DS-Bot's loopback server. The official v2 SDK implements the 2026-07-28 MCP revision and explicitly defaults to a stateless legacy fallback unless configured with `legacy: 'reject'` ([SDK README](https://github.com/modelcontextprotocol/typescript-sdk/blob/951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5/README.md#L4-L7), [`createMcpHandler.ts:639-760`](https://github.com/modelcontextprotocol/typescript-sdk/blob/951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5/packages/server/src/server/createMcpHandler.ts#L639-L760)). The Node adapter has exactly the required loopback HTTP path and host/origin guards ([Node README](https://github.com/modelcontextprotocol/typescript-sdk/blob/951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5/packages/middleware/node/README.md)).

This is a **protocol/library replacement**, not a runtime change. It should preserve `LoopbackMcp`'s constructor, `listen`, `failAll`, `close`, `token`, generated URL and `onCall` contract.

Concrete first slice:

1. Add `@modelcontextprotocol/server@2.4.0` and `@modelcontextprotocol/node@2.1.2`, the compatible v2 packages inspected with the existing client.
2. Keep one server per CLI session, bind only `127.0.0.1`, retain the random per-session bearer token, and add Host/Origin validation.
3. Register each current DS-Bot tool with `McpServer.registerTool`, mapping `onCall` to the SDK call context's `mcpReq.signal` so a transport cancellation reaches `failAll`/the adapter.
4. Let the SDK handle initialization, notifications, protocol-version validation, POST/GET/DELETE semantics, SSE framing and legacy fallback; do not hand-parse JSON-RPC.
5. Test: wrong bearer token, wrong Host/Origin, initialize, initialized notification, `tools/list`, `tools/call`, progress/EOF cancellation, unknown tool, server close during a call, DSH reconnect/tool-list drift, and one legacy client plus one modern client.
6. Keep `flattenSchema` as a compatibility adapter until each supported CLI's schema acceptance is covered by tests; do not change tool names or DSH authorization semantics in this slice.

Why this is the first drift slice: the repository already depends on `@modelcontextprotocol/client` 2.4.0 ([`package.json:74-80`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/package.json#L74-L80)), while `local-agents/mcp.js` hardcodes `2025-03-26`, accepts only POST, parses JSON itself, has no protocol-version validation or GET/DELETE/session lifecycle, and hand-writes SSE progress ([`mcp.js:1-9`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/local-agents/mcp.js#L1-L9), [`mcp.js:64-132`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/local-agents/mcp.js#L64-L132)). The current official spec is substantially stricter about Streamable HTTP, metadata and cancellation ([2026-07-28 transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) and [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)).

### 2. B-class: use the official MCP client already in DS-Bot

Keep `@modelcontextprotocol/client` and treat the DSH MCP bridge as the owner of reconnect/sync. DS-Bot should not build a second MCP client generation manager. DSH's client already has a downstream-facing bridge with bounded reconnect and atomic registration ([`connection.ts:127-177`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/src/connection.ts#L127-L177)).

### 3. C-class: extract a small schema/transport test helper only if the SDK gap is demonstrated

No schema normalizer from Hermes or OpenCode should be copied into production. If the SDK's JSON Schema path cannot accept a supported CLI's schema, add a narrow DS-Bot compatibility function with tests and a cited SDK gap. Until then, `flattenSchema` remains a local compatibility adapter.

### 4. D-class: borrow patterns, not modules

Ranked patterns worth turning into DS-Bot/DSH tests or small internal abstractions:

1. Hermes: identical-call/no-progress guardrails and durable pre-compaction checkpoint.
2. OpenCode: permission last-match precedence, atomic tool-generation swap, per-turn resume budget.
3. Goose: explicit operation result/status and cancellation finalization.
4. Pi: before/after tool hooks and split-turn compaction tests.
5. DSH: whatever already exists wins; add product-level observability and acceptance tests around it rather than copying another implementation.

### 5. A-class direct source reuse: reject

Do not copy an entire loop, session manager, permission engine, subagent manager, provider stack or durable scheduler from any of these projects. Those are all runtime authority. For the five audited runtimes the correct answer is **no A-class adoption** in this slice.

## Dependencies, licences and notice obligations

| Project | Dependency/profile signal | Licence and notice implication |
|---|---|---|
| Hermes | 45 base Python dependencies, 58 optional extras, Python `>=3.11,<3.15` | MIT root; preserve notice if extracting. Large transitive/runtime surface; avoid as a library. |
| OpenCode | Core package 38 direct dependencies; Bun-first monorepo | MIT root and subpackages; if adapting source, preserve the MIT notice. Prefer the upstream SDK example over copying. |
| Pi | Agent two direct deps; durable seven; coding-agent 22; Node `>=22.19.0` | MIT; `packages/mcp` and `packages/schema` ship third-party notice files. Carry those if extracting. Durable is experimental. |
| Goose | `goose` crate has 138 direct dependencies; Rust 2021 | Apache-2.0; compatible with DS-Bot, but copying code into DS-Bot's Apache-2.0 tree still requires attribution/notice review. |
| DSH | MIT; MCP client uses official `@modelcontextprotocol/client` 2.2.0 | MIT; do not fork or patch. Upgrade only through the pinned DSH release process. |
| MCP TypeScript SDK | Server/client v2.4.0; Node adapter v2.1.2 in the inspected monorepo | Apache-2.0 (with legacy MIT material); DS-Bot's Apache-2.0 root is compatible. Keep the package licence and add any required NOTICE material when distributing source-derived code. |

DS-Bot is Apache-2.0 ([`ds-bot/package.json:23`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/package.json#L23)). The repository's hard rule allows compatible licensed code only with source and notice updates; this note recommends SDK/API use, so the production dependency's own licence remains the primary obligation. Any source extraction from the audited runtimes would additionally require an entry in the repository's notice/ledger process.

## Security and maintenance assessment

- **Hermes:** very active; strong explicit trust model; default terminal backend is host execution, so approvals are not containment.
- **OpenCode:** very active; permission system is explicitly UX-only and not a sandbox.
- **Pi:** active; core intentionally has no sandbox, and project/extension trust is a user responsibility.
- **Goose:** active; has the broadest security inspection vocabulary, but recommends VM/container containment for real risk reduction.
- **DSH:** active pinned compatibility line; strongest available local sandbox and the only runtime DS-Bot should inherit.
- **MCP SDK:** v2 is the stable line implementing the current 2026-07-28 revision; v1 is on a six-month security-fix window after the v2 release. DS-Bot should not remain on a hand-written 2025-era protocol shim once the SDK path is tested.

## Explicit rejection

**Reject every result that would create a second Agent Runtime.** Do not embed Hermes, OpenCode, Pi, Goose, or a fork of DSH as DS-Bot's execution loop. Do not use their session stores as a shadow control plane, their permission engines as a second authorization authority, or their provider stacks as a second model route. The sole acceptable integration boundary is a protocol adapter or a DSH plugin service.

## Reusable takeaway

DSH remains the runtime and the source of truth. The first concrete reuse win is the official MCP SDK's server/client transport boundary, not an agent-runtime transplant. Use Hermes, OpenCode, Pi and Goose as adversarial pattern references for loop guards, approval precedence, compaction and recovery tests; reuse no runtime authority and do not create a second loop, session store, permission model or subagent system.

## Sources

### Official/upstream

- [MCP 2026-07-28 transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
- [MCP 2026-07-28 versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP TypeScript SDK v2 README](https://github.com/modelcontextprotocol/typescript-sdk/blob/951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5/README.md)
- [MCP Node adapter](https://github.com/modelcontextprotocol/typescript-sdk/blob/951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5/packages/middleware/node/README.md)
- [Hermes v0.23.1](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.1)
- [OpenCode v2.3.0](https://github.com/anomalyco/opencode/releases/tag/v2.3.0)
- [Pi v1.5.2](https://github.com/earendil-works/pi/releases/tag/v1.5.2)
- [Goose v1.59.1](https://github.com/aaif-goose/goose/releases/tag/v1.59.1)
- [DSH dsh-v0.2.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)

### Source-reference evidence

- Hermes [`conversation_loop.py`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/agent/conversation_loop.py), [`tool_guardrails.py`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/agent/tool_guardrails.py), [`session_persistence.py`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/agent/session_persistence.py), [`delegate_tool.py`](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/tools/delegate_tool.py).
- OpenCode [`llm.ts`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/runner/llm.ts), [`permission.ts`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/permission.ts), [`compaction.ts`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/compaction.ts), [`restart.ts`](https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/execution/restart.ts).
- Pi [`agent-loop.ts`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/agent/src/agent-loop.ts), [`compaction.ts`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/compaction/compaction.ts), [`session-manager.ts`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/session-manager.ts), [`durable/README.md`](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/durable/README.md).
- Goose [`machine.rs`](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose-agent/src/machine.rs), [`tool_approval.rs`](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose-agent/src/tool_approval.rs), [`session_manager.rs`](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose/src/session/session_manager.rs), [`context_mgmt/mod.rs`](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose/src/context_mgmt/mod.rs).
- DSH [`agent.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/agent-loop/src/agent.ts), [`pipeline.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/pipeline.ts), [`compaction-basic/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/compaction/compaction-basic/src/index.ts), [`mcp-client/src/connection.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/src/connection.ts).

### DS-Bot source and decision context

- [`ds-bot/src/host/local-agents/mcp.js`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/src/host/local-agents/mcp.js)
- [`ds-bot/package.json`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/ds-bot/package.json)
- [`docs/plans/2026-10-10-bot-runtime.md`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/docs/plans/2026-10-10-bot-runtime.md)
- [`docs/plans/2026-10-09-context-and-memory.md`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/docs/plans/2026-10-09-context-and-memory.md)
- [`docs/vision.md`](https://github.com/rml4791lol-lang/DS-Bot/blob/26228dfa1e52d536eda78a60936e5c0664e29e9c/docs/vision.md)

### Supplemental evidence

No third-party tutorials or blog summaries were used. Repository source, release metadata, licences and official specifications are the evidence base. Test counts are checkout measurements and were not re-run because this ticket is research-only.
