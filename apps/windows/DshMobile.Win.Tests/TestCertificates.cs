using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace DshMobile.Win.Tests;

/// <summary>Locally generated certificates; no real profiles or credentials are used.</summary>
internal static class TestCertificates
{
    internal static (X509Certificate2 Ca, byte[] Der, string InstanceId) CreateCa()
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest(
            "CN=DSH Mobile Test CA", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(
            X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        var ca = request.CreateSelfSigned(
            DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(30));
        var der = ca.RawData;
        return (ca, der, Convert.ToHexString(SHA256.HashData(der)).ToLowerInvariant());
    }

    internal static X509Certificate2 CreateLeaf(
        X509Certificate2 ca, string[] dnsNames, IPAddress? ipAddress = null)
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest(
            "CN=gateway", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        var san = new SubjectAlternativeNameBuilder();
        foreach (var name in dnsNames) san.AddDnsName(name);
        if (ipAddress is not null) san.AddIpAddress(ipAddress);
        request.CertificateExtensions.Add(san.Build());
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
            new OidCollection { new("1.3.6.1.5.5.7.3.1") }, false));
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        var serial = new byte[16];
        RandomNumberGenerator.Fill(serial);
        return request.Create(ca, DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(10), serial);
    }
}
