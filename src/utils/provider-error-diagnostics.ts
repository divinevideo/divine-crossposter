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

// Token-alphabet runs. A labeled code or token is never treated as a name.
// An unlabeled 20+ run is a credential unless it is under 40 characters and is
// a scope name (every underscore-separated piece is 2 to 12 lowercase letters)
// or an error type name such as GraphMethodException.
const TOKEN_RUN = /[A-Za-z0-9_\-.~+/=#%|:]{20,}/g
const LABELED_SECRET =
  /\b(?:authorization code|auth code|access token|refresh token|client secret|code verifier|code|token)\b[^A-Za-z0-9]{0,3}([A-Za-z0-9_\-.~+/=#%|:]{8,})/gi
const URL_PATTERN = /\bhttps?:\/\/\S+/gi
// Query-string style assignments such as `code=...` echoed back from a request.
const SECRET_ASSIGNMENT =
  /\b(access_token|refresh_token|client_secret|code_verifier|code|state|token|secret|password|authorization)=\S+/gi
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function isScopeName(run: string): boolean {
  const parts = run.split('_')
  return parts.length >= 2 && parts.every((part) => /^[a-z]{2,12}$/.test(part))
}

// Provider error class names, such as Meta's GraphMethodException.
function isErrorTypeName(run: string): boolean {
  return /^(?:[A-Z][a-z]+)+(?:Exception|Error)$/.test(run)
}

function isCredentialRun(run: string, allowNames = true): boolean {
  if (allowNames && run.length < 40 && (isScopeName(run) || isErrorTypeName(run))) return false
  return /\d/.test(run) || /[A-Z]/.test(run) || run.length >= 20
}

export function redactProviderText(value: string, maxLength: number): string {
  const scrubbed = value
    .replace(CONTROL_CHARS, ' ')
    .replace(URL_PATTERN, '[url]')
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(LABELED_SECRET, (match, secret: string) =>
      isCredentialRun(secret, false) ? `${match.slice(0, match.length - secret.length)}${REDACTED}` : match,
    )
    .replace(TOKEN_RUN, (run) => (isCredentialRun(run) ? REDACTED : run))
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
