import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { MobilePushService } from '../src/mobile-push/service.js'

describe('MobilePushService', () => {
  it('exposes the trusted Host-plugin notify method without owning recipient state', async () => {
    const context = new Context()
    const send = vi.fn(async () => ({ queued: 2, expiresAt: 123 }))
    try {
      new MobilePushService(context, send)
      await expect(context.mobilePush.notify({ sessionId: 'session-a', title: 'A', body: 'B' }))
        .resolves.toEqual({ queued: 2, expiresAt: 123 })
      expect(send).toHaveBeenCalledWith({ sessionId: 'session-a', title: 'A', body: 'B' })
    } finally {
      await context.fiber.dispose()
    }
  })
})
