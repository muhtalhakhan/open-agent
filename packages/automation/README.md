# @open-agent/automation

Milestone 8. The time-driven half of automation: a scheduler that owns a durable schedule, works out when each entry is due, and hands it to a runner.

## What it does and does not do

The scheduler decides **when** work happens. It never decides **what** the work is — it has no reference to the agent loop, no queue, no process management. Firing a task means calling a `TaskRunner`:

```ts
type TaskRunner = (dispatch: TaskDispatch, signal: AbortSignal) => Promise<void>
```

That seam is where the job queue (#80) and background execution (#79) attach later. Keeping it out of the scheduler is what lets those land without the scheduler changing, and it is why the whole package tests without an LLM.

## Triggers

The scheduler understands only `trigger.kind`. Each kind gets its meaning from a `TriggerEvaluator` registered under that name:

```ts
type TriggerEvaluator = (spec: TriggerSpec, from: number, lastRunAt?: number) => number | undefined
```

It answers "when does this fire next?", or `undefined` for "never again". One-time tasks (#77) and recurring ones (#78) plug in here, so the scheduler itself never learns cron syntax or calendar rules. `at` — fire once at an absolute timestamp — ships built in.

Evaluators must be pure: the scheduler re-derives fire times on every re-arm, including after a restart.

## Usage

```ts
import { Scheduler, FileTaskStore } from '@open-agent/automation'

const scheduler = new Scheduler({
  store: new FileTaskStore('~/.open-agent/schedule.json'),
  runner: async ({ task }) => {
    await ctx.get('agentLoop')!.run(task.prompt, signal)
  },
})

await scheduler.start()
await scheduler.add({
  name: 'morning digest',
  prompt: 'summarize my unread email',
  trigger: { kind: 'at', at: Date.now() + 3_600_000 },
})
```

Mounted as a plugin it becomes `ctx.scheduler`:

```ts
ctx.plugin(schedulerPlugin({ runner }))
```

Mounting registers the seam but does not start firing — that belongs to whoever owns the process lifetime, not to wiring the context up.

## Behaviour worth knowing

- **A missed run is not a skipped run.** "Has it fired?" is `lastRunAt`, not a clock comparison. A task whose fire time passed while the process was down comes back due and runs once on startup.
- **A crash mid-run does not strand a task.** An entry loaded in `running` — which can only mean its completion was never recorded — goes back to `pending`.
- **Recurrence is measured from the fire time, not the finish time**, so a run that overruns does not walk an hourly task later and later.
- **A slow run is never started twice.** A task with its runner still in flight is skipped when it comes due again.
- **Long schedules survive.** `setTimeout` overflows past 2³¹−1 ms and fires immediately; waits longer than that are armed in chunks.
- **Resume recomputes from now**, so a task resumed after a long pause fires once rather than once per occurrence it slept through.

Time enters only through the injected `now`/`setTimer`/`clearTimer` seam, so the tests drive a year-long schedule in a millisecond.

## Status

- ✅ #76 Task scheduler
- ⬜ #77 One-time tasks · #78 Recurring tasks · #79 Background execution · #80 Job queue · #81 Failed-job retry · #82 Notifications · #83 Task history
