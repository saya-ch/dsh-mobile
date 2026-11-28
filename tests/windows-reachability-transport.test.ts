// The Windows client must decide reachability the way the Android app does: through the
// authenticated native-probe, not the unauthenticated discovery payload.
//
// Discovery carries the gateway's local listening port beside its public origin, and the two
// only agree on a LAN. Over cpolar, cloudflared or FRP the tunnel terminates at the public port
// while the gateway listens on a private one, so the cross-check rejected healthy tunnels and
// every remote row read "unreachable".
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function source(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../apps/windows/DshMobile.Win/${name}`, import.meta.url)),
    'utf8',
  )
}

describe('Windows reachability transport', () => {
  it('probes through the authenticated endpoint, like the Android app', () => {
    const reachability = source('DeviceReachability.cs')
    // The default probe sends the stored device token.
    expect(reachability).toContain('GatewayAuth.ProbeAsync(device, deviceToken, token)')
    expect(reachability).toContain('device.GetDeviceToken()')

    const auth = source('GatewayAuth.cs')
    expect(auth).toContain('"/mobile-access/auth/native-probe"')
    // Android's NativeAuthClient.probe posts the same path with the same body.
    const android = readFileSync(
      fileURLToPath(new URL(
        '../apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/NativeAuthClient.kt',
        import.meta.url,
      )),
      'utf8',
    )
    expect(android).toContain('"/mobile-access/auth/native-probe"')
    expect(android).toContain('deviceToken')
  })

  it('keeps discovery only as the fallback for gateways without the endpoint', () => {
    const reachability = source('DeviceReachability.cs')
    // Exactly one remaining call site, inside the compatibility path.
    const calls = reachability.match(/LanDiscovery\.ProbeAsync\(/gu) ?? []
    expect(calls).toHaveLength(1)
    expect(reachability).toContain('ProbeWithDiscoveryAsync')
    expect(reachability).toContain('catch (GatewayAuth.ProbeUnsupportedException)')
  })

  it('separates a rejected credential from an unreachable computer', () => {
    const reachability = source('DeviceReachability.cs')
    // Anchor on the catch block: the file mentions Revoked in other places, so a loose
    // assertion would still pass with the classification reverted to Unreachable.
    expect(reachability).toMatch(
      /catch \(GatewayAuth\.ProbeRejectedException\)\s*\{[^}]*DeviceStatusKind\.Revoked/u,
    )
    // And a revocation discovered by a probe must stick, not be re-probed every round.
    expect(reachability).toContain('if (kind == DeviceStatusKind.Revoked) _revoked.Add(device.EndpointId)')
  })

  it('reports a missing local credential as expired rather than probing', () => {
    // Probing without a credential cannot authenticate anything, and blaming the network for
    // a local problem would send the user to the wrong fix.
    const reachability = source('DeviceReachability.cs')
    expect(reachability).toContain('if (deviceToken is null) return DeviceStatusKind.Expired')
  })
})