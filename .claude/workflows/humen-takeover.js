export const meta = {
  name: 'humen-takeover',
  description:
    'Design and implement humenTakeover (#50) control-lease model and ask-for-login primitive per contributing rules',
  phases: [
    {
      title: 'Understand',
      detail: 'Read repo docs, architecture, agent loop, session, tool registry, existing computer/browser tools',
    },
    {
      title: 'Design',
      detail: 'Design spec: control-lease model + ask-for-login as same primitive, session events, new tools',
    },
    { title: 'Implement', detail: 'Create branch, implement design in packages/agent and packages/tools-computer' },
    { title: 'Verify', detail: 'Run format, lint, typecheck, test; confirm green' },
    { title: 'Push', detail: 'Push branch to origin' },
  ],
}

phase('Understand')
const understand = await agent(
  'Read docs/architecture.md, docs/agent-design.md, contributing.md, packages/agent/src/types.ts, agent-loop.ts, session.ts, tools.ts, and packages/tools-computer/src/index.ts. Report the existing tool interface, session event types (SessionEvent), permission levels, agent loop structure, and any existing window/computer-use tool names. Also confirm what feature #50 refers to (humenTakeover / control-lease). List concrete file paths and line ranges for the key interfaces.',
  { label: 'understand-repo', phase: 'Understand' },
)
log('Understand phase: inspected architecture, agent loop, session events, tool registry')

phase('Design')
const design = await agent(
  'Based on the repo structure and contributing.md rules (every capability is a tool, providers interchangeable, security first, small focused PRs), design the feature #50 implementation. Design requirements: (1) Control-lease model per Rakazo: agent can hold a live execution lease; user can request takeover (exclusive input lease); if agent holds live lease and user requests takeover, return HTTP 409-style refusal; agent can call request_takeover when in waiting_takeover state; agent can ask for login (OpenGrokBot ask_for_login pattern). (2) The underlying primitive is an exclusive-input handoff — same mechanism triggered from user side (takeover) or agent side (ask_for_login/request_takeover). Design outputs: new session event types in packages/agent/src/types.ts (e.g. lease/start, lease/end, waiting_takeover), new tool names (request_takeover, ask_for_login), new lease states, permission levels. Propose concrete changes to AgentLoop (suspend/resume points), ToolRegistry, and a new LeaseManager service. Design must keep PR focused and include tests.',
  { label: 'design-spec', phase: 'Design', effort: 'high' },
)
log('Design phase: control-lease + ask-for-login as single primitive defined')

phase('Implement')
const impl = await agent(
  'Create a new feature branch feat/humen-takeover-50 off main. Implement the design: add session event types for lease states, add new tool definitions in packages/tools-computer for request_takeover and ask_for_login, add LeaseManager logic in packages/agent. Ensure all new files use TypeScript (no JS), match existing naming and comment density. Write at least basic unit tests for any new behavior. Do NOT bypass ToolRegistry permission system. Keep the PR focused on #50. After implementing, list the changed files.',
  { label: 'implement-branch', phase: 'Implement', isolation: 'worktree' },
)
log('Implement phase: branch created and code added')

phase('Verify')
const verify = await agent(
  'Run local CI checks on the feature branch: npm run format:check (auto-fix if needed with npm run format), npm run lint (fix with lint:fix), npm run typecheck, npm test. Confirm all pass. If anything fails, fix it. Report exact results of each command.',
  { label: 'verify-ci', phase: 'Verify', effort: 'high' },
)
log('Verify phase: CI checks run')

phase('Push')
const push = await agent(
  'Push the feature branch to origin using git push -u origin feat/humen-takeover-50. Confirm the remote branch exists and list the commit messages.',
  { label: 'push-branch', phase: 'Push', isolation: 'worktree' },
)
log('Push phase: branch pushed to origin')

return {
  understand: understand?.content || 'done',
  design: design?.findings || design?.content || 'done',
  verify: verify?.results || verify?.content || 'done',
  push: push?.results || push?.content || 'done',
}
