import { createHash, randomUUID } from 'node:crypto'
import type { Sha256 } from './primitives.ts'
import { asSha256 } from './primitives.ts'

/** JSON values eligible for canonical persistence and hashing. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** Error raised when a value cannot enter a canonical product hash. */
export class CanonicalizationError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalizationError'
  }
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new CanonicalizationError('canonical JSON rejects non-finite numbers')
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalizationError('canonical product values must use strings for non-integer or unsafe numeric values')
  }
  return JSON.stringify(value)
}

function canonicalizeValue(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'string':
      return JSON.stringify(value)
    case 'number':
      return canonicalNumber(value)
    case 'bigint':
      throw new CanonicalizationError('canonical product values must encode bigint as a decimal string')
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new CanonicalizationError('canonical product values must be JSON data')
    case 'object':
      break
    default:
      throw new CanonicalizationError('unsupported canonical product value')
  }

  if (value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set || value instanceof Uint8Array) {
    throw new CanonicalizationError('canonical product values must not contain class instances')
  }
  if (seen.has(value)) throw new CanonicalizationError('canonical product values must not contain cycles')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => canonicalizeValue(item, seen)).join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError('canonical product values must contain plain objects only')
    }
    const record = value as Record<string, unknown>
    const entries = Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalizeValue(record[key], seen)}`)
    return `{${entries.join(',')}}`
  } finally {
    seen.delete(value)
  }
}

/**
 * Serializes a JSON-compatible value using the product's RFC 8785-compatible
 * subset: sorted object keys, native JSON string escaping, and no float or
 * precision-unsafe numeric values at authority digest boundaries.
 *
 * @param value - data to serialize.
 * @returns canonical JSON bytes as text.
 */
export function canonicalJson(value: unknown): string {
  return canonicalizeValue(value, new Set<object>())
}

/** Computes a lowercase SHA-256 digest for bytes or UTF-8 text. */
export function sha256(value: string | Uint8Array): Sha256 {
  return asSha256(createHash('sha256').update(value).digest('hex'))
}

/** Computes a SHA-256 digest over a domain-separation prefix and UTF-8 body. */
export function domainSha256(domain: string, body: string | Uint8Array): Sha256 {
  return sha256(Buffer.concat([Buffer.from(`${domain}\0`, 'utf8'), Buffer.from(body)]))
}

/** Computes a SHA-256 digest over canonical JSON. */
export function canonicalSha256(value: unknown): Sha256 {
  return sha256(canonicalJson(value))
}

/** Creates a UUIDv7-compatible id without reparsing upstream ids. */
export function createUuidV7(): string {
  const uuid = randomUUID()
  const bytes = Buffer.from(uuid.replaceAll('-', ''), 'hex')
  const milliseconds = BigInt(Date.now())
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number((milliseconds >> BigInt((5 - index) * 8)) & 0xffn)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Produces a detached immutable JSON value safe to return from repositories. */
export function cloneAndFreeze<T>(value: T): T {
  const copy = structuredClone(value)
  return freezeRecursively(copy)
}

function freezeRecursively<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) freezeRecursively(child)
  }
  return value
}
