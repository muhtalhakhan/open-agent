# @open-agent/automation

Milestone 8. The time-driven half of automation: a scheduler that owns a durable schedule, works out when each entry is due, and hands it to a runner.

## What it does and does not do

The scheduler decides **when** work happens. It never decides **what** the work is — it has no reference to the agent loop, no queue, no process management. Firing a task means calling a `TaskRunner`:

```ts
type TaskRunner = (dispatch: TaskDispatch, signal: AbortSignal) => Promise<void>
```

That seam is where the job queue (#80) attaches. Keeping it out of the scheduler is what lets those land without the scheduler changing, and it is why the whole package tests without an LLM.

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

## Job queue

The scheduler fires a task the moment it is due; the job queue decides whether there is room to run it yet. Plug it in as the scheduler's runner:

```ts
import { JobQueue, agentExecutor, Scheduler } from '@open-agent/automation'

const queue = new JobQueue({ executor: agentExecutor(ctx.get('agentLoop')!), concurrency: 1 })
const scheduler = new Scheduler({ runner: queue.runner(), store })
```

or mount it with `ctx.plugin(jobQueuePlugin())`, which waits for `ctx.agentLoop` and exposes `ctx.jobQueue`. Work that did not come from the schedule goes straight in with `queue.enqueue({ name, prompt })`.

- **Serial by default.** An agent run can stop to ask for approval, and two runs prompting on one terminal at once interleave into something nobody can answer safely. Raise `concurrency` for headless use.
- **Jobs run in arrival order.** A job is `queued`, then `running`, then one of `succeeded`, `failed` or `cancelled`.
- **The runner waits for the job, not just the enqueue.** A task still in line counts as in flight, so the scheduler never fires it a second time, and a failed job becomes the task's `lastError`.
- **Cancelling asks; it does not force.** A queued job is dropped at once. A running one has its signal aborted and is `cancelled` when its executor lets go.
- **The job id is the agent task id**, so a job's transcript is in the session log under the id the queue reports.
- **The queue is in memory on purpose.** A task whose job was waiting when the process died is left `running` in the schedule, and the scheduler puts it back to `pending` on the next load, so it fires again instead of being lost.

### Retries

A failed job can get more attempts, with exponential backoff between them:

```ts
new JobQueue({
  executor,
  retry: {
    maxAttempts: 3,
    backoffMs: 1_000,
    maxBackoffMs: 60_000,
    retryable: (error) => /rate limit|timeout/i.test(error),
  },
})
queue.enqueue({ name: 'digest', prompt: '…', retry: { maxAttempts: 5 } }) // per-job override
```

- **Off by default.** An agent run is not idempotent: a run that failed on step five already made the tool calls of steps one to four, and a retry makes them again. Turn retries on for work where that is harmless, and use `retryable` to retry only the failures another attempt can fix.
- **Backoff doubles from `backoffMs`, capped at `maxBackoffMs`.** While it waits the job is `retrying` with a `retryAt`, and it does not hold a slot, so other jobs keep running.
- **The scheduler only hears the final outcome.** The runner's wait spans every attempt, so a task is marked failed only once the job has run out of them.
- **Each attempt is its own agent turn**, under `<job id>.<attempt>` from the second attempt on. Reusing the id would replay the prompt into the failed attempt's conversation.
- **`retryNow(id)`** gives a `failed` or `cancelled` job one more attempt straight away, for when a person decides the failure was transient.

## Notifications

`notifyOnFinish` tells a `Notifier` when a job finishes:

```ts
import { notifyOnFinish, streamNotifier, webhookNotifier } from '@open-agent/automation'

notifyOnFinish(
  queue,
  streamNotifier((text) => process.stderr.write(text)),
)
notifyOnFinish(queue, webhookNotifier({ url: process.env.NOTIFY_WEBHOOK_URL! }), { on: ['failed'] })
```

A `Notifier` is just `(notification) => void | Promise<void>`, so a desktop toast or a chat message is one function. Each notification carries a one-line `title`, a `body` holding the job's result or error (trimmed to 500 characters), the attempt count, and the scheduled task it came from, if any. The body is the run's final answer when the queue was built with `agentExecutor(loop, sessions)`.

- **Only final outcomes.** A `retrying` job has not failed yet, and announcing every attempt would train people to ignore the one that matters.
- **Successes and failures by default.** A cancelled job was cancelled by someone, who already knows. Pass `on` to choose.
- **A broken notifier cannot break the queue.** A throw or rejection is logged and dropped.
- **The webhook URL is configuration, not a tool argument.** The body carries whatever the agent produced, so where it goes is decided by whoever runs the process, never by the model.

For lower-level needs, `queue.onChange(listener)` reports every status change, retries included.

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
- ✅ #79 Background execution (`:bg` in the CLI) · #80 Job queue · #81 Failed-job retry · #82 Notifications · #83 Task history (`--history` in the CLI)
