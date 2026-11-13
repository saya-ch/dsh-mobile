namespace DshMobile.Win;

/// <summary>Outcome of the <c>/mobile-access/ca.cer</c> bootstrap step.</summary>
internal enum CaBootstrapOutcome
{
    /// <summary>A CA was served; it must still pass the instanceId fingerprint check.</summary>
    PinnedCa,
    /// <summary>Explicit 404 on a public-CA remote key: keep the platform trust store.</summary>
    PlatformTrust,
    /// <summary>Any other status, or a 404 that this pairing key forbids.</summary>
    Reject,
}

/// <summary>
/// Mirrors Android's <c>PairingTrust.selectTrustAnchor</c> + <c>RemotePairingTrust.decide</c>:
/// a LAN gateway always serves its pairing CA; a remote dsh2 key also requires it;
/// only a public-CA dsh1/legacy remote key may fall back to system trust after an
/// explicit 404. An already pinned device must never be downgraded.
///
/// Kept as a pure function so the 404 paths are unit-testable without a TLS stack.
/// </summary>
internal static class PairingTrustPolicy
{
    internal static CaBootstrapOutcome Decide(int status, SavedDevice device)
    {
        if (status is >= 200 and <= 299) return CaBootstrapOutcome.PinnedCa;
        if (status != 404) return CaBootstrapOutcome.Reject;
        // A LAN gateway always serves its pairing CA, so a 404 there is an identity failure.
        if (device.Channel != "remote") return CaBootstrapOutcome.Reject;
        // A device that already carries a pinned CA keeps pinning it (preserveRemotePin).
        if (device.HasPinnedCa) return CaBootstrapOutcome.Reject;
        // dsh2 (and any other link that requires a pairing CA) hard-fails on 404.
        if (device.RequiresCa) return CaBootstrapOutcome.Reject;
        return CaBootstrapOutcome.PlatformTrust;
    }
}
