import { IncomingMessage, type IncomingHttpHeaders } from 'node:http'
import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { AuthFailureRecorder, type AuthFailureEntry } from '../src/auth-failure-log.js'
import { HOST_CSRF_COOKIE, HOST_SESSION_COOKIE } from '../src/browser-auth-cookies.js'
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../src/http-security.js'

function incoming(headers: IncomingHttpHeaders = {}, method = 'GET'): IncomingMessage {
  const request = new IncomingMessage(new Socket())
  request.headers = headers
  request.method = method
  return request
}

describe('bounded authentication diagnostics', () => {
  it('counts exact cookie names without reflecting any cookie or CSRF value', () => {
    const entries: AuthFailureEntry[] = []
    const recorder = new AuthFailureRecorder(entry => { entries.push(entry) })
    const request = incoming({
      cookie: [
        `other=${SESSION_COOKIE}=private-session`,
        `${SESSION_COOKIE}_other=not-a-session`,
        `${HOST_SESSION_COOKIE}=private-session`,
        `other=${CSRF_COOKIE}`,
        `${CSRF_COOKIE}_other=not-csrf`,
        `${CSRF_COOKIE}=private-csrf`,
        `${HOST_CSRF_COOKIE}=private-host-csrf`,
        `${CSRF_COOKIE}=`,
      ].join('; '),
      [CSRF_HEADER]: 'private-csrf-header',
      'sec-fetch-site': 'same-origin',
    }, 'POST')
    recorder.record('csrf', 403, request, '/api/session/prompt', 'https://example.com', {
      sessionKey: 'private-session-key', deviceId: 'a'.repeat(32), expiresAt: 100,
    })
    expect(entries).toEqual([{
      kind: 'csrf', status: 403, method: 'POST', path: '/api/session/prompt',
      sessionCookie: true, csrfHeader: true, csrfCookies: 3,
      origin: 'https://example.com', site: 'same-origin', device: 'a'.repeat(8),
    }])
    expect(JSON.stringify(entries)).not.toMatch(/private-|not-a-session|not-csrf/u)
  })

  it('does not infer session or CSRF cookie presence from names embedded in other names or values', () => {
    const entries: AuthFailureEntry[] = []
    const recorder = new AuthFailureRecorder(entry => { entries.push(entry) })
    recorder.record('authorize', 401, incoming({
      cookie: `x=${SESSION_COOKIE}=value; ${SESSION_COOKIE}_other=value; x=${CSRF_COOKIE}; ${CSRF_COOKIE}_other=value`,
    }), '/')
    expect(entries[0]).toMatchObject({ sessionCookie: false, csrfHeader: false, csrfCookies: 0 })
  })

  it('records the first failure immediately and aggregates later failures independently of their paths or devices', () => {
    let now = 0
    const entries: AuthFailureEntry[] = []
    const recorder = new AuthFailureRecorder(entry => { entries.push(entry) }, () => now)
    const request = incoming()
    for (let index = 0; index < 1_000; index += 1) {
      recorder.record('authorize', 401, request, `/api/private-${index}`)
    }
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ path: '/api/*' })
    expect(entries[0]).not.toHaveProperty('suppressed')
    recorder.record('csrf', 403, request, '/api/session/prompt')
    expect(entries).toHaveLength(2)
    now = 29_999
    recorder.record('authorize', 401, request, '/index.html')
    expect(entries).toHaveLength(2)
    now = 30_000
    recorder.record('authorize', 401, request, '/index.html')
    expect(entries).toHaveLength(3)
    expect(entries[2]).toMatchObject({ path: '/index.html', suppressed: 1_000 })
    now = 60_000
    recorder.record('authorize', 401, request, '/')
    expect(entries[3]).not.toHaveProperty('suppressed')
  })

  it('does not share logging budgets between Gateway owners', () => {
    const first = vi.fn()
    const second = vi.fn()
    const ownerA = new AuthFailureRecorder(first, () => 0)
    const ownerB = new AuthFailureRecorder(second, () => 0)
    const request = incoming()
    ownerA.record('authorize', 401, request, '/')
    ownerA.record('authorize', 401, request, '/')
    ownerB.record('authorize', 401, request, '/')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it.each([
    { label: 'API identifiers', path: '/api/private-document/secret-name', category: '/api/*' },
    { label: 'extension names and paths', path: '/mobile-access/extensions/private-name/files/secret-path', category: '/mobile-access/extensions/*' },
    { label: 'boot batch identifiers', path: '/mobile-access/boot/private-batch-id', category: '/mobile-access/*' },
    { label: 'plugin module identifiers', path: '/plugins/private-module/client.js?rev=private-rev', category: '/plugins/*' },
    { label: 'owned asset digests', path: '/assets/private-name-a1b2c3d4.js', category: '/assets/*' },
    { label: 'oversized filenames and queries', path: `/${'private'.repeat(1_000)}?token=private-token`, category: '/*' },
  ])('uses a fixed category instead of $label', ({ path, category }) => {
    const entries: AuthFailureEntry[] = []
    const recorder = new AuthFailureRecorder(entry => { entries.push(entry) })
    recorder.record('authorize', 401, incoming(), path)
    expect(entries[0]?.path).toBe(category)
    expect(JSON.stringify(entries)).not.toContain('private')
    expect(JSON.stringify(entries).length).toBeLessThan(256)
  })

  it('omits raw Origin, unknown fetch-site values and oversized canonical Origins', () => {
    const entries: AuthFailureEntry[] = []
    const recorder = new AuthFailureRecorder(entry => { entries.push(entry) })
    recorder.record('authorize', 401, incoming({
      origin: 'https://user:private@invalid.example/private?token=private',
      'sec-fetch-site': 'private-unrecognized-value',
    }, 'PRIVATE-METHOD'), '/', `https://${'private'.repeat(100)}.example`)
    expect(entries[0]).toMatchObject({ method: 'OTHER' })
    expect(entries[0]).not.toHaveProperty('origin')
    expect(entries[0]).not.toHaveProperty('site')
    expect(JSON.stringify(entries)).not.toContain('private')
  })

  it('contains observer errors and emits one independent, value-free failure report', () => {
    let now = 0
    const sink = vi.fn(() => { throw new Error('private sink failure') })
    const report = vi.fn()
    const recorder = new AuthFailureRecorder(sink, () => now, report)
    const request = incoming()
    expect(() => recorder.record('authorize', 401, request, '/')).not.toThrow()
    recorder.record('csrf', 403, request, '/api/session/prompt')
    now = 30_000
    recorder.record('authorize', 401, request, '/')
    expect(sink).toHaveBeenCalledTimes(3)
    expect(report.mock.calls).toEqual([[]])
  })

  it('retains the HTTP failure owner even if diagnostic failure reporting is unavailable', () => {
    const recorder = new AuthFailureRecorder(
      () => { throw new Error('sink unavailable') },
      () => 0,
      () => { throw new Error('reporter unavailable') },
    )
    expect(() => recorder.record('authorize', 401, incoming(), '/')).not.toThrow()
  })

  it('performs no diagnostic work when no observer is installed', () => {
    const now = vi.fn(() => 0)
    const recorder = new AuthFailureRecorder(undefined, now)
    recorder.record('authorize', 401, incoming(), '/')
    expect(now).not.toHaveBeenCalled()
  })
})
