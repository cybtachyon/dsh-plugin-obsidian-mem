/**
 * Errors collects the service's shared error rendering. The Milvus SDK, the
 * embedder, fetch, and node:fs each fail with a different payload shape, and
 * every log line and thrown wrapper in this package flattens one through the
 * same sentence builder.
 * @module dsh-plugin-obsidian-mem/service/errors
 */

/**
 * DescribeError renders an unknown thrown value as its message, or its
 * String form for non-Error throws. Logging paths use it so a rejection
 * never prints `[object Object]` or an empty suffix.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
