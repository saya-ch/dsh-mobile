import { Service, type Context } from '@deepseek-ai/cordis'
import type { PushCustomNotification, PushCustomNotificationResult } from './contracts.js'

export type SendCustomPush = (input: PushCustomNotification) => Promise<PushCustomNotificationResult>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Trusted Host-plugin API for explicit, consent-checked web-push notifications. */
    mobilePush: MobilePushService
  }
}

/**
 * Small Cordis service exposed to trusted Host plugins. The provider owns the
 * runtime lifetime and all recipient, category, session, and expiry checks.
 */
export class MobilePushService extends Service {
  constructor(ctx: Context, private readonly send: SendCustomPush) {
    super(ctx, 'mobilePush')
  }

  /**
   * Queue a notification for enabled web-push recipients.
   * @param input - Session, text, optional category and optional expiry.
   * @returns The number of newly queued recipient deliveries and the applied expiry.
   */
  async notify(input: PushCustomNotification): Promise<PushCustomNotificationResult> {
    return await this.send(input)
  }
}
