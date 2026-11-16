# Issue #25 research: DS-Bot tool, model, approval, and sandbox governance

Status: source-level research for the first MCP-drift vertical slice. This note is a reuse decision, not an implementation plan for a second runtime.

## Scope and evidence baseline

- Product baseline: DS-Bot `0.3.6`, commit `26228dfa1e52d536eda78a60936e5c0664e29e9c`.
- Runtime baseline: DeepSeek Harness (DSH) `0.2.2-rc.1`, commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`.
- MCP packages inspected in source: DSH's client uses `@modelcontextprotocol/client@2.2.0`; DS-Bot independently depends on `@modelcontextprotocol/client@2.4.0`. DS-Bot's local-agent bridge hand-writes MCP protocol `2025-03-26`.
- Evidence below comes from implementation, public types, default composition, and tests. README wording was not used as a contract.
- No real `~/.dsh`, `DSH_HOME`, credential store, cookie store, or user Session data was read.

## Outcome first

1. **Reuse DSH; do not create another tool, model, approval, or sandbox engine.** DSH's scoped `ToolsService`, official MCP client, skill registry, LLM adapter registry, token meter, approval service, permission presets, sandbox policy/provider, and append-only Session events already form the needed system contracts.
2. **DS-Bot's product layer is also reusable where it adapts rather than replaces those contracts.** Reuse capability persistence/mounting, per-Bot model state, Bot/group permission assignment, approval presentation, `usage.sqlite`, and scoped team tools.
3. **The real MCP drift is the local-agent loopback server and its SDK/version boundary.** [`ds-bot/src/host/local-agents/mcp.js`](../../../ds-bot/src/host/local-agents/mcp.js#L1-L8) implements a partial server by hand, while DSH's outbound client already uses the official SDK. Replace only this transport adapter with `@modelcontextprotocol/server@2.2.0` and keep DSH's tool registry and approval path authoritative.
4. **A V1 drift projection should read DSH's tool registry, not proxy MCP or retain a second inventory.** Observe `tools/change`, filter by the capability's `mcp__<serverName>__` namespace, hash schemas, and combine that evidence with DS-Bot's mount state. Never call a tool through the projection.
5. **Do not promise full post-ready MCP health in V1 with the pinned DSH.** The MCP client logs reconnect/give-up state but exposes no public lifecycle event to its parent plugin. The registry reveals tool additions/removals, but not the interval between a lost connection and reconnect exhaustion.
6. **Do not claim monetary cost.** DSH emits authoritative token usage and context pressure, not USD prices. DS-Bot's ledger aggregates tokens/calls by model. Price data and a display adapter are a separate concern.
7. **Do not call attached MCP capabilities portable across model-backed and local-agent Bots yet.** The local-agent bridge intentionally filters out everything except DS-Bot team tools and `approve_agent_action`, so a DS-Bot-managed capability can appear attached while its tools never cross the CLI bridge.

## Reuse table

| Capability                    | Authoritative decision point and public contract                                                                                                | Tests that pin the behavior                                                                                | Failure contract                                                                                                                                     | Reuse decision / drift                                                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model-visible tools           | DSH `ToolsService`: `ctx.tools.register`, `restrict`, `guard`, `schemas`, and step-scoped admission                                             | DSH `core/tools/tests/tools.spec.ts`, `scoped.spec.ts`; DS-Bot `scoped-tools-creation.test.js`             | Unknown/hidden calls become `UNKNOWN_TOOL`; activation failure is `TOOL_ACTIVATION_FAILED`; invalid output is `INVALID_TOOL_OUTPUT`                  | **Reuse directly.** DS-Bot should only register scoped tools and add guards/policy; it must not expose another tool registry.                                                                                         |
| MCP servers and MCP tools     | DSH `@deepseek-ai/dsh-mcp-client`, one plugin instance per server, registering `mcp__<server>__<tool>` definitions                              | DSH `mcp-client/tests/apply.spec.ts`, `reconnect.spec.ts`, `tool-definition.spec.ts`, e2e fixtures         | Startup can be strict; failed re-sync keeps last good generation; reconnect exhaustion unregisters tools; a disconnected server fails requests       | **Reuse directly.** DS-Bot's capability module already mounts this plugin per Bot Session. Keep server installation policy in DS-Bot, invocation/transport in DSH.                                                    |
| Local-agent MCP bridge        | `LocalAgentAdapter` creates one loopback HTTP MCP server per live CLI Session and translates MCP calls into DSH tool-call chunks                | `local-agents.test.js` MCP bridge and 401/list tests; `local-agents-loop.test.js` real DSH dispatch        | Abort/close fails pending calls; permission denial fails closed; dead bridge is recreated on the next turn                                           | **Replace implementation, retain role.** It is a transport adapter, not a registry. Current manual protocol is the main drift.                                                                                        |
| Skills                        | DSH `SkillRegistry`, filesystem provider, and `skill` tool; DS-Bot registers bundled/runtime providers                                          | DSH `skill`/`skill-filesystem` tests; DS-Bot `office-skills.test.js`, `capabilities.test.js`               | Provider failures make discovery incomplete; invalid files are skipped/logged; model invocation is denied unless policy allows                       | **Reuse directly.** DS-Bot's runtime capability skill uses `ctx.skills.register`; Office and goal skills use `registerProvider`. Their small custom frontmatter parsers are duplicate parsing, not a second registry. |
| Model providers and selection | DSH `LlmRuntime`: `registerAdapter`, `listProviders`, `listModels`, `resolveModelInfo`, `stream`; Session stores the selected route             | DSH LLM/default-model tests; DS-Bot `models.test.js`, `providers.test.js`, local-agent tests               | Missing route is `NO_ADAPTER`; adapter/stream failures become terminal failure chunks; DS-Bot retries only transient failures on the same route      | **Reuse directly.** Keep DS-Bot per-Bot catalog/selection state. “DeepSeek first” is currently a composition/default-model choice, not a hard router preference.                                                      |
| Usage and cost                | DSH token meter and `assistant/message.usage`; DS-Bot `usage.sqlite` projects token rows per Bot/model/use/hour                                 | DSH token-meter tests; DS-Bot `usage.test.js`, `usage-data.test.js`                                        | Missing usage yields no row; unreadable Sessions are skipped with a bounded warning; persistence failure must not break the turn                     | **Reuse token facts directly.** Keep DS-Bot projection. Monetary cost/pricing is absent and must not be inferred as billing.                                                                                          |
| Approval policy               | DSH `ApprovalService.request`, closed outcomes, `approval/asked` + `approval/decided` audit pair, Session `ask`/`never` policy                  | DSH approval tests; DS-Bot `group-status.test.js`, `local-agents-loop.test.js`, `approval-notices.test.js` | Missing/throwing answerer -> `unavailable`; `allowed-once` is the only grant; cancellation is distinct; callers fail closed                          | **Reuse directly.** DS-Bot is an answerer/presenter and races hidden-Session approval cards. Its in-memory pending list is not the audit trail.                                                                       |
| Permission presets            | DSH `PermissionPresetService` bundles sandbox mode + approval policy and writes canonical Session events                                        | DSH permission-preset tests; DS-Bot `permissions.test.js`, `permission-picker.test.js`                     | Invalid preset throws; unconfined executor is a composition error; persisted `auto` requires its live integration                                    | **Reuse directly for DSH Sessions.** DS-Bot stores which preset a Bot/group uses, then calls DSH's setter.                                                                                                            |
| Sandbox execution             | DSH `SandboxPolicyService.resolve` + `SandboxProvider.confine`; FS and shell consume the same per-call policy                                   | DSH sandbox policy/escalation/local backend tests; Bash/FS sandbox tests                                   | Missing usable backend throws `SANDBOX_UNAVAILABLE`; confinement never silently degrades to unconfined; explicit wider retry needs one-shot approval | **Reuse directly.** File effect policy only; network/process visibility are outside this vocabulary.                                                                                                                  |
| Audit and replay              | DSH append-only Session log: `tool/call`, `tool/result`, approval events, `sandbox/mode`, `permission/preset`, request headers, assistant usage | DSH Session/tool/approval/export tests; DS-Bot usage/diagnostics tests                                     | Event validation rejects malformed persisted data; observer failures are contained; log append failure is not converted into an unlogged decision    | **Reuse as system of record.** Add a read-only governance projection; do not use UI pending state as audit.                                                                                                           |

## Source contracts by capability

### 1. Tool registration and execution

- The central registry is `ctx.tools`. Registration is scoped, duplicate names in one layer fail, scoped registrations shadow globals, and the model-facing schema excludes execution/presentation callbacks. See [`packages/core/tools/src/index.ts:98-166`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/index.ts#L98-L166) and [`packages/core/tools/src/schema.ts:548-645`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/schema.ts#L548-L645).
- A tool has one canonical input schema, one mandatory lossless-JSON output schema/renderer, optional presentation, timeout, concurrency declaration, and execution identity/cancellation. The public contract is [`ToolDefinition`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/contracts.ts#L25-L165).
- Every native or PTC call reaches the same pipeline: snapshot arguments, extensible `tools/pre-execute`, approval for `ask`, monotonic guards, `tools/execute`, `tools/post-execute`, final validation, and contained `tools/result` observers. See [`pipeline.ts:184-233`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/pipeline.ts#L184-L233), [`pipeline.ts:288-325`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/pipeline.ts#L288-L325), and [`events.ts:1-56`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/events.ts#L1-L56).
- DS-Bot installs product modules in a deterministic order; privacy runs before tool hooks, and usage meters after request-rewriting listeners. See [`ds-bot/index.js:59-64`](../../../ds-bot/index.js#L59-L64).
- DS-Bot team tools are registered into each Bot Session's own scope, never globally. See [`ds-bot/src/host/tools.js:909-1042`](../../../ds-bot/src/host/tools.js#L909-L1042).
- **Visibility drift:** DSH `restrict()` masks inherited/global tools, not the viewing scope's own registrations. DS-Bot therefore combines restrictions with an assembly filter and an execution guard; on the pinned DSH, scoped tools may remain model-visible even when the guard blocks execution. See [`tools.js:1045-1063`](../../../ds-bot/src/host/tools.js#L1045-L1063), [`tools.js:1095-1147`](../../../ds-bot/src/host/tools.js#L1095-L1147), and [`tools.js:1176-1187`](../../../ds-bot/src/host/tools.js#L1176-L1187). Enforcement is sound; catalog hiding is best-effort.

### 2. MCP discovery, registration, invocation, and observation

- DS-Bot capability persistence stores `{kind: 'mcp'|'skill'|'pack'}`, validates the name intersection with MCP/skill names, and gates fresh stdio commands behind `approved: true`. HTTP MCP entries are persisted with `approved: true` immediately. See [`capabilities.js:90-136`](../../../ds-bot/src/host/capabilities.js#L90-L136).
- The Bot Session mounts the official DSH MCP plugin with the capability's exact `serverName`, transport, resolved secrets, and `failOnStartupError: true`. See [`capabilities.js:284-335`](../../../ds-bot/src/host/capabilities.js#L284-L335).
- **Local-agent capability gap:** the CLI bridge's `toolsFor` allowlist includes only `rt.teamTools` plus `approve_agent_action`; it excludes DSH MCP capability tools. See [`local-agents/index.js:109-113`](../../../ds-bot/src/host/local-agents/index.js#L109-L113). The CLI keeps its own MCP configuration instead, so the attached-capability result is not the same product contract on both route families.
- DSH MCP config exposes one stdio or Streamable HTTP server per plugin instance, with a unique `serverName`, bounded server instructions, per-call timeout, strict startup option, and reconnect policy. See [`packages/mcp/mcp-client/src/index.ts:49-176`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/src/index.ts#L49-L176).
- Tool discovery is two-phase: fetch/build a complete next generation, then swap registrations. A fetch failure keeps the previous generation; a registration conflict rolls back to zero tools for that server. Public names are `mcp__<serverName>__<normalized rawName>`. See [`tools.ts:67-161`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/src/tools.ts#L67-L161).
- MCP results are validated as MCP `CallToolResult`; `isError` becomes a DSH error result, structured content remains lossless, and image blocks use the durable attachment path. Task-required tools are refused because this bridge does not implement tasks. See [`tools.ts:225-313`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/src/tools.ts#L225-L313).
- MCP resources are a separate scoped service. It registers `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource` only while a scoped server provider exists. See [`mcp-resources/src/index.ts:20-126`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-resources/src/index.ts#L20-L126) and [`tools.ts:15-61`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-resources/src/tools.ts#L15-L61).
- Reconnect is bounded. On exhaustion DSH unregisters tools, but the public plugin ready result only covers initial activation. The parent has no public reconnect-state signal. See [`connection.ts:211-245`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/src/connection.ts#L211-L245) and [`connection.ts:345-360`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/src/connection.ts#L345-L360).
- DS-Bot's `ready`/`connecting`/`error` capability status reflects the initial mount and later explicit reconciliation, not subsequent MCP reconnect generations. See [`capabilities.js:222-250`](../../../ds-bot/src/host/capabilities.js#L222-L250).
- MCP SDK tool annotations are available in the official contract, but the pinned DSH bridge currently maps name/description/input/output/task requirement to `ToolDefinition`; it does not carry `annotations` into DSH governance. Compare [`mcp.ts:1029-1090`](https://github.com/modelcontextprotocol/typescript-sdk/blob/dd22ba25ddbe7cd8822e1fe9c738a974996a28f6/packages/server/src/server/mcp.ts#L1029-L1090) with [`mcp-client/src/tools.ts:124-142`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/src/tools.ts#L124-L142). V1 must not infer trust from MCP hints that DSH never received.

### 3. Skills

- `SkillRegistry` owns provider merge, scope shadowing, rank, invocation policy, caching, and full-body loading. Runtime skills are in the same registry; duplicates are first-wins. See [`skill/src/index.ts:27-100`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/skill/skill/src/index.ts#L27-L100) and [`skill/src/index.ts:345-618`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/skill/skill/src/index.ts#L345-L618).
- Filesystem roots have explicit precedence: project `.dsh/skills`, project `.agents/skills`, custom roots, user `.dsh/skills`, user `.agents/skills`, bundled. Invalid frontmatter or missing required fields are logged and skipped; failed roots produce an incomplete observation. See [`skill-filesystem/src/index.ts:35-88`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/skill/skill-filesystem/src/index.ts#L35-L88), [`skill-filesystem/src/index.ts:181-230`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/skill/skill-filesystem/src/index.ts#L181-L230), and [`skill-filesystem/src/index.ts:811-853`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/skill/skill-filesystem/src/index.ts#L811-L853).
- The model-facing `skill` tool resolves through the agent's registry view, checks model invocation before and after loading, and records the catalog in durable Session context. See [`tool-skill/src/index.ts:74-165`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/skill/tool-skill/src/index.ts#L74-L165).
- DS-Bot capability skills mount a runtime skill into the Bot's agent scope. Office and goal skills register providers. See [`capabilities.js:317-327`](../../../ds-bot/src/host/capabilities.js#L317-L327), [`office-skills.js:49-77`](../../../ds-bot/src/host/office-skills.js#L49-L77), and [`goal-skills.js:23-47`](../../../ds-bot/src/host/goal-skills.js#L23-L47).
- **Low-risk duplication:** Office and goal providers use small local frontmatter parsers. Preserve for packaged assets if tests stay strict; do not generalize them into a second skill subsystem.

### 4. Model providers, DeepSeek routing, fallback, and limits

- DSH's provider registry is `ctx.llm`. Adapter registration is all-or-nothing, routes are unique, and `GenerateOptions.provider` selects exactly one route. See [`llm/src/index.ts:202-306`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/llm/llm/src/index.ts#L202-L306) and [`llm/src/index.ts:393-484`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/llm/llm/src/index.ts#L393-L484).
- Exact model metadata is adapter-owned and normalized by DSH: context window, max output, input modalities, reasoning levels, tool-update mode, and system-prompt update mode. See [`types.ts:453-528`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/llm/llm/src/types.ts#L453-L528).
- The base composition defaults to `deepseek-official/deepseek-flash`; the pinned DeepSeek catalog advertises `deepseek-flash` and `deepseek-v4-pro`. See [`bundle/base/cordis.patch.yml:88-95`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/base/cordis.patch.yml#L88-L95) and [`llm-deepseek/src/models.ts:5-23`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/llm/llm-deepseek/src/models.ts#L5-L23).
- DS-Bot enumerates DSH providers/models, marks missing-key routes unusable, uses DSH's default when available, otherwise the first usable registration-order model, and persists each Bot's model choice through the Session controller. See [`models.js:173-275`](../../../ds-bot/src/host/models.js#L173-L275) and [`models.js:309-358`](../../../ds-bot/src/host/models.js#L309-L358).
- **“DeepSeek first” today:** the shipped profile default and DS-Bot's “profile default when usable” rule make DeepSeek the normal first choice. It is not a hard affinity or provider-fallback chain. If the selected route fails a request, DSH normal retry stays on that route; DS-Bot does not switch providers mid-request.
- Local-agent CLIs are DSH LLM routes through `ctx.llm.registerAdapter`, so the outer route contract remains central. See [`local-agents/index.js:116-143`](../../../ds-bot/src/host/local-agents/index.js#L116-L143).
- **Retry duplication:** DS-Bot implements a second retry loop only for auxiliary model calls that do not pass the agent loop's retry hook. It preserves the provider's DSH retry policy, but this remains a deliberate duplicated execution path and needs regression coverage on every DSH retry-contract upgrade. See [`models.js:62-99`](../../../ds-bot/src/host/models.js#L62-L99).
- **Provider limits:** context/output limits and stream-idle timeout are adapter/model metadata, not DS-Bot policy. DeepSeek defaults are 1,000,000 context, 256,000 output, and 300,000 ms idle timeout. See [`llm-deepseek/src/defaults.ts:1-10`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/llm/llm-deepseek/src/defaults.ts#L1-L10).

### 5. Usage and cost

- DSH's authoritative per-call token shape is disjoint uncached input, cache read, cache write, output, optional reasoning and total tokens. See [`llm/src/types.ts:175-196`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/llm/llm/src/types.ts#L175-L196).
- `assistant/message` carries usage with the assistant settlement; DSH folds it into `tokenUsage` and `contextPressure` projections. See [`session/src/types.ts:339-356`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/session/src/types.ts#L339-L356) and [`usage-projection.ts:77-144`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/llm/token-meter/src/usage-projection.ts#L77-L144).
- DS-Bot's `usage.sqlite` is a derived projection. It folds logged attempts, meters auxiliary streams, aggregates by Bot/model/use/hour, and deliberately survives missing/old logs by rescanning or warning. See [`usage.js:1-93`](../../../ds-bot/src/host/usage.js#L1-L93), [`usage.js:139-184`](../../../ds-bot/src/host/usage.js#L139-L184), and [`usage.js:615-652`](../../../ds-bot/src/host/usage.js#L615-L652).
- **No USD cost contract exists in this baseline.** DeepSeek request pricing here means visual-token pricing for context pressure, not money. Billing/price adoption must be provider-reported or based on an explicit official price table, kept separate from DSH token facts.

### 6. Approvals and permission presets

- Approval outcomes are closed: `allowed-once`, `rejected`, `cancelled`, `unavailable`. Grants are one-shot; missing or throwing answerers fail closed. See [`user-approval/src/types.ts:13-91`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/interaction/user-approval/src/types.ts#L13-L91) and [`user-approval/src/index.ts:224-333`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/interaction/user-approval/src/index.ts#L224-L333).
- Every request must be inside an open turn and durably appends a matched `approval/asked` / `approval/decided` pair. The Session policy is `ask` or `never`. See [`user-approval/src/index.ts:111-122`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/interaction/user-approval/src/index.ts#L111-L122) and [`user-approval/src/index.ts:242-260`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/interaction/user-approval/src/index.ts#L242-L260).
- Permission presets are a UI/product bundle over two independent knobs: `sandbox/mode` and `approval/policy`. A preset writes both canonical Session events; execution still reads the knob folds. See [`permission-presets/src/index.ts:57-67`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/interaction/permission-presets/src/index.ts#L57-L67) and [`permission-presets/src/index.ts:398-416`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/interaction/permission-presets/src/index.ts#L398-L416).
- DS-Bot stores a Bot/group preset choice, then applies DSH's preset to each relevant Session. See [`permissions.js:1-116`](../../../ds-bot/src/host/permissions.js#L1-L116).
- DS-Bot answers DSH approval waterfalls for Bot/group Sessions. For hidden group Sessions it is the visible answerer; for own chats it races DSH's card and withdraws the loser. See [`approvals.js:1-116`](../../../ds-bot/src/host/approvals.js#L1-L116).
- Local-agent permission prompts bridge through the `approve_agent_action` DSH tool and `ApprovalService.request`. See [`local-agents/index.js:166-197`](../../../ds-bot/src/host/local-agents/index.js#L166-L197).
- **Approval gaps:**
  - Capability approval gates only fresh stdio MCP command lines; HTTP MCP connections are auto-approved at save time ([`capabilities.js:107-124`](../../../ds-bot/src/host/capabilities.js#L107-L124)).
  - DSH approval is on-demand. It does not automatically ask for every MCP tool call. Unless a `tools/pre-execute` policy or sandbox escalation produces `ask`, the call runs under ordinary tool policy.
  - A local CLI may enforce its own permission decisions. DS-Bot passes a mapped mode and bridges prompts, but that is not proof that every CLI action traversed DSH approval.

### 7. Sandbox boundary

- DSH's sandbox vocabulary covers subprocess file effects only: `read-only`, `workspace-write`, `danger-full-access`. Network and process visibility are explicitly outside it. See [`sandbox/src/index.ts:24-32`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/sandbox/sandbox/src/index.ts#L24-L32).
- `SandboxPolicyService.resolve` chooses approved per-call override > Session mode > deployment default, and stamps the Session cwd/root. See [`sandbox-policy/src/index.ts:188-214`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/sandbox/sandbox-policy/src/index.ts#L188-L214).
- FS sandbox is a trusted-code path fence, not a kernel boundary, and accepts a narrowly rechecked TOCTOU window. Shell confinement is the kernel-grade path. See [`fs-sandbox/src/index.ts:1-24`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/fs/fs-sandbox/src/index.ts#L1-L24) and [`bash-sandbox/src/index.ts:29-103`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/shell/bash-sandbox/src/index.ts#L29-L103).
- Missing confinement fails closed with `SANDBOX_UNAVAILABLE`; the provider must not silently run unconfined. See [`sandbox/src/index.ts:126-193`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/sandbox/sandbox/src/index.ts#L126-L193).
- Sandbox escalation validates that the target is strictly wider, requires justification, asks through the one-shot approval service, and fails closed. See [`sandbox/src/escalation.ts:162-205`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/sandbox/sandbox/src/escalation.ts#L162-L205).
- **Local-agent boundary drift:** DS-Bot maps DSH preset names to each CLI's own flags. Codex receives `sandbox` + `approvalPolicy`; Claude receives a permission mode; ACP may keep its own mode when no advertised mode matches. See [`engines.js:76-91`](../../../ds-bot/src/host/local-agents/engines.js#L76-L91), [`codex.js:121-134`](../../../ds-bot/src/host/local-agents/codex.js#L121-L134), and [`claude.js:136-160`](../../../ds-bot/src/host/local-agents/claude.js#L136-L160). This is policy translation, not DSH sandbox enforcement.
- **Private Bots are not a sandbox.** DS-Bot's privacy layer checks known tool arguments and paths, but explicitly states a shell can still reach anything the OS account can. See [`privacy.js:1-4`](../../../ds-bot/src/host/privacy.js#L1-L4) and [`privacy.js:298-305`](../../../ds-bot/src/host/privacy.js#L298-L305). Preserve as product separation; do not describe it as the sandbox boundary.

### 8. Audit and replay

- The Session JSONL is the authoritative append-only log. Tool calls record raw model arguments; tool results record model content, structured failure identity, and tool-private replayable `meta`. See [`session/src/types.ts:287-402`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/session/src/types.ts#L287-L402).
- The tool batch starts `tool/call` before dispatch and commits `tool/result` after settlement, with `callId` as the join key. See [`tools/src/batch.ts:236-266`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/batch.ts#L236-L266).
- Approval audit exists independently as paired `approval/asked`/`approval/decided`; sandbox and preset switches are also durable Session events. A governance view can join by `agent.session.id`, turn/step, `callId`, and approval request id.
- DSH session export can serialize the full log and referenced media. See [`session-log-export/src/archive.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/session-query/session-log-export/src/archive.ts).
- **Audit gap:** DS-Bot's pending approval map and capability `ready` status are UI state, not system-of-record events. MCP reconnect failures are logger events, not correlated Session governance records. A product-level read model is needed for a clear timeline.

## Bypass and duplicate-path register

| Severity           | Path                                                                          | Why it drifts                                                                                                    | Required treatment                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High               | [`local-agents/mcp.js`](../../../ds-bot/src/host/local-agents/mcp.js#L1-L140) | Hand-written JSON-RPC/SSE, protocol `2025-03-26`, partial method support, custom flattening/progress/cancel/auth | Replace with official server SDK; keep only DS-Bot tool-call bridge and bearer policy.                                                                     |
| High               | MCP SDK versions                                                              | DS-Bot client `2.4.0`; DSH client/server line `2.2.0`; handwritten server is a third implementation              | Coordinate one tested line. Under the no-DSH-patch rule, use `2.2.0` for the first slice or make an explicit coordinated DSH upgrade its own prerequisite. |
| High               | Local-agent native permissions                                                | DSH preset is translated to CLI-specific modes; some ACP agents may keep their own unmatched mode                | Report native mode/enforcement separately; never label the DSH preset as proof of the CLI's effective sandbox.                                             |
| Medium             | MCP lifecycle observation                                                     | DSH does not expose reconnect/give-up state to the capability parent                                             | V1 projects registry inventory and call outcomes; defer “connecting/live health” until DSH publishes a public lifecycle fact.                              |
| Medium             | MCP tool annotations                                                          | Official MCP annotations are discarded by the current bridge                                                     | Do not claim risk classification from them. If policy needs them, add an explicit DSH contract rather than parsing a second registry.                      |
| Medium             | Scoped visibility masking                                                     | `restrict()` cannot mask same-scope registrations; DS-Bot relies on assembly filtering plus an execution guard   | Treat execution guard as enforcement; model-visible catalog cleanliness needs a DSH-supported scoped visibility API or acceptance.                         |
| Medium             | HTTP MCP install approval                                                     | HTTP entries are auto-approved; no per-call `ask` is generated by default                                        | Decide whether external MCP calls are ordinary tools or a required approval class. Do not silently infer safety from transport.                            |
| Low                | Auxiliary LLM retry                                                           | DS-Bot reimplements retry for calls outside the agent loop                                                       | Keep policy sourced from `ctx.llm.providerRetryPolicy`; test on every DSH upgrade.                                                                         |
| Low                | Bundled skill parsing                                                         | DS-Bot Office/goal providers use local frontmatter parsers                                                       | Keep bounded to packaged assets; all discovery/loading remains `ctx.skills`.                                                                               |
| Documentation risk | Private Bots as “isolation”                                                   | It is a product-level cross-Bot fence, not an OS sandbox                                                         | Preserve the explicit limitation; never surface it as sandbox enforcement.                                                                                 |

## First MCP-drift vertical slice

### Reuse

- Reuse the existing DS-Bot capability lifecycle (`capabilities.js`) and per-Bot mount identity.
- Reuse DSH's official MCP client for outbound MCP.
- Reuse DSH's `ctx.tools` schemas as the only tool inventory.
- Reuse `LocalAgentAdapter.live.pending`, `toolsFor`, and the current DSH tool-call/finish mapping.
- Reuse existing approval, session, and usage events unchanged.

### Replace

Replace only [`LoopbackMcp`](../../../ds-bot/src/host/local-agents/mcp.js#L30-L140) with an official SDK transport:

- `McpServer` from `@modelcontextprotocol/server@2.2.0`.
- `fromJsonSchema()` for each current DSH `ToolSchema.parameters`; do not hand-flatten unions/refs.
- `registerTool()` callbacks that bridge to `adapter.ensureMcp()` exactly as today.
- `RegisteredTool.update/remove` or a complete server-generation swap to reconcile the current turn's tools; announce list changes via the SDK.
- `NodeStreamableHTTPServerTransport` at `127.0.0.1`, with stateful mode if the official client requires session continuity.
- Keep the existing 32-byte per-live-Session bearer token and reject before transport dispatch. Add localhost Host/Origin validation.
- Let the SDK negotiate protocol versions; do not hard-code `2025-03-26`.
- Map DSH result text/`isError` 1:1; no new tool execution path.
- Honor request cancellation/abort and stop/fail pending calls when the live CLI Session closes.
- Send progress only through the request-scoped official SDK context; do not hand-roll JSON-RPC SSE frames.

The official SDK contract confirms `McpServer.registerTool`, dynamic registered-tool update/removal, JSON-Schema adapters, tools/call input/output validation, Streamable HTTP transport, and Node conversion. See [`typescript-sdk@dd22ba2:packages/server/src/server/mcp.ts:L880-L1090`](https://github.com/modelcontextprotocol/typescript-sdk/blob/dd22ba25ddbe7cd8822e1fe9c738a974996a28f6/packages/server/src/server/mcp.ts#L880-L1090), [`typescript-sdk@dd22ba2:packages/server/src/fromJsonSchema.ts:L1-L9`](https://github.com/modelcontextprotocol/typescript-sdk/blob/dd22ba25ddbe7cd8822e1fe9c738a974996a28f6/packages/server/src/fromJsonSchema.ts#L1-L9), and [`typescript-sdk@dd22ba2:packages/middleware/node/src/streamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/dd22ba25ddbe7cd8822e1fe9c738a974996a28f6/packages/middleware/node/src/streamableHttp.ts).

### Add a read-only drift projection

The V1 product value is not a second registry. It is a derived snapshot that makes DSH registry drift visible to DS-Bot and the Control Center:

```ts
interface McpToolFact {
  publicName: string;
  schemaHash: string;
  descriptionHash: string;
}

interface McpGovernanceSnapshot {
  schemaVersion: 1;
  botId: string;
  sessionId: string;
  capability: {
    name: string;
    transport: "stdio" | "streamable-http";
    configHash: string;
  };
  mountState: "needs-approval" | "connecting" | "ready" | "error";
  inventory: {
    observedAt: number;
    tools: McpToolFact[];
    /** Hash over sorted (publicName, schemaHash, descriptionHash). */
    revision: string;
  };
  lastError?: {
    code: string;
    message: string;
    sessionSeq?: number;
  };
}
```

## Minimum V1 integration contract

1. **One execution authority.** Tools are invoked only through DSH `ctx.tools`/agent loop. The drift projection, settings UI, and Control Center never call MCP or a tool body directly.
2. **One inventory source.** `inventory.tools` is derived from `ctx.tools.schemas(agent)` filtered to `mcp__<serverName>__`. It is refreshed on `tools/change`; it is not persisted as a competing registry.
3. **Stable identity.** Public tool name is the stable key. Schema and description hashes are computed from the exact DSH-visible schema. Raw MCP names remain wire data and are not parsed back from normalized public names.
4. **Mount identity.** `capability.configHash` hashes the resolved non-secret DSH MCP config (serverName, transport, command/args or URL, reconnect/timeout policy). Secret values are never included or returned.
5. **State semantics.** `needs-approval`, `connecting`, and `error` come from DS-Bot's mount lifecycle. `ready` means initial mount succeeded. A later inventory delta means `ready + drifted`; it must not automatically mean “reconnected” or “healthy.” Missing tools after DSH's reconnect cap can be reported as `inventory-empty/last-known` with a limitation code.
6. **Approval semantics.** Approval remains DSH `allowed-once|rejected|cancelled|unavailable`. DS-Bot may surface and answer a pending request, but must not keep an independent grant. Installation approval and per-call approval are separate facts.
7. **Audit join.** The projection includes references, not copied authority: `{ sessionId, turn, step, callId, approvalRequestId?, sessionSeq? }`. `tool/call` + `tool/result` + approval events are the audit evidence.
8. **Failure semantics.** Invalid config/startup returns a redacted, bounded error. Startup failure is strict. Re-sync failure keeps the previous DSH generation. Reconnect exhaustion removes tools. The projection must preserve `last-known` separately from `current` rather than inventing continuity.
9. **Secret boundary.** Resolve `$DSH_SECRET_*` only at mount time; never place values in `configHash`, status, logs, snapshots, Session events, or the Control Center.
10. **Cross-route parity.** If a capability is shown as attached to a local-agent Bot, its permitted DSH MCP tools either cross the loopback bridge through the same `ToolsService` path or the UI/status explicitly says that route cannot serve them. Do not make attachment state route-dependent without surfacing it.
11. **Version gate.** The loopback server and DSH client must use one tested MCP SDK line. The current CI contract must pin that line and fail on mixed major/minor contracts or a protocol-version regression.

## Acceptance tests for V1

1. Official SDK negotiation succeeds with the pinned host; no hard-coded `2025-03-26` response remains.
2. Bearer absence/wrong token returns 401 before MCP dispatch; valid token is session-bound.
3. `tools/list` contains exactly the current DSH tool schemas, including union/ref-rich schemas, without flattening.
4. Add/remove/reconfigure a tool between turns reconciles the server inventory and emits the correct list-changed behavior.
5. A bridged `tools/call` becomes a DSH `tool/call`, runs through `ToolsService`, and returns the exact `tool/result` text/error.
6. Approval-required calls reach DSH approval; rejection/cancellation/unavailable never execute the tool.
7. Abort and Session close fail all pending bridge calls and leave no server, timer, or token behind.
8. `tools/change` plus the `mcp__<name>__` filter produces deterministic inventory revisions and detects schema/description drift.
9. Failed re-sync preserves last-good DSH tools; reconnect exhaustion produces an explicit “tools removed” observation, not a false live-health claim.
10. A model-backed Bot and a local-agent Bot with the same attached MCP capability have explicit, tested parity: either the same permitted tool identity is callable through DSH, or the route reports it as unsupported.
11. No secret appears in config hashes, status snapshots, logs, errors, or tests.
12. DSH's SDK version, DS-Bot's SDK version, package lock, and protocol tests are checked in CI.
13. Existing DS-Bot gates remain green: `npm test`, `node scripts/build-client.mjs --check`, `npm run lint`, and the local-agent MCP integration tests.

## Blockers and uncertainty flags

- **DSH lifecycle visibility:** there is no public parent-facing MCP reconnect/give-up event in `0.2.2-rc.1`. Do not work around this by inspecting DSH internals or patching DSH. Either limit V1 to registry drift/call evidence or land a documented DSH interface first.
- **SDK line decision:** DS-Bot's client `2.4.0` and DSH's client/server `2.2.0` are a real contract split. The safe V1 choice is the DSH-pinned `2.2.0` line unless the maintainer explicitly coordinates a DSH upgrade.
- **Approval classification:** DSH has an approval mechanism, but no generic risk taxonomy that auto-prompts every external or MCP call. Adding such a policy is product policy, not transport migration.
- **Monetary cost:** no authoritative price/billing field exists in the inspected runtime. Keep token usage and USD cost visibly separate.
- **Local-agent native enforcement:** each CLI keeps its own sandbox/permission semantics. A DSH preset is only a mapped request; effective CLI policy must be reported separately.
