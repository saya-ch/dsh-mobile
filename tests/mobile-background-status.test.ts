import { describe, expect, it } from 'vitest'
import { mobileBackgroundStatusText } from '../src/client.js'

describe('background reminder connection status', () => {
  it('stays absent when the installed App reports only the legacy enabled flag', () => {
    expect(mobileBackgroundStatusText('en', undefined, undefined)).toBeUndefined()
    expect(mobileBackgroundStatusText('zh', undefined, 'stream:failed')).toBeUndefined()
  })

  it('renders the reported connection state in every supported locale', () => {
    expect(mobileBackgroundStatusText('en', true, undefined)).toBe('Connected')
    expect(mobileBackgroundStatusText('en', false, undefined)).toBe('Not connected')
    expect(mobileBackgroundStatusText('en', false, 'stream:failed')).toBe('Not connected (stream:failed)')
    expect(mobileBackgroundStatusText('zh', true, undefined)).toBe('已连接')
    expect(mobileBackgroundStatusText('zh', false, 'renew:pairing_expired')).toBe('未连接 (renew:pairing_expired)')
    expect(mobileBackgroundStatusText('it', false, undefined)).toBe('Non connesso')
  })
})
