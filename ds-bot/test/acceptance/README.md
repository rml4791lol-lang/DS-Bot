# Reality Gate acceptance harness

`npm run test:acceptance` runs one deterministic Chief–Forge–Prism scenario through
the production DSH AgentLoop and writes `reality-gate-evidence.json` beside this file.
A successful run has outcome `agentloop-verified`, not `component-verified`.

What is real in the run:

- `@deepseek-ai/dsh-agent-loop-testkit` creates the production DSH Agents and
  AgentLoop drivers; tool dispatch, Session events, Inbox delivery and recovery are
  real DSH behavior;
- `@deepseek-ai/dsh-session-persistence-jsonl` stores every Agent Session under one
  temporary `DSH_HOME`;
- the DS Bot runtime runs the normal `group_goal` and `message_bot` paths: Chief
  starts and coordinates the goal, Forge repairs the isolated worktree, and Prism
  reviews it after a host restart;
- Forge and Prism perform their work through real DSH tool calls, including the
  actual diff, MCP inventory, targeted tests and no-DSH-patch checks;
- two separate OS child processes use that same temporary `DSH_HOME`. The first is
  terminated after Forge's durable result and before Prism starts. The second resumes
  the same Prism task/attempt, receives the handoff exactly once, and completes the
  goal only after every typed check is verified;
- the no-patch check compares the run's start and end state for the pinned DSH install
  tree and any discovered shared DSH checkout, including tracked and untracked files.

What is deterministic:

- a local model adapter chooses the model requests and tool calls. It uses no model
  API key. The DSH AgentLoop, Agent and Session records, tool dispatch, Inbox state,
  process restart and persistence are not scripted or synthesized by the harness.

What this evidence does not prove:

- that a paid production model makes the same choices;
- that Desktop/Web rendering, deployment, payment or external-message paths work;
- that pre-existing changes in another user's shared DSH checkout are acceptable;
  the proof records those changes and requires no delta during this run.

The harness does not use a real `~/.dsh`, the Desktop/Web GUI, an external message
service, a paid operation, or the user's other worktrees. It creates and removes its
own synthetic Git repository, worktree, session store and DSH home under the OS temp
directory. No commit, push or deployment is made from that worktree.
