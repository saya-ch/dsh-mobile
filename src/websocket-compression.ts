/** Terminate optional browser WebSocket compression at the authenticated Mobile gateway. */
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import WebSocket, { WebSocketServer, type RawData } from 'ws'

/** Resolved limits for one gateway's optional WebSocket compression bridge. */
export interface WebSocketCompressionOptions {
  /** Maximum decoded message size in either direction. */
  readonly maxMessageBytes: number
  /** Maximum queued payload and frame-header bytes in either direction. */
  readonly maxQueuedBytes: number
  /** Minimum message bytes considered for browser-facing compression. */
  readonly thresholdBytes: number
  /** ws process-wide zlib concurrency setting, established by its first compressed connection. */
  readonly concurrencyLimit: number
  /** zlib compression level for browser-facing messages. */
  readonly level: number
}

/** Close handle an accepted compressed bridge exposes to its gateway owner. */
export interface CompressedWebSocketBridge {
  /**
   * Stop relaying and start the WebSocket close handshake on both legs.
   * Later frames are dropped, so no data frame follows the Close frame.
   * Calls after the bridge stopped, or before it accepted the client, are ignored.
   */
  close(code: number, reason: string): void
}

function payloadBytes(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((bytes, part) => bytes + part.byteLength, 0)
  return data.byteLength
}

function forwardableClose(code: number): boolean {
  return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006)
    || (code >= 3000 && code <= 4999)
}

/**
 * Bridge an authorized HTTP upgrade, negotiating compression only with the client.
 * Errors after acceptance close both legs. Socket destruction by the gateway also
 * releases the ws wrappers, pending compression, and handshake/close timers.
 * @param request - validated browser upgrade request.
 * @param client - gateway-owned client socket, paused during authorization.
 * @param upstream - gateway-owned loopback socket, connecting or connected.
 * @param head - bytes the HTTP parser read after the client's upgrade headers.
 * @param target - validated upstream URL, including the original query.
 * @param upstreamCookie - gateway's signed upstream cookie; browser cookies are discarded.
 * @param options - resolved message, queue, and compression limits.
 * @param handshakeTimeoutMs - maximum handshake and close-handshake duration.
 * @returns the close handle after both HTTP upgrades are accepted, or rejection before acceptance.
 */
export function bridgeCompressedWebSocket(
  request: IncomingMessage,
  client: Socket,
  upstream: Socket,
  head: Buffer,
  target: URL,
  upstreamCookie: string | undefined,
  options: Readonly<WebSocketCompressionOptions>,
  handshakeTimeoutMs: number,
): Promise<CompressedWebSocketBridge> {
  return new Promise((resolve, reject) => {
    let incoming: WebSocket | undefined
    let outgoing: WebSocket | undefined
    let server: WebSocketServer | undefined
    let accepted = false
    let stopped = false
    let closing = false
    let closeTimer: NodeJS.Timeout | undefined
    const handshakeTimer = setTimeout(() => { stop(new Error('WebSocket bridge handshake timed out')) }, handshakeTimeoutMs)
    handshakeTimer.unref()

    const stop = (error: Error): void => {
      if (stopped) return
      stopped = true
      clearTimeout(handshakeTimer)
      clearTimeout(closeTimer)
      if (!accepted) reject(error)
      incoming?.terminate()
      outgoing?.terminate()
      client.destroy()
      upstream.destroy()
      server?.close()
    }
    const finish = (): void => {
      if (incoming?.readyState === WebSocket.CLOSED && outgoing?.readyState === WebSocket.CLOSED) {
        stop(new Error('WebSocket bridge closed'))
      }
    }
    const beginClose = (code: number, reason: string): void => {
      if (!accepted) { stop(new Error(reason)); return }
      if (stopped || closing) return
      closing = true
      incoming?.resume()
      outgoing?.resume()
      for (const socket of [incoming, outgoing]) {
        if (socket?.readyState === WebSocket.OPEN) socket.close(code, reason)
      }
      closeTimer = setTimeout(() => { stop(new Error('WebSocket bridge close timed out')) }, handshakeTimeoutMs)
      closeTimer.unref()
    }
    const socketError = (error: Error): void => { stop(error) }
    const socketClosed = (): void => {
      if (!accepted) stop(new Error('WebSocket socket closed before acceptance'))
    }
    client.on('error', socketError)
    upstream.on('error', socketError)
    client.once('close', socketClosed)
    upstream.once('close', socketClosed)

    const wsError = (error: Error & { code?: string }): void => {
      if (!accepted) { stop(error); return }
      beginClose(error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 1009 : 1011,
        error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'Message too large' : 'WebSocket bridge failed')
    }
    const attachRelay = (source: WebSocket, destination: WebSocket): void => {
      let queuedBytes = 0
      const send = (bytes: number, operation: (callback: (error?: Error | null) => void) => void): void => {
        if (stopped || closing) return
        if (destination.readyState !== WebSocket.OPEN) { beginClose(1011, 'WebSocket peer unavailable'); return }
        // Count the RFC 6455 maximum frame header too: empty frames still occupy a queue entry.
        const queued = bytes + 14
        if (queued > options.maxQueuedBytes - queuedBytes) { beginClose(1009, 'WebSocket queue limit'); return }
        queuedBytes += queued
        source.pause()
        const complete = (error?: Error | null): void => {
          queuedBytes -= queued
          if (error != null) { wsError(error); return }
          if (!stopped && !closing && queuedBytes === 0 && source.readyState === WebSocket.OPEN) source.resume()
        }
        try { operation(complete) } catch (error) {
          complete(error instanceof Error ? error : new Error('WebSocket forwarding failed'))
        }
      }
      source.on('message', (data: RawData, binary: boolean) => {
        const bytes = payloadBytes(data)
        if (bytes > options.maxMessageBytes) { beginClose(1009, 'Message too large'); return }
        send(bytes, callback => { destination.send(data, { binary, compress: destination === incoming }, callback) })
      })
      source.on('ping', data => { send(data.byteLength, callback => { destination.ping(data, undefined, callback) }) })
      source.on('pong', data => { send(data.byteLength, callback => { destination.pong(data, undefined, callback) }) })
      source.on('close', (code: number, reason: Buffer) => {
        if (stopped) return
        if (code === 1006 || !forwardableClose(code) && code !== 1005) {
          stop(new Error('WebSocket peer closed without a valid close frame'))
          return
        }
        closing = true
        destination.resume()
        if (destination.readyState === WebSocket.OPEN) {
          if (code === 1005) destination.close()
          else destination.close(code, reason)
        }
        closeTimer ??= setTimeout(() => { stop(new Error('WebSocket bridge close timed out')) }, handshakeTimeoutMs)
        closeTimer.unref()
        finish()
      })
    }

    try {
      if (client.destroyed || upstream.destroyed) throw new Error('WebSocket socket is already closed')
      const protocolHeader = request.headers['sec-websocket-protocol']
      const protocols = typeof protocolHeader === 'string' ? protocolHeader.split(',').map(protocol => protocol.trim()) : []
      const url = new URL(target)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      outgoing = new WebSocket(url, protocols, {
        createConnection: () => upstream,
        handshakeTimeout: handshakeTimeoutMs,
        perMessageDeflate: false,
        autoPong: false,
        followRedirects: false,
        maxPayload: options.maxMessageBytes,
        headers: {
          host: target.host,
          origin: target.origin,
          'sec-fetch-site': 'same-origin',
          ...(upstreamCookie === undefined ? {} : { cookie: upstreamCookie }),
        },
      })
      outgoing.on('error', wsError)
      outgoing.once('close', () => {
        if (!accepted) stop(new Error('Upstream WebSocket closed before acceptance'))
        else finish()
      })
      outgoing.once('open', () => {
        if (stopped || client.destroyed) { stop(new Error('Client closed before WebSocket acceptance')); return }
        upstream.setTimeout(0)
        server = new WebSocketServer({
          noServer: true,
          clientTracking: false,
          autoPong: false,
          maxPayload: options.maxMessageBytes,
          handleProtocols: () => outgoing?.protocol || false,
          perMessageDeflate: {
            clientNoContextTakeover: true,
            serverNoContextTakeover: true,
            threshold: options.thresholdBytes,
            concurrencyLimit: options.concurrencyLimit,
            zlibDeflateOptions: { level: options.level },
          },
        })
        server.on('error', wsError)
        try {
          server.handleUpgrade(request, client, head, socket => {
            incoming = socket
            incoming.on('error', wsError)
            incoming.once('close', finish)
            attachRelay(incoming, outgoing!)
            attachRelay(outgoing!, incoming)
            accepted = true
            clearTimeout(handshakeTimer)
            incoming.resume()
            resolve({ close: beginClose })
          })
        } catch (error) {
          stop(error instanceof Error ? error : new Error('Client WebSocket upgrade failed'))
        }
      })
    } catch (error) { stop(error instanceof Error ? error : new Error('WebSocket bridge setup failed')) }
  })
}
