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

## One-time tasks

`once()` takes a time written the way a person writes one:

```ts
await scheduler.once({ name: 'digest', prompt: 'summarize my inbox', when: 'tomorrow at 9am' })
```

`parseWhen` accepts ISO timestamps (`2026-09-10T09:00:00Z`, `2026-09-10 09:00`), durations (`in 30 minutes`, `+2h30m`, `45m`), clock times (`at 9am`, `21:30`, `noon`) and day-and-time phrases (`tomorrow at 9am`, `friday 17:00`, `next monday`). Anything else is refused with an error naming the forms that work.

Wall-clock forms always land in the future: a time already past today rolls to tomorrow, and a weekday means its next occurrence — `friday` said on a Friday is the one coming. An explicit ISO timestamp is taken at face value, past or not, because naming a date is unambiguous.

Times resolve against a real IANA zone, not a fixed offset, so `9am` stays `9am` across a DST change. A wall clock the clocks jump over — `02:30` on a spring-forward morning — resolves to the first real time after it. The instant is resolved **once, when the task is added**, and stored: re-reading "tomorrow at 9am" on every restart would quietly move the task instead of keeping it.

### How stale is too stale

Catching up on a missed run is usually right — that is the point of a durable schedule — but not indefinitely. "Post the Friday summary", fired the following Wednesday because a laptop was shut, is worse than not posting it. `graceMs` bounds it:

```ts
new Scheduler({ runner, graceMs: 6 * 3_600_000 })
```

A fire time staler than the window is passed over rather than run. A one-time task that runs out of occurrences ends as `missed`; a recurring one walks forward to its next live occurrence and fires once, not once per occurrence it slept through. The default is `Infinity` — always catch up.

## Recurring tasks

Two shapes, because people mean two different things by "repeating":

```ts
// Every N of something, measured from the last run.
await scheduler.every({ name: 'poll', prompt: 'check the queue', interval: '30m' })

// A wall-clock schedule.
await scheduler.cron({
  name: 'standup',
  prompt: 'summarize overnight activity',
  expr: '0 9 * * 1-5',
  timeZone: 'America/New_York',
})
```

`cron` takes the five crontab fields — `*`, `5`, `1-5`, `*/15`, `1-5/2`, lists, and month/weekday names — plus the `@daily`/`@hourly`/`@weekly`/`@monthly`/`@yearly` shorthands. Sunday is 0 or 7. When **both** day fields are restricted they combine by OR, as crontab defines: `0 0 1 * mon` is "the 1st, and every Monday", not their intersection. A malformed expression is rejected when the task is added, with the offending field named — a silently-wrong schedule is far worse than a refused one.

Cron fire times are wall-clock, so `0 9 * * *` stays 9am through a DST change instead of drifting an hour. A daily time the clocks jump over still fires, at the first real instant after it, rather than being skipped for the day.

`every` measures from the previous fire by default. Pass an `anchor` to pin occurrences to a grid from that instant instead, so an hourly task stays on the hour even when a restart lands it mid-interval.

Both accept bounds:

- `until` — stop after an instant, written any way `parseWhen` accepts.
- `maxRuns` — stop after N runs. A run that threw still counts, so a task failing every time cannot repeat forever.

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

- ✅ #76 Task scheduler · #77 One-time tasks · #78 Recurring tasks
- ⬜ #79 Background execution · #80 Job queue · #81 Failed-job retry · #82 Notifications · #83 Task history
