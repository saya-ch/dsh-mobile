using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace DshMobile.Win;

/// <summary>
/// App-private TLS trust anchored to the CA carried by the pairing descriptor.
/// Equivalent to PinnedTls.kt: custom root, validity, issuer, EKU and exact SAN.
/// Never used to relax platform validation for unrelated hosts.
/// </summary>
internal static class CertificatePolicy
{
    private const string ServerAuthOid = "1.3.6.1.5.5.7.3.1";
    private const string SanOid = "2.5.29.17";

    internal static bool IsSelfSignedCa(X509Certificate2 ca)
    {
        if (ca.Subject != ca.Issuer) return false;
        if (!IsCa(ca)) return false;
        return ChainBuilds(ca, ca, requireServerAuth: false);
    }

    private static bool IsCa(X509Certificate2 certificate)
    {
        var extension = certificate.Extensions.FirstOrDefault(e => e.Oid?.Value == "2.5.29.19");
        if (extension is null) return false;
        return new X509BasicConstraintsExtension(extension, extension.Critical).CertificateAuthority;
    }

    internal static bool ValidateLeaf(X509Certificate2? leaf, X509Certificate2 ca, string hostname)
    {
        if (leaf is null || leaf.Issuer != ca.Subject) return false;
        var now = DateTime.UtcNow;
        if (now < ca.NotBefore.ToUniversalTime() || now > ca.NotAfter.ToUniversalTime()) return false;
        if (now < leaf.NotBefore.ToUniversalTime() || now > leaf.NotAfter.ToUniversalTime()) return false;
        if (IsCa(leaf)) return false;
        var ekuExtension = leaf.Extensions.FirstOrDefault(e => e.Oid?.Value == "2.5.29.37");
        if (ekuExtension is not null)
        {
            var eku = new X509EnhancedKeyUsageExtension(ekuExtension, ekuExtension.Critical);
            if (!eku.EnhancedKeyUsages.Cast<Oid>().Any(o => o.Value == ServerAuthOid)) return false;
        }
        return ChainBuilds(leaf, ca, requireServerAuth: true) && MatchesSan(leaf, hostname);
    }

    private static bool ChainBuilds(X509Certificate2 leaf, X509Certificate2 ca, bool requireServerAuth)
    {
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(ca);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        chain.ChainPolicy.VerificationFlags = X509VerificationFlags.NoFlag;
        if (requireServerAuth) chain.ChainPolicy.ApplicationPolicy.Add(new Oid(ServerAuthOid));
        return chain.Build(leaf);
    }

    /// <summary>Exact DNS SAN, or one-level wildcard with the same label count (matches PinnedTls.kt);
    /// LAN gateways also present IP SANs, so literal hostnames compare against those too.</summary>
    private static bool MatchesSan(X509Certificate2 leaf, string hostname)
    {
        var extension = leaf.Extensions.FirstOrDefault(e => e.Oid?.Value == SanOid);
        if (extension is null) return false;
        var san = new X509SubjectAlternativeNameExtension(extension.RawData, extension.Critical);
        var host = hostname.ToLowerInvariant();
        foreach (var dns in san.EnumerateDnsNames())
        {
            var candidate = dns.ToLowerInvariant();
            if (candidate == host) return true;
            if (candidate.StartsWith("*.", StringComparison.Ordinal) &&
                host.EndsWith(candidate[1..], StringComparison.Ordinal) &&
                host.Count(c => c == '.') == candidate.Count(c => c == '.')) return true;
        }
        if (IPAddress.TryParse(host, out var expected))
        {
            // iPAddress SAN entries are primitive context-tag 7 OCTET STRINGs inside
            // the GeneralNames sequence; decode them by hand (net8 lacks an IP enumerator).
            var reader = new System.Formats.Asn1.AsnReader(extension.RawData, System.Formats.Asn1.AsnEncodingRules.DER);
            var names = reader.ReadSequence();
            while (names.HasData)
            {
                var tag = names.PeekTag();
                if (tag.TagClass == System.Formats.Asn1.TagClass.ContextSpecific &&
                    tag.TagValue == 7 && !tag.IsConstructed)
                {
                    var bytes = names.ReadOctetString(
                        new System.Formats.Asn1.Asn1Tag(System.Formats.Asn1.TagClass.ContextSpecific, 7));
                    if (bytes.Length is 4 or 16 && new IPAddress(bytes).Equals(expected)) return true;
                }
                else names.ReadEncodedValue();
            }
        }
        return false;
    }

    /// <summary>
    /// Validates a CA fetched from /mobile-access/ca.cer against the instance id carried
    /// by the pairing link (PairingTrust.validateCertificate): DER parses, self-signed CA,
    /// currently valid, and SHA-256 == instanceId. Null when any check fails.
    /// </summary>
    internal static X509Certificate2? ValidateFetchedCa(byte[]? der, string instanceId)
    {
        if (der is null || der.Length == 0 || der.Length > 4096) return null;
        X509Certificate2 certificate;
        try { certificate = new X509Certificate2(der); }
        catch { return null; }
        if (!certificate.RawData.SequenceEqual(der)) return null;
        if (!IsSelfSignedCa(certificate)) return null;
        var now = DateTime.UtcNow;
        if (now < certificate.NotBefore.ToUniversalTime() || now > certificate.NotAfter.ToUniversalTime()) return null;
        return Convert.ToHexString(SHA256.HashData(der)).ToLowerInvariant() == instanceId ? certificate : null;
    }
}
