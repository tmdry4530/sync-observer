import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
  type BinaryLike,
  type ScryptOptions
} from 'node:crypto'

function scrypt(password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error)
      else resolve(derivedKey)
    })
  })
}

const SCRYPT_KEYLEN = 64
const SCRYPT_PARAMS: ScryptOptions = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

/**
 * Hash a password with scrypt (memory-hard KDF built into Node, no native
 * addon). Format: `scrypt$N$r$p$salt$hash`, all base64url.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = (await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS)) as Buffer
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64url'),
    derived.toString('base64url')
  ].join('$')
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts
  const N = Number(nRaw)
  const r = Number(rRaw)
  const p = Number(pRaw)
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  const salt = Buffer.from(saltRaw ?? '', 'base64url')
  const expected = Buffer.from(hashRaw ?? '', 'base64url')
  if (expected.length === 0) return false

  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 })
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/** Generate a 256-bit URL-safe random token (raw secret, shown once). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** Deterministic SHA-256 of a token; only the hash is persisted. */
export function hashToken(token: string, pepper: string | null = null): string {
  const hash = createHash('sha256')
  hash.update(token)
  if (pepper) hash.update(pepper)
  return hash.digest('hex')
}

export function hmacSha256(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex')
}

/** Hash an IP for audit logs without storing the raw address. */
export function hashIp(ip: string | null | undefined, secret: string | null): string | null {
  if (!ip) return null
  if (!secret) return createHash('sha256').update(ip).digest('hex')
  return hmacSha256(ip, secret)
}

export function newUuid(): string {
  return randomUUID()
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)
  if (bufferA.length !== bufferB.length) return false
  return timingSafeEqual(bufferA, bufferB)
}
