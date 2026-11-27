// Regression guard for the probe's address choice: an iroh row's hostname is a
// synthetic *.iroh.localhost identity that only the sidecar's loopback proxy
// answers for. The probe used system DNS, which cannot resolve that name, so every
// iroh connection failed before reaching the gateway and was reported as a
// certificate mismatch.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  fileURLToPath(new URL('../apps/windows/DshMobile.Win/MainWindow.xaml.cs', import.meta.url)),
  'utf8',
)

describe('Windows pinned-origin probe', () => {
  it('resolves the iroh row to the loopback proxy instead of asking DNS', () => {
    const start = source.indexOf('private static async Task<bool> VerifyPinnedOriginAsync')
    expect(start).toBeGreaterThan(0)
    const body = source.slice(start, start + 3000)
    // The channel check has to come before the DNS lookup, and it has to pick
    // Loopback — anything else sends iroh traffic to a hostname nothing answers for.
    expect(body).toMatch(/device\.Channel == "iroh"\s*\?\s*IPAddress\.Loopback/u)
    expect(body.indexOf('device.Channel == "iroh"')).toBeLessThan(body.indexOf('Dns.GetHostAddressesAsync'))
  })

  it('keeps the TLS server name from the hostname, not from the socket address', () => {
    const start = source.indexOf('private static async Task<bool> VerifyPinnedOriginAsync')
    const body = source.slice(start, start + 3000)
    // Connecting to 127.0.0.1 must not change SNI: the pin is checked against the
    // name the certificate was issued for.
    expect(body).toContain('TargetHost = device.Hostname')
    expect(body).toContain('ValidateLeaf(observed, device.Ca, device.Hostname)')
  })

  it('does not describe every failed probe as a certificate mismatch', () => {
    // A probe can fail because the gateway is unreachable; accusing the network of
    // interception in that case is a false security signal.
    const throwSite = source.indexOf('VerifyPinnedOriginAsync(device, _connectCts.Token, Log)')
    expect(throwSite).toBeGreaterThan(0)
    const message = source.slice(throwSite, throwSite + 400)
    // The copy moved into Resources/Strings.resx, so the guard follows it there: the site
    // must reference the network-failure key, not the certificate-mismatch one.
    expect(message).toContain('Strings.Connect_PinnedCertVerifyFailed')
    expect(message).not.toContain('Strings.Pairing_CaMismatch')
    const resources = readFileSync(
      fileURLToPath(new URL('../apps/windows/DshMobile.Win/Resources/Strings.resx', import.meta.url)),
      'utf8',
    )
    const copy = /<data name="Connect_PinnedCertVerifyFailed"[^>]*>\s*<value>([^<]*)<\/value>/.exec(resources)
    expect(copy).not.toBeNull()
    expect(copy![1]).toContain('可能是网络不通')
  })
})
