import type { AgentLoop, SessionLog } from '@open-agent/agent'
import { JobQueue, agentExecutor, notifyOnFinish, streamNotifier, type Job } from '@open-agent/automation'

/** How much of the prompt names a job in listings. */
const NAME_LENGTH = 48

/**
 * Tasks the user sent off to run while they keep working in the foreground.
 * Owns a job queue of its own and says so when each job finishes.
 */
export interface BackgroundJobs {
  start(prompt: string): Job
  list(): Job[]
  /** Looks a job up by its id or any unambiguous prefix of it. */
  find(idOrPrefix: string): Job | undefined
  cancel(idOrPrefix: string): Job | undefined
  /** Whether a task id belongs to a background job — including a retry's `<id>.<n>`. */
  owns(taskId: string): boolean
  /** Cancels whatever is still queued or running; resolves with how many that was. */
  close(): Promise<number>
}

/**
 * Background jobs run one at a time, beside the foreground task rather than
 * behind it: the foreground stays free for the user, and a single background
 * slot keeps two unattended runs from racing over the same workspace.
 *
 * Finished jobs announce themselves through `write` — the result's first few
 * hundred characters, with `:job <id>` showing the rest.
 */
export function createBackgroundJobs(
  loop: Pick<AgentLoop, 'run'>,
  sessions: SessionLog,
  write: (text: string) => void,
): BackgroundJobs {
  const queue = new JobQueue({ executor: agentExecutor(loop, sessions) })
  const ids = new Set<string>()
  notifyOnFinish(
    queue,
    streamNotifier((text) => write(`\n${text}`)),
    { on: ['succeeded', 'failed', 'cancelled'] },
  )

  const find = (idOrPrefix: string): Job | undefined => {
    const wanted = idOrPrefix.startsWith('job_') ? idOrPrefix : `job_${idOrPrefix}`
    const matches = queue.list().filter((job) => job.id === wanted || job.id.startsWith(wanted))
    return matches.length === 1 ? matches[0] : matches.find((job) => job.id === wanted)
  }

  return {
    start(prompt) {
      const name = prompt.length > NAME_LENGTH ? `${prompt.slice(0, NAME_LENGTH - 1)}…` : prompt
      const job = queue.enqueue({ name, prompt })
      ids.add(job.id)
      return job
    },
    list: () => queue.list(),
    find,
    cancel(idOrPrefix) {
      const job = find(idOrPrefix)
      return job && queue.cancel(job.id)
    },
    owns: (taskId) => ids.has(taskId.split('.')[0]),
    async close() {
      const live = queue.list({ status: ['queued', 'running', 'retrying'] }).length
      await queue.close()
      return live
    },
  }
}
