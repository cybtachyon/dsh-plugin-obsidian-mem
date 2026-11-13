/**
 * SerialQueue builds the one promise-tail guard this package uses to run
 * async work one at a time in submission order. Milvus-Lite tolerates
 * concurrent readers but has a single writer (findings §3), an onnxruntime
 * session must not be reentered, and one vault's state file plus dirty queue
 * is shared by every trigger that touches it, so three separate lanes need
 * the same guard.
 * @module dsh-plugin-obsidian-mem/service/serial-queue
 */

/** Runs one task at a time; resolves with the task's own result or rejection. */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>

/**
 * CreateSerialQueue returns a queue that starts each task only after the
 * previous one settles. A task sees the queue whether its predecessor
 * resolved or rejected (one failure never wedges the lane), while its own
 * caller still receives its rejection.
 */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve()
  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
