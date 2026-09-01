# @open-agent/context

A small, from-scratch plugin/service kernel, inspired by the architecture behind [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (which is built on [Cordis](https://github.com/cordiverse/cordis)). It is not a port of either — it re-derives the same five ideas at a much smaller scale, tailored to `@open-agent/agent`:

1. **A plugin is a function (or object) that registers services and listeners on a context.**
2. **A context is a repository of services** keyed by name (`ctx.get('tools')`, `ctx.get('llm')`, ...).
3. **Plugins declare dependencies via `inject`** and only activate once those services exist — load order is expressed as requirements, not manual sequencing.
4. **Typed events for communication**, with five dispatch modes: `emit`, `waterfall`, `parallel`, `serial`, `bail`.
5. **Registrations are reversible effects** — everything a plugin registers unwinds when it's disposed.

See `src/context.ts` for the implementation and `src/context.test.ts` for usage examples.
