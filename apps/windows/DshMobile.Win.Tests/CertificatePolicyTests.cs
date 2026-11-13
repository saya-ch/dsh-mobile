using System.Net;
using System.Security.Cryptography;
using Xunit;

namespace DshMobile.Win.Tests;

public class CertificatePolicyTests
{
    [Fact]
    public void ValidateFetchedCa_AcceptsMatchingSelfSignedCa()
    {
        var (_, der, id) = TestCertificates.CreateCa();
        var ca = CertificatePolicy.ValidateFetchedCa(der, id);
        Assert.NotNull(ca);
        Assert.Equal(id, Convert.ToHexString(SHA256.HashData(ca.RawData)).ToLowerInvariant());
    }

    [Fact]
    public void ValidateFetchedCa_RejectsWrongFingerprint()
    {
        var (_, der, _) = TestCertificates.CreateCa();
        Assert.Null(CertificatePolicy.ValidateFetchedCa(der, new string('0', 64)));
    }

    [Fact]
    public void ValidateFetchedCa_RejectsLeafCertificate()
    {
        var (ca, _, _) = TestCertificates.CreateCa();
        var leaf = TestCertificates.CreateLeaf(ca, ["example.ts.net"]);
        Assert.Null(CertificatePolicy.ValidateFetchedCa(leaf.RawData, new string('a', 64)));
    }

    [Fact]
    public void ValidateFetchedCa_RejectsOversizedOrEmptyPayload()
    {
        Assert.Null(CertificatePolicy.ValidateFetchedCa([], new string('a', 64)));
        Assert.Null(CertificatePolicy.ValidateFetchedCa(new byte[5000], new string('a', 64)));
    }

    [Fact]
    public void ValidateLeaf_RequiresExactDnsSan()
    {
        var (ca, _, _) = TestCertificates.CreateCa();
        var leaf = TestCertificates.CreateLeaf(ca, ["example.ts.net"]);
        Assert.True(CertificatePolicy.ValidateLeaf(leaf, ca, "example.ts.net"));
        Assert.False(CertificatePolicy.ValidateLeaf(leaf, ca, "other.ts.net"));
    }

    [Fact]
    public void ValidateLeaf_AcceptsOneLevelWildcard()
    {
        var (ca, _, _) = TestCertificates.CreateCa();
        var leaf = TestCertificates.CreateLeaf(ca, ["*.ts.net"]);
        Assert.True(CertificatePolicy.ValidateLeaf(leaf, ca, "foo.ts.net"));
        Assert.False(CertificatePolicy.ValidateLeaf(leaf, ca, "a.b.ts.net"));
    }

    [Fact]
    public void ValidateLeaf_AcceptsIpSan()
    {
        var (ca, _, _) = TestCertificates.CreateCa();
        var leaf = TestCertificates.CreateLeaf(ca, [], IPAddress.Parse("192.168.1.7"));
        Assert.True(CertificatePolicy.ValidateLeaf(leaf, ca, "192.168.1.7"));
        Assert.False(CertificatePolicy.ValidateLeaf(leaf, ca, "192.168.1.8"));
    }

    [Fact]
    public void ValidateLeaf_RejectsCertificateWithWrongIssuer()
    {
        var (ca, _, _) = TestCertificates.CreateCa();
        var (otherCa, _, _) = TestCertificates.CreateCa();
        var leaf = TestCertificates.CreateLeaf(otherCa, ["example.ts.net"]);
        Assert.False(CertificatePolicy.ValidateLeaf(leaf, ca, "example.ts.net"));
    }
}
