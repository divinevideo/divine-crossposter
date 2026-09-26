import { PlatformAdapterError } from '../platforms/adapter'

// Provider error bodies are untrusted and can echo request values, so logs get
// only these allowlisted fields, each capped and scrubbed of token-like runs.
export type ProviderErrorDiagnostics = {
  endpoint?: string
  type?: string
  code?: number
  subcode?: number
  message?: string
  traceId?: string
}

const MAX_MESSAGE_LENGTH = 300
const MAX_TYPE_LENGTH = 100
const MAX_TRACE_ID_LENGTH = 64
const REDACTED = '[redacted]'

// Long unbroken runs of token alphabet characters. A run with a digit is
// treated as a credential at 20+ characters; any run at 40+ characters is.
const TOKEN_RUN = /[A-Za-z0-9_\-.~+/=#%|:]{20,}/g
const URL_PATTERN = /\bhttps?:\/\/\S+/gi
// Query-string style assignments such as `code=...` echoed back from a request.
const SECRET_ASSIGNMENT =
  /\b(access_token|refresh_token|client_secret|code_verifier|code|state|token|secret|password|authorization)=\S+/gi
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function redactProviderText(value: string, maxLength: number): string {
  const scrubbed = value
    .replace(CONTROL_CHARS, ' ')
    .replace(URL_PATTERN, '[url]')
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(TOKEN_RUN, (run) => (/\d/.test(run) || run.length >= 40 ? REDACTED : run))
    .trim()
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}…` : scrubbed
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const redacted = redactProviderText(value, maxLength)
  return redacted || undefined
}

function integer(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^-?\d{1,10}$/.test(value.trim())) return Number(value.trim())
  return undefined
}

function traceId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return /^[A-Za-z0-9_\-]{1,64}$/.test(trimmed) ? trimmed.slice(0, MAX_TRACE_ID_LENGTH) : undefined
}

function firstDefined<T>(...values: (T | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined)
}

// Shapes covered:
// - Meta Graph:           { error: { message, type, code, error_subcode, fbtrace_id } }
// - Instagram token:      { error_type, code, error_message }
// - OAuth 2.0 (X, others):{ error, error_description }
// - X API v2:             { title, detail, type } or { errors: [{ message, code }] }
function extractFromBody(body: unknown): Omit<ProviderErrorDiagnostics, 'endpoint'> {
  const root = asRecord(body)
  const nested = asRecord(root.error)
  const firstError = Array.isArray(root.errors) ? asRecord(root.errors[0]) : {}
  const oauthError = typeof root.error === 'string' ? root.error : undefined

  return {
    type: firstDefined(
      text(nested.type, MAX_TYPE_LENGTH),
      text(root.error_type, MAX_TYPE_LENGTH),
      text(oauthError, MAX_TYPE_LENGTH),
      text(root.title, MAX_TYPE_LENGTH),
    ),
    code: firstDefined(integer(nested.code), integer(root.code), integer(firstError.code)),
    subcode: firstDefined(integer(nested.error_subcode), integer(root.error_subcode)),
    message: firstDefined(
      text(nested.message, MAX_MESSAGE_LENGTH),
      text(root.error_message, MAX_MESSAGE_LENGTH),
      text(root.error_description, MAX_MESSAGE_LENGTH),
      text(root.detail, MAX_MESSAGE_LENGTH),
      text(firstError.message, MAX_MESSAGE_LENGTH),
    ),
    traceId: firstDefined(traceId(nested.fbtrace_id), traceId(root.fbtrace_id)),
  }
}

export function providerErrorDiagnostics(error: unknown): ProviderErrorDiagnostics | null {
  if (!(error instanceof PlatformAdapterError)) return null

  const diagnostics: ProviderErrorDiagnostics = {
    endpoint: error.providerEndpoint,
    ...extractFromBody(error.providerResponse),
  }
  const entries = Object.entries(diagnostics).filter(([, value]) => value !== undefined)
  return entries.length > 0 ? (Object.fromEntries(entries) as ProviderErrorDiagnostics) : null
}
