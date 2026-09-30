import { schnorr } from '@noble/curves/secp256k1.js'

/** Fixed test-only secret key (never a real account). */
export const NIP98_TEST_SECRET_KEY = new Uint8Array(32).fill(7)

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const NIP98_TEST_PUBKEY = toHex(schnorr.getPublicKey(NIP98_TEST_SECRET_KEY))

export type Nip98TestEventOptions = {
  url: string
  method: string
  createdAt: number
  body?: string
  kind?: number
  extraTags?: string[][]
  omitPayload?: boolean
  payloadOverride?: string
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))))
}

/** Builds and signs a NIP-98 event the way divine-mobile's Nip98AuthService does. */
export async function signNip98Event(options: Nip98TestEventOptions): Promise<Record<string, unknown>> {
  const tags: string[][] = [
    ['u', options.url],
    ['method', options.method],
  ]
  if (!options.omitPayload && (options.body !== undefined || options.payloadOverride !== undefined)) {
    tags.push(['payload', options.payloadOverride ?? (await sha256Hex(options.body ?? ''))])
  }
  tags.push(...(options.extraTags ?? []))

  const unsigned = {
    pubkey: NIP98_TEST_PUBKEY,
    created_at: options.createdAt,
    kind: options.kind ?? 27235,
    tags,
    content: '',
  }
  const id = await sha256Hex(
    JSON.stringify([0, unsigned.pubkey, unsigned.created_at, unsigned.kind, unsigned.tags, unsigned.content]),
  )
  const idBytes = Uint8Array.from(id.match(/../g)!, (byte) => Number.parseInt(byte, 16))
  const sig = toHex(schnorr.sign(idBytes, NIP98_TEST_SECRET_KEY))
  return { id, ...unsigned, sig }
}

/** Encodes an event as the value of an `Authorization: Nostr ...` header. */
export function nip98Header(event: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(event))
  return `Nostr ${btoa(String.fromCharCode(...bytes))}`
}
