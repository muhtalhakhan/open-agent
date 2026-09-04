## What does this PR do?

## Related issue

Closes #

## How was this tested?

## Security-sensitive?

- [ ] This PR adds/modifies a tool that can take real-world actions (files, shell, network, browser, external APIs)
- [ ] If checked above: it correctly declares a `permissionLevel` and goes through `ToolRegistry` in `packages/agent/src/tools.ts` (a dedicated `packages/security` is planned but not yet built)

## Checklist

- [ ] `npm run format:check` passes
- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] Docs updated if behavior/interfaces changed
