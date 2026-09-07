import type { RequestRetryPolicy } from "./retry-policy"
import { deepmerge } from "deepmerge-ts"
import { requestQueueConfigSchema } from "@/types/config/translate"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { BinaryHeapPQ } from "./priority-queue"
import { defaultRequestRetryPolicy } from "./retry-policy"

interface RequestTask {
  hash: string
  id: string
  thunk: () => Promise<any>
  promise: Promise<any>
  resolve: (value: any) => void
  reject: (error: any) => void
  scheduleAt: number
  retryCount: number
  drained: boolean
}

export interface QueueOptions {
  rate: number // tokens/sec
  capacity: number // token bucket size
  timeoutMs: number
  maxRetries: number
  baseRetryDelayMs: number
  retryPolicy?: RequestRetryPolicy
}

export class RequestQueue {
  private waitingQueue: BinaryHeapPQ<RequestTask>
  private waitingTasks = new Map<string, RequestTask>()
  private executingTasks = new Map<string, RequestTask>()
  private nextScheduleTimer: NodeJS.Timeout | null = null
  private retryPolicy: RequestRetryPolicy

  // token bucket
  private bucketTokens: number
  private lastRefill: number

  constructor(private options: QueueOptions) {
    this.retryPolicy = options.retryPolicy ?? defaultRequestRetryPolicy
    this.bucketTokens = options.capacity
    this.lastRefill = Date.now()
    this.waitingQueue = new BinaryHeapPQ<RequestTask>()
  }

  enqueue<T>(thunk: () => Promise<T>, scheduleAt: number, hash: string): Promise<T> {
    const duplicateTask = this.waitingTasks.get(hash) ?? this.executingTasks.get(hash)
    if (duplicateTask) {
      return duplicateTask.promise
    }

    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })

    const task: RequestTask = {
      id: getRandomUUID(),
      hash,
      thunk,
      promise,
      resolve,
      reject,
      scheduleAt,
      retryCount: 0,
      drained: false,
    }

    this.waitingTasks.set(hash, task)
    this.waitingQueue.push(task, scheduleAt)

    this.schedule()
    return promise
  }

  setQueueOptions(options: Partial<QueueOptions>) {
    const { retryPolicy, ...queueOptions } = options
    const parseConfigStatus = requestQueueConfigSchema.partial().safeParse(queueOptions)
    if (parseConfigStatus.error) {
      throw new Error(parseConfigStatus.error.issues[0].message)
    }
    this.options = deepmerge(this.options, queueOptions) as QueueOptions
    if (retryPolicy) {
      this.retryPolicy = retryPolicy
    }
    if (queueOptions.capacity) {
      this.bucketTokens = queueOptions.capacity
      this.lastRefill = Date.now()
    }
  }

  private schedule() {
    this.refillTokens()

    while (this.bucketTokens >= 1 && this.waitingQueue.size() > 0) {
      const now = Date.now()

      const task = this.waitingQueue.peek()
      if (task && task.scheduleAt <= now) {
        this.waitingQueue.pop()
        this.waitingTasks.delete(task.hash)
        this.executingTasks.set(task.hash, task)
        this.bucketTokens--
        void this.executeTask(task)
      }
      else {
        break
      }
    }

    if (this.nextScheduleTimer) {
      clearTimeout(this.nextScheduleTimer)
      this.nextScheduleTimer = null
    }

    if (this.waitingQueue.size() > 0) {
      const nextTask = this.waitingQueue.peek()
      if (nextTask) {
        const now = Date.now()
        const delayUntilScheduled = Math.max(0, nextTask.scheduleAt - now)
        const msUntilNextToken = this.bucketTokens >= 1 ? 0 : Math.ceil((1 - this.bucketTokens) / this.options.rate * 1000)
        const delay = Math.max(delayUntilScheduled, msUntilNextToken)

        this.nextScheduleTimer = setTimeout(() => {
          this.nextScheduleTimer = null
          this.schedule()
        }, delay)
      }
    }
  }

  private async executeTask(task: RequestTask) {
    let timeoutId: NodeJS.Timeout | null = null

    try {
      // Create a timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Task ${task.id} timed out after ${this.options.timeoutMs}ms`))
        }, this.options.timeoutMs)
      })

      // Race between the actual task and timeout
      const result = await Promise.race([
        task.thunk(),
        timeoutPromise,
      ])

      if (!task.drained) {
        task.resolve(result)
      }
    }
    catch (error) {
      if (task.drained) {
        return
      }

      const now = Date.now()
      const decision = this.retryPolicy.decide(error, {
        retryCount: task.retryCount,
        maxRetries: this.options.maxRetries,
        baseRetryDelayMs: this.options.baseRetryDelayMs,
        now,
      })

      // Check if we should retry
      if (decision.action === "retry") {
        task.retryCount++
        // Schedule retry
        const retryAt = now + decision.delayMs
        task.scheduleAt = retryAt

        // Move task back to waiting queue for retry
        this.waitingTasks.set(task.hash, task)
        this.waitingQueue.push(task, retryAt)
        this.schedule()
      }
      else {
        // Max retries exceeded, reject the promise
        if (decision.failQueue) {
          this.failCurrentBacklog(error)
        }
        else {
          task.reject(error)
        }
      }
    }
    finally {
      // Ensure timeout is always cleared
      if (timeoutId) {
        clearTimeout(timeoutId)
      }

      if (this.executingTasks.get(task.hash) === task) {
        this.executingTasks.delete(task.hash)
      }
      this.schedule()
    }
  }

  private failCurrentBacklog(error: unknown) {
    if (this.nextScheduleTimer) {
      clearTimeout(this.nextScheduleTimer)
      this.nextScheduleTimer = null
    }

    for (const task of this.waitingTasks.values()) {
      this.rejectDrainedTask(task, error)
    }
    this.waitingTasks.clear()
    this.waitingQueue.clear()

    for (const task of this.executingTasks.values()) {
      this.rejectDrainedTask(task, error)
    }
    this.executingTasks.clear()
  }

  private rejectDrainedTask(task: RequestTask, error: unknown) {
    if (task.drained) {
      return
    }

    task.drained = true
    task.reject(error)
  }

  private refillTokens() {
    const now = Date.now()
    const timeSinceLastRefill = now - this.lastRefill
    const tokensToAdd = (timeSinceLastRefill / 1000) * this.options.rate
    this.bucketTokens = Math.min(this.bucketTokens + tokensToAdd, this.options.capacity)

    this.lastRefill = now
  }
}
