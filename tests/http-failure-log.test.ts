import { describe, expect, it, vi } from 'vitest'
import { classifyHttpParserFailure, HttpFailureRecorder, type HttpFailureEntry } from '../src/http-failure-log.js'

describe('HTTP parser rejection classification', () => {
  it.each([
    { nodeCode: 'ERR_HTTP_REQUEST_TIMEOUT', status: 408, code: 'request_timeout' },
    { nodeCode: 'HPE_HEADER_OVERFLOW', status: 431, code: 'headers_too_large' },
    ...['HPE_INVALID_METHOD', 'HPE_INVALID_CONSTANT', 'HPE_INVALID_URL', 'HPE_INVALID_VERSION', 'HPE_LF_EXPECTED', 'HPE_PAUSED_H2_UPGRADE'].map(nodeCode => ({ nodeCode, status: 400, code: 'bad_request' })),
    { nodeCode: 'HPE_INVALID_CHUNK_SIZE', status: 400, code: 'bad_request' },
    { nodeCode: 'HPE_INVALID_CONTENT_LENGTH', status: 400, code: 'bad_request' },
    { nodeCode: 'HPE_INVALID_EOF_STATE', status: 400, code: 'bad_request' },
    { nodeCode: 'HPE_INVALID_HEADER_TOKEN', status: 400, code: 'bad_request' },
    { nodeCode: 'HPE_INVALID_TRANSFER_ENCODING', status: 400, code: 'bad_request' },
    { nodeCode: 'HPE_UNEXPECTED_CONTENT_LENGTH', status: 400, code: 'bad_request' },
  ])('keeps $nodeCode distinguishable without raw parser details', ({ nodeCode, status, code }) => {
    expect(classifyHttpParserFailure(nodeCode)).toEqual({ status, code, parserCode: nodeCode })
  })

  it.each([undefined, 'private-error-message-and-raw-packet', 'ECONNRESET', 'HPE_PRIVATE_EXTENSION'])('bounds an unknown code to a fixed category', nodeCode => {
    expect(classifyHttpParserFailure(nodeCode)).toEqual({ status: 400, code: 'bad_request', parserCode: 'other' })
  })
})

describe('bounded HTTP failure diagnostics', () => {
  it.each(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'])('keeps %s separate from HTTP rejections', nodeCode => {
    const entries: HttpFailureEntry[] = []
    const recorder = new HttpFailureRecorder(entry => { entries.push(entry) })
    expect(recorder.recordClientError(nodeCode)).toEqual({ kind: 'transport', code: nodeCode })
    expect(entries).toEqual([{ kind: 'transport', code: nodeCode }])
    expect(entries[0]).not.toHaveProperty('status')
  })

  it('bounds transport sampling independently without losing a parser rejection', () => {
    let now = 0
    const entries: HttpFailureEntry[] = []
    const recorder = new HttpFailureRecorder(entry => { entries.push(entry) }, () => now)
    recorder.recordClientError('ECONNRESET')
    recorder.recordClientError('EPIPE')
    recorder.recordClientError('HPE_INVALID_METHOD')
    now = 30_000
    recorder.recordClientError('ECONNRESET')
    expect(entries).toEqual([
      { kind: 'transport', code: 'ECONNRESET' },
      { kind: 'parser', status: 400, code: 'HPE_INVALID_METHOD' },
      { kind: 'transport', code: 'ECONNRESET', suppressed: 1 },
    ])
  })
  it('uses only fixed parser and target fields and exact authenticated prompt status fields', () => {
    const entries: HttpFailureEntry[] = []
    const recorder = new HttpFailureRecorder(entry => { entries.push(entry) })
    expect(recorder.recordParser('private-error-message')).toEqual({ status: 400, code: 'bad_request', parserCode: 'other' })
    recorder.recordTarget()
    recorder.recordUpstream('POST', '/api/session/prompt', 400)
    expect(entries).toEqual([
      { kind: 'parser', status: 400, code: 'other' },
      { kind: 'target', status: 400, code: 'bad_request' },
      { kind: 'upstream', status: 400, method: 'POST', path: '/api/session/prompt' },
    ])
    expect(JSON.stringify(entries)).not.toContain('private')
  })

  it('does not record other routes, methods, query-bearing paths or nonfailure status values', () => {
    const observer = vi.fn()
    const recorder = new HttpFailureRecorder(observer)
    for (const method of [undefined, 'GET', 'PATCH', 'private-method']) recorder.recordUpstream(method, '/api/session/prompt', 400)
    for (const path of ['/api/private-resource', '/api/session/prompt?token=private', '/api/%73ession/prompt', '/api/session/prompt/private']) {
      recorder.recordUpstream('POST', path, 400)
    }
    for (const status of [0, 200, 399, 600, 400.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      recorder.recordUpstream('POST', '/api/session/prompt', status)
    }
    expect(observer).not.toHaveBeenCalled()
    recorder.recordUpstream('POST', '/api/session/prompt', 599)
    expect(observer).toHaveBeenCalledExactlyOnceWith({ kind: 'upstream', status: 599, method: 'POST', path: '/api/session/prompt' })
  })

  it('samples each of three fixed slots independently and carries suppressed counts into the next entry', () => {
    let now = 0
    const entries: HttpFailureEntry[] = []
    const recorder = new HttpFailureRecorder(entry => { entries.push(entry) }, () => now)
    for (let index = 0; index < 1000; index += 1) {
      recorder.recordParser(`private-error-${String(index)}`)
      recorder.recordTarget()
      recorder.recordUpstream('POST', '/api/session/prompt', 400)
    }
    expect(entries).toHaveLength(3)
    expect(entries.every(entry => entry.suppressed === undefined)).toBe(true)
    now = 29_999
    recorder.recordParser('HPE_HEADER_OVERFLOW')
    expect(entries).toHaveLength(3)
    now = 30_000
    recorder.recordParser('ERR_HTTP_REQUEST_TIMEOUT')
    recorder.recordTarget()
    recorder.recordUpstream('POST', '/api/session/prompt', 503)
    expect(entries.slice(3)).toEqual([
      { kind: 'parser', status: 408, code: 'ERR_HTTP_REQUEST_TIMEOUT', suppressed: 1000 },
      { kind: 'target', status: 400, code: 'bad_request', suppressed: 999 },
      { kind: 'upstream', status: 503, method: 'POST', path: '/api/session/prompt', suppressed: 999 },
    ])
    now = 60_000
    recorder.recordParser('HPE_INVALID_CHUNK_SIZE')
    expect(entries[6]).not.toHaveProperty('suppressed')
  })

  it('does not share budgets between Gateways', () => {
    const first = vi.fn()
    const second = vi.fn()
    const ownerA = new HttpFailureRecorder(first, () => 0)
    const ownerB = new HttpFailureRecorder(second, () => 0)
    ownerA.recordTarget()
    ownerA.recordTarget()
    ownerB.recordTarget()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('contains observer exceptions and reports diagnostic failure at most once with no raw error', () => {
    let now = 0
    const observer = vi.fn(() => { throw new Error('private observer failure') })
    const warning = vi.fn()
    const recorder = new HttpFailureRecorder(observer, () => now, warning)
    expect(() => recorder.recordParser('HPE_HEADER_OVERFLOW')).not.toThrow()
    expect(() => recorder.recordTarget()).not.toThrow()
    expect(() => recorder.recordUpstream('POST', '/api/session/prompt', 400)).not.toThrow()
    now = 30_000
    recorder.recordTarget()
    expect(observer).toHaveBeenCalledTimes(4)
    expect(warning.mock.calls).toEqual([[]])
  })

  it('does not let a failed warning reporter escape to HTTP handling', () => {
    const recorder = new HttpFailureRecorder(
      () => { throw new Error('private observer failure') },
      () => 0,
      () => { throw new Error('private reporter failure') },
    )
    expect(() => recorder.recordParser('ERR_HTTP_REQUEST_TIMEOUT')).not.toThrow()
  })

  it('performs no clock or observer work when diagnostics are not configured', () => {
    const now = vi.fn(() => 0)
    const recorder = new HttpFailureRecorder(undefined, now)
    expect(recorder.recordParser('ERR_HTTP_REQUEST_TIMEOUT')).toMatchObject({ status: 408 })
    recorder.recordTarget()
    recorder.recordUpstream('POST', '/api/session/prompt', 400)
    expect(now).not.toHaveBeenCalled()
  })
})
