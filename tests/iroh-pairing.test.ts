import { randomBytes, X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as QRCode from 'qrcode'
import { ensureIrohTls } from '../src/iroh-tls.js'
import { irohHostname, irohOrigin } from '../src/iroh-origin.js'
import {
  decodePairingDescriptor,
  encodePairingDescriptor,
  MAX_PAIRING_DESCRIPTOR_BYTES,
  PAIRING_DESCRIPTOR_LOCAL_PORT,
  PairingDescriptorError,
  renderIrohPairingQr,
  validatePairingDescriptor,
} from '../src/iroh-pairing.js'

const ENDPOINT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const roots: string[] = []
const prefix = 'dsh-mobile-iroh-pairing-test-'

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (resolve(root) === root && basename(root).startsWith(prefix) && resolve(root, '..') === resolve(tmpdir())) {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } else throw new Error('Refusing to remove an unowned fixture')
  }
})

async function fixtureDescriptor(now = Date.now()): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  const stateFile = join(root, 'remote', 'devices.json')
  const tls = await ensureIrohTls(ENDPOINT, stateFile, root, now)
  const caDer = new X509Certificate(await readFile(tls.paths.caCertFile)).raw
  return {
    version: 1,
    type: 'dsh-mobile-iroh-pairing',
    endpointId: ENDPOINT,
    origin: irohOrigin(ENDPOINT, PAIRING_DESCRIPTOR_LOCAL_PORT),
    localPort: PAIRING_DESCRIPTOR_LOCAL_PORT,
    irohCode: '123456',
    gatewayToken: randomBytes(32).toString('base64url'),
    caCertificate: caDer.toString('base64'),
    instanceId: tls.caFingerprint,
    expiresAt: now + 5 * 60_000,
  }
}

async function codeOf(run: () => unknown): Promise<string> {
  try { await run() } catch (error) {
    expect(error).toBeInstanceOf(PairingDescriptorError)
    return (error as PairingDescriptorError).code
  }
  throw new Error('expected a PairingDescriptorError')
}

describe('iroh pairing descriptor', () => {
  it('round-trips a bounded canonical payload', async () => {
    const now = Date.now()
    const descriptor = await fixtureDescriptor(now)
    const encoded = encodePairingDescriptor(descriptor, { now })
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(MAX_PAIRING_DESCRIPTOR_BYTES)
    expect(decodePairingDescriptor(encoded, { now })).toEqual(descriptor)
    expect(validatePairingDescriptor(JSON.parse(encoded) as unknown, { now })).toEqual(descriptor)
  })

  it('renders a dense pairing QR with four modules of quiet zone on every side', async () => {
    const now = Date.now()
    const encoded = encodePairingDescriptor(await fixtureDescriptor(now), { now })
    const width = QRCode.create(encoded, { errorCorrectionLevel: 'M' }).modules.size
    const svg = await renderIrohPairingQr(encoded)
    expect(svg).toContain(`viewBox="0 0 ${width + 8} ${width + 8}"`)
    expect(svg).toContain('shape-rendering="crispEdges"')
    expect(svg).toContain('d="M4 4.5h7')
  })

  it('rejects endpoint, origin, token, expiry and CA violations with distinct codes', async () => {
    const now = Date.now()
    const valid = await fixtureDescriptor(now)
    expect(await codeOf(() => validatePairingDescriptor({ ...valid, endpointId: '0'.repeat(64) }, { now })))
      .toBe('invalid_pairing_origin')
    expect(await codeOf(() => validatePairingDescriptor({ ...valid, origin: irohOrigin(ENDPOINT, 3443) }, { now })))
      .toBe('invalid_pairing_origin')
    expect(await codeOf(() => validatePairingDescriptor({ ...valid, gatewayToken: 'short' }, { now })))
      .toBe('invalid_gateway_pairing_token')
    expect(await codeOf(() => validatePairingDescriptor({ ...valid, irohCode: 'abcdef' }, { now })))
      .toBe('invalid_iroh_pairing_code')
    expect(await codeOf(() => validatePairingDescriptor({ ...valid, expiresAt: now - 1_000 }, { now })))
      .toBe('invalid_pairing_expiry')
    expect(await codeOf(() => validatePairingDescriptor({ ...valid, expiresAt: now + 11 * 60_000 }, { now })))
      .toBe('invalid_pairing_expiry')
    expect(await codeOf(() => validatePairingDescriptor({ ...valid, caCertificate: Buffer.from('nope').toString('base64') }, { now })))
      .toBe('invalid_pairing_ca_certificate')
    expect(await codeOf(() => validatePairingDescriptor({ ...valid, instanceId: 'f'.repeat(64) }, { now })))
      .toBe('pairing_ca_fingerprint_mismatch')
  })

  it('rejects oversized payloads and duplicate keys', async () => {
    const now = Date.now()
    const valid = await fixtureDescriptor(now)
    expect(await codeOf(() => decodePairingDescriptor('x'.repeat(MAX_PAIRING_DESCRIPTOR_BYTES + 1), { now }))).toBe('pairing_descriptor_too_large')
    const duplicated = JSON.stringify(valid).replace('"version":1', '"version":1,"version":1')
    expect(await codeOf(() => decodePairingDescriptor(duplicated, { now }))).toBe('duplicate_pairing_fields')
    expect(await codeOf(() => decodePairingDescriptor('not json', { now }))).toBe('invalid_pairing_json')
  })

  it('advertises the documented phone-side listener port', () => {
    expect(irohHostname(ENDPOINT)).toContain('.iroh.localhost')
    expect(irohOrigin(ENDPOINT, PAIRING_DESCRIPTOR_LOCAL_PORT)).toBe(`https://${irohHostname(ENDPOINT)}:${String(PAIRING_DESCRIPTOR_LOCAL_PORT)}`)
  })
})
