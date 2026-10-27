import type { InferValue } from '@deepseek-ai/dsh-tools'
import type { QueueItem } from '@dsh-slop/queue'
import { queueListItemSchema, queueListSuccessSchema } from './queue-tool-schema.ts'

export const DEFAULT_QUEUE_LIST_LIMIT = 10
export const MAX_QUEUE_LIST_BYTES = 12 * 1024

/** List summaries are model projections, never replacements for persisted records. */
function summarize(item: QueueItem): InferValue<typeof queueListItemSchema> {
  let textTruncated = false
  const preview = (text: string): string => {
    if (text.length <= 256) return text
    textTruncated = true
    return `${text.slice(0, 255)}…`
  }
  const observation = item.lastObservation
  return {
    id: item.id,
    label: preview(item.label),
    target: item.target,
    observer: item.observer.kind === 'process'
      ? { kind: 'process', pid: item.observer.handle.pid }
      : item.observer,
    state: item.state,
    ...(item.purpose === undefined ? {} : { purpose: item.purpose }),
    ...(item.verificationPending === undefined ? {} : { verificationPending: item.verificationPending }),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.nextCheckAt === undefined ? {} : { nextCheckAt: item.nextCheckAt }),
    ...(item.phase === undefined ? {} : { phase: item.phase }),
    ...(observation === undefined ? {} : { lastObservation: {
      state: observation.state,
      observedAt: observation.observedAt,
      source: observation.source,
      ...(observation.elapsedSeconds === undefined ? {} : { elapsedSeconds: observation.elapsedSeconds }),
      ...(observation.walltimeSeconds === undefined ? {} : { walltimeSeconds: observation.walltimeSeconds }),
      ...(observation.walltimeRemainingSeconds === undefined ? {} : { walltimeRemainingSeconds: observation.walltimeRemainingSeconds }),
      ...(observation.attention === undefined ? {} : { attention: {
        code: observation.attention.code,
        message: preview(observation.attention.message),
      } }),
    } }),
    ...(item.lastCheckError === undefined ? {} : { lastCheckError: {
      at: item.lastCheckError.at,
      message: preview(item.lastCheckError.message),
    } }),
    ...(textTruncated ? { textTruncated: true } : {}),
  }
}

export function queueListPage(
  items: readonly QueueItem[],
  { offset, limit }: { readonly offset: number; readonly limit: number },
): InferValue<typeof queueListSuccessSchema> {
  const sorted = [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id))
  const stateCounts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, unknown: 0 }
  for (const item of items) stateCounts[item.state] += 1
  const value: InferValue<typeof queueListItemSchema>[] = []
  const result = (): InferValue<typeof queueListSuccessSchema> => {
    const hasMore = offset + value.length < items.length
    return {
      schemaVersion: 1,
      ok: true,
      value,
      page: { total: items.length, offset, hasMore, ...(hasMore ? { nextOffset: offset + value.length } : {}), stateCounts },
    }
  }
  for (const item of sorted.slice(offset, offset + limit)) {
    value.push(summarize(item))
    // Match the native renderer, including indentation; PTC uses the same page.
    if (Buffer.byteLength(JSON.stringify(result(), null, 2), 'utf8') > MAX_QUEUE_LIST_BYTES) {
      value.pop()
      break
    }
  }
  return result()
}
