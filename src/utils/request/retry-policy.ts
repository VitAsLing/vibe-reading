export type RequestErrorKind = "rate-limit" | "timeout" | "network" | "bad-request" | "unknown"

export interface RequestErrorMeta {
  statusCode?: number
  isRetryable?: boolean
  kind?: RequestErrorKind
}

export interface RequestRetryContext {
  retryCount: number
  maxRetries: number
  baseRetryDelayMs: number
}

export type RetryDecision
  = | { action: "retry", delayMs: number }
    | { action: "fail", failQueue?: boolean }

export interface RequestRetryPolicy {
  decide: (error: unknown, context: RequestRetryContext) => RetryDecision
}

export const REQUEST_ERROR_META = Symbol("requestErrorMeta")

export const MAX_RETRY_DELAY_MS = 5 * 60_000

interface RetryAwareError {
  [REQUEST_ERROR_META]?: RequestErrorMeta
  requestErrorMeta?: RequestErrorMeta
  statusCode?: unknown
  status?: unknown
  response?: unknown
  isRetryable?: unknown
  kind?: unknown
  message?: unknown
}

const RATE_LIMIT_ERROR_RE = /\b429\b|too many requests|rate[ -]?limit/i
const TIMEOUT_ERROR_RE = /timed? out|timeout/i
const NETWORK_ERROR_RE = /network error|failed to fetch|fetch failed/i

export function attachRequestErrorMeta<T extends Error>(error: T, meta: RequestErrorMeta): T {
  Object.defineProperty(error, REQUEST_ERROR_META, {
    value: {
      ...getRequestErrorMeta(error),
      ...meta,
    },
    configurable: true,
  })
  return error
}

export function getRequestErrorMeta(error: unknown): RequestErrorMeta {
  const source = isObject(error) ? error as RetryAwareError : undefined
  const attachedMeta = source?.[REQUEST_ERROR_META] ?? source?.requestErrorMeta
  const response = isObject(source?.response) ? source.response as RetryAwareError : undefined

  const statusCode = normalizeStatusCode(
    attachedMeta?.statusCode
    ?? source?.statusCode
    ?? source?.status
    ?? response?.statusCode
    ?? response?.status,
  )
  const isRetryable = normalizeBoolean(attachedMeta?.isRetryable ?? source?.isRetryable)
  const message = typeof source?.message === "string" ? source.message : ""
  const kind = normalizeKind(attachedMeta?.kind ?? source?.kind)
    ?? inferRequestErrorKind({ statusCode, message })

  return removeUndefined({
    statusCode,
    isRetryable,
    kind,
  })
}

export const defaultRequestRetryPolicy: RequestRetryPolicy = {
  decide(error, context) {
    const meta = getRequestErrorMeta(error)

    if (isQueueFatalRequestErrorMeta(meta)) {
      return { action: "fail", failQueue: true }
    }

    if (context.retryCount >= context.maxRetries || !isRetryableRequestErrorMeta(meta)) {
      return { action: "fail" }
    }

    const baseDelayMs = context.baseRetryDelayMs * (2 ** context.retryCount)
    const delayMs = clampRetryDelay(withJitter(baseDelayMs))

    return { action: "retry", delayMs }
  },
}

function isQueueFatalRequestErrorMeta(meta: RequestErrorMeta): boolean {
  if (meta.kind === "rate-limit" || meta.statusCode === 429) {
    return true
  }

  return meta.statusCode === 401
    || meta.statusCode === 403
    || meta.statusCode === 404
}

function isRetryableRequestErrorMeta(meta: RequestErrorMeta): boolean {
  if (typeof meta.isRetryable === "boolean") {
    return meta.isRetryable
  }

  if (meta.kind === "bad-request") {
    return false
  }

  if (meta.kind === "rate-limit" || meta.kind === "timeout" || meta.kind === "network") {
    return true
  }

  const { statusCode } = meta
  if (statusCode !== undefined) {
    if (statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500) {
      return true
    }
    if (statusCode >= 400 && statusCode < 500) {
      return false
    }
  }

  return true
}

function inferRequestErrorKind({ statusCode, message }: { statusCode?: number, message: string }): RequestErrorKind {
  if (statusCode === 429 || RATE_LIMIT_ERROR_RE.test(message)) {
    return "rate-limit"
  }

  if (statusCode === 408) {
    return "timeout"
  }

  if (statusCode === 409) {
    return "unknown"
  }

  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return "bad-request"
  }

  if (TIMEOUT_ERROR_RE.test(message)) {
    return "timeout"
  }

  if (NETWORK_ERROR_RE.test(message)) {
    return "network"
  }

  return "unknown"
}

function normalizeKind(value: unknown): RequestErrorKind | undefined {
  return value === "rate-limit"
    || value === "timeout"
    || value === "network"
    || value === "bad-request"
    || value === "unknown"
    ? value
    : undefined
}

function normalizeStatusCode(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined
  }
  return value
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null
}

function withJitter(delayMs: number): number {
  return delayMs + Math.random() * 0.1 * delayMs
}

function clampRetryDelay(delayMs: number): number {
  return Math.min(Math.max(0, delayMs), MAX_RETRY_DELAY_MS)
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T
}
