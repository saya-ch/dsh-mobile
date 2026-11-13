using System.Security.Cryptography;
using Xunit;

namespace DshMobile.Win.Tests;

public class PairingDescriptorTests
{
    [Fact]
    public void DecodeBase64Url32_AcceptsCanonicalToken()
    {
        var raw = new byte[32];
        RandomNumberGenerator.Fill(raw);
        var token = Convert.ToBase64String(raw).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        Assert.Equal(raw, PairingDescriptor.DecodeBase64Url32(token));
    }

    [Fact]
    public void DecodeBase64Url32_RejectsNonCanonicalOrWrongSize()
    {
        Assert.Throws<FormatException>(() => PairingDescriptor.DecodeBase64Url32(new string('A', 43) + "A"));
        Assert.Throws<FormatException>(() => PairingDescriptor.DecodeBase64Url32(new string('A', 20)));
        Assert.Throws<FormatException>(() => PairingDescriptor.DecodeBase64Url32("not base64!!"));
    }

    [Fact]
    public void DeriveHostname_SplitsEndpointIdIntoTwoLabels()
    {
        var endpoint = new string('a', 32) + new string('b', 32);
        Assert.Equal($"{new string('a', 32)}.{new string('b', 32)}.iroh.localhost",
            PairingDescriptor.DeriveHostname(endpoint));
    }

    [Fact]
    public void Parse_RejectsOversizedPayload()
    {
        Assert.Throws<FormatException>(() => PairingDescriptor.Parse(new string('x', 3000)));
    }
}
