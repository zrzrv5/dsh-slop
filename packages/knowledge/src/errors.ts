export type KnowledgeErrorCode =
  | 'KNOWLEDGE_BOUNDS'
  | 'KNOWLEDGE_CONFLICT'
  | 'KNOWLEDGE_INVALID_ARGUMENT'
  | 'KNOWLEDGE_INVALID_MARKDOWN'
  | 'KNOWLEDGE_NOT_FOUND'
  | 'KNOWLEDGE_SECURITY'
  | 'KNOWLEDGE_WORKSPACE_REQUIRED'

export type KnowledgeErrorDetail = string | number | boolean

export interface KnowledgeErrorOptions extends ErrorOptions {
  readonly details?: Readonly<Record<string, KnowledgeErrorDetail>>
}

export class KnowledgeError extends Error {
  readonly code: KnowledgeErrorCode
  readonly details?: Readonly<Record<string, KnowledgeErrorDetail>>

  constructor(code: KnowledgeErrorCode, message: string, options?: KnowledgeErrorOptions) {
    super(message, options)
    this.name = 'KnowledgeError'
    this.code = code
    if (options?.details !== undefined) this.details = options.details
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}
