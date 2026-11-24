using System.Security.Cryptography.X509Certificates;
using Xunit;

namespace DshMobile.Win.Tests;

/// <summary>
/// The WebView2 surface cannot report which certificate a response used, and its
/// error event only fires when Chromium's own validation fails. A certificate the
/// platform already trusts would therefore load the page without the pairing CA
/// ever being checked, so the client verifies the pin over its own handshake
/// first. These cases pin down the decision that gate depends on.
/// </summary>
public class PinnedOriginGateTests
{
    [Fact]
    public void AcceptsALeafThatChainsToThePinnedCa()
    {
        var (ca, _, _) = TestCertificates.CreateCa();
        using var leaf = TestCertificates.CreateLeaf(ca, ["gateway.test"]);
        Assert.True(CertificatePolicy.ValidateLeaf(leaf, ca, "gateway.test"));
    }

    [Fact]
    public void RejectsALeafFromAnotherCaEvenWhenThePlatformWouldTrustIt()
    {
        // The bypass this gate closes: a certificate that is perfectly valid on its
        // own — an enterprise TLS-inspection root, or a public CA for a reassigned
        // tunnel hostname — must not satisfy the pin.
        var (pinned, _, _) = TestCertificates.CreateCa();
        var (other, _, _) = TestCertificates.CreateCa();
        using var leaf = TestCertificates.CreateLeaf(other, ["gateway.test"]);
        Assert.False(CertificatePolicy.ValidateLeaf(leaf, pinned, "gateway.test"));
    }

    [Fact]
    public void RejectsALeafIssuedForADifferentHostname()
    {
        var (ca, _, _) = TestCertificates.CreateCa();
        using var leaf = TestCertificates.CreateLeaf(ca, ["elsewhere.test"]);
        Assert.False(CertificatePolicy.ValidateLeaf(leaf, ca, "gateway.test"));
    }

    [Fact]
    public void RejectsAMissingCertificate()
    {
        var (ca, _, _) = TestCertificates.CreateCa();
        Assert.False(CertificatePolicy.ValidateLeaf(null, ca, "gateway.test"));
    }
}
