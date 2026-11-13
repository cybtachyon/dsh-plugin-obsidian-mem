import { describe, expect, it } from 'vitest'

import { createSerialQueue } from '../src/serial-queue.ts'

/**
 * SerialQueue spec: the one promise-tail guard the embedder and both indexer
 * lanes share. Runs never overlap, submission order holds, a rejection never
 * wedges the lane, and each caller still sees its own outcome.
 */

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('ordering', () => {
  it('starts each task only after the previous one settles', async () => {
    const queue = createSerialQueue()
    const first = deferred<void>()
    const started: string[] = []

    const runFirst = queue(async () => {
      started.push('first')
      await first.promise
      started.push('first-done')
    })
    const runSecond = queue(async () => {
      started.push('second')
    })

    await Promise.resolve()
    expect(started).toEqual(['first'])
    first.resolve()
    await Promise.all([runFirst, runSecond])
    expect(started).toEqual(['first', 'first-done', 'second'])
  })

  it('resolves each caller with its own task result', async () => {
    const queue = createSerialQueue()

    const results = await Promise.all([
      queue(async () => 'a'),
      queue(async () => 'b'),
    ])

    expect(results).toEqual(['a', 'b'])
  })
})

describe('failure handling', () => {
  it('rejects the caller of the failing task and keeps the lane running', async () => {
    const queue = createSerialQueue()

    const failed = queue(async () => {
      throw new Error('milvus write: 14 UNAVAILABLE')
    })
    const after = queue(async () => 'still running')

    await expect(failed).rejects.toThrow('14 UNAVAILABLE')
    expect(await after).toBe('still running')
  })

  it('lets a queued task see the queue after a predecessor failed', async () => {
    const queue = createSerialQueue()
    const order: string[] = []

    await Promise.all([
      queue(async () => {
        order.push('one')
        throw new Error('boom')
      }).catch(() => undefined),
      queue(async () => {
        order.push('two')
      }),
      queue(async () => {
        order.push('three')
      }),
    ])

    expect(order).toEqual(['one', 'two', 'three'])
  })
})
