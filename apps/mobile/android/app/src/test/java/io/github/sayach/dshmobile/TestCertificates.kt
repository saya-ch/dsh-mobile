package io.github.sayach.dshmobile

import java.io.ByteArrayInputStream
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Base64

/**
 * Deterministic X.509 fixtures for the trust tests.
 *
 * The operational certificates are fixed RSA 2048 fixtures valid 2026-09-23 .. 2036-09-20;
 * [expiredCa] is valid only in 2000. Base64 DER keeps trust tests independent of the network
 * and Keystore:
 *
 *  - [ingressCa] plays the role of the self-signed passthrough entry CA whose SHA-256 fingerprint
 *    the pairing key carries;
 *  - [leafPublicIp] / [leafOtherIp] / [leafDnsName] are leaves issued by [ingressCa], so a leaf can
 *    be accepted or rejected for its subject alternative name alone;
 *  - [foreignCa] and [leafForeignIssuer] model a substituted gateway that serves a certificate the
 *    scanned pairing key never promised;
 *  - [leafLoopback] and [leafLoopbackKey] let a test bind a real TLS server to `127.0.0.1`, so the
 *    fetch that decides pinning runs over an actual handshake.
 */
internal object TestCertificates {
    /** Authentic self-signed CA valid only in 2000, retained solely for expiry regressions. */
    val expiredCa: ByteArray by lazy { decode(
        "MIIC/DCCAeSgAwIBAgIJfGN/h18u6VDYMA0GCSqGSIb3DQEBCwUAMC4xLDAqBgNVBAMTI0V4cGlyZWQgc3RvcmVkLWRldmljZSBDQSByZWdyZXNzaW9uMB4XDTAwMDEwMTAwMDAwMFoXDTAxMDEwMTAwMDAwMFowLjEsMCoGA1UEAxMjRXhwaXJlZCBzdG9yZWQtZGV2aWNlIENBIHJlZ3Jlc3Npb24wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDRZIuLsRtGIpnUhfIgn7jH72ec536x08VflG9YrA8GYeQYCdIWNabvJreyM9iCrA4TEbeLdbCvkfphGfAqN2zrakK0aHM5TwjCBWlsdtbqty8dBUZuKN6zColxDW8X47AIOT5NxMq+0Tx+JEg6rkSS2eQc+P4zwqh0pijDEABpFtW1ZirKwzB5bKt0q8EbpMpGknwDHFIfW8X/WD5evXXKrHwF2K/rqMYquhxd8wwflPLwaK44FQ5NOazBxn4uvE8M4KmpHO8xNm4k0nmzs+0Twz8lshvSJavKyIhSejAu4395YG0fbb1hhkF3Qa9EFpqwA0vBPVgzNgjbwcIFU20vAgMBAAGjHTAbMAwGA1UdEwQFMAMBAf8wCwYDVR0PBAQDAgEGMA0GCSqGSIb3DQEBCwUAA4IBAQCArU4wt42sXeuWuynByOylYGd1NHRs2O5AZRR/DUV7YyVzJEJwbuaRU6sIkjpoy+CLUGQJAs6AGZ1S3h9Rm8Gwo8AeCBZHvs8GHip3KcvGpDYyfIQP1hjFw05wwgJgRlhpRyGPeGvN/A2Jj9Gmd1qv4B35NAicLnDC/t4sbN4mzSi9cJh6nb//k/Y8xwNCthTHri3sbV7+obDnTkMXeLJu2pubZgefHopsLsXZ5u5C0fgjyhWR+A3WzOewb3T98Mhq2g1x1zt8bzLGKxDJeJY2FQK0AZoHJgqQ+gfL2zgUqunfTA2+oxjOijqyyh4lAuLvbNgyQ6FtvrW2eNd8vExG",
    ) }

    /** Self-signed ingress CA that plays the role of the self-signed passthrough entry CA. */
    private const val INGRESS_CA_BASE64 =
        "MIIDWDCCAkCgAwIBAgIUI8gSHQMI56wrF34jGc1VusuTfq0wDQYJKoZIhvcNAQELBQAwRDEnMCUGA1UEAwweRFNIIE1vYmls" +
        "ZSBGUlAgaW5ncmVzcyB0ZXN0IENBMRkwFwYDVQQKDBBEU0ggTW9iaWxlIFRlc3RzMB4XDTI2MDkyMzExNDMwMFoXDTM2MDky" +
        "MDExNDMwMFowRDEnMCUGA1UEAwweRFNIIE1vYmlsZSBGUlAgaW5ncmVzcyB0ZXN0IENBMRkwFwYDVQQKDBBEU0ggTW9iaWxl" +
        "IFRlc3RzMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApACzPSrfdmnnT2eBMom+NjUe6FIuLjpbGTnSRPycWgYc" +
        "JyqTRg92SDpAQ1z7WM8bjAfbXeYL59INNm856+IbSfvCu6OIKrRAmKiqKs8ZnWAT1E0D8AaxvbwtlXiWr+3obQnuONgV+iMh" +
        "AQAeporIdypRJz5jGdJj0X9XFtd5pU7FEWUtQQOEBTa4q5L+IQ1K3vIQB8EdXBrzwtnWSM+tZ/svKQedIK6nNLowTiY9Bv6i" +
        "cCrBWQCAtqmlkbI4sGZlPTYbtS4/IqeRMtG7NjnGNZz7eUs9gb4U5lR7gix1XhcJJ3CqA5iM5gwG2d5eYRCx5PcyWda5YC/+" +
        "bBfkgGvTxQIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUTfeKcNaPoe810RoL" +
        "ydWC5qnvxNkwDQYJKoZIhvcNAQELBQADggEBAHunhpnS7Qi+dFc0yD/LLm1/yN+hIKoz+QjTfLQRIWesLDdYqGmtc+MC6F5E" +
        "H387fXoAsube238sZuFESltqwlBry9LOIf/EWZnDTYi8C4+ZJ+Xo7/VBzdPaqiWe/g1+mTMurRfBDn2ntkfwHysgF8ipdx9E" +
        "tJunnqn9KVSWOpu7tSnnqXe2/GZW4LxRN9XYqNv4vtLUH+iJdj9lh/bNAjn/sYrnTV7+BFSU7PJYx5CI1voyt4JsHJcAox7D" +
        "f97/lUlTgND8qhw1koRTggI5HjxROWHK+v9hdlZn9XbpDDHf4e6uSL9/Z8eMfn9f1dgsVfnKA2koMY30nSsvmbNTGbs="

    /** Self-signed CA of a substituted gateway (never promised by any pairing key). */
    private const val FOREIGN_CA_BASE64 =
        "MIIDQjCCAiqgAwIBAgIUbn1CXVl9jEy9hVHe6qy21lLJ0zMwDQYJKoZIhvcNAQELBQAwOTEcMBoGA1UEAwwTU3Vic3RpdHV0" +
        "ZWQgdGVzdCBDQTEZMBcGA1UECgwQRFNIIE1vYmlsZSBUZXN0czAeFw0yNjA5MjMxMTQzMDlaFw0zNjA5MjAxMTQzMDlaMDkx" +
        "HDAaBgNVBAMME1N1YnN0aXR1dGVkIHRlc3QgQ0ExGTAXBgNVBAoMEERTSCBNb2JpbGUgVGVzdHMwggEiMA0GCSqGSIb3DQEB" +
        "AQUAA4IBDwAwggEKAoIBAQDaHOnAFfCxWSz4ACzAMTT+SERiCQVpD1zX7l4ZlV8VQ/SQQdHm8zT9ImbmXfuP+bGuRRQvcWTx" +
        "mbVNhSzskCUfs5ARe5u2B2Xi5tR2k0pk3W6+TeKkh2Hsc1peHzWh1qP2cqkNTF1YGF2o7+VJGzS8mGlmjnOMnYMOx+dLHQLk" +
        "156pRniHdwPfK0WOgjbciDjjBX/5Q26J+eXbhEjNYCtG7S1cYOgp1HRKkDUyztnywCfU9BD1TUjOsc7VmtOO9iYE7seStQ0z" +
        "6OfnIG3GUHK63JSf2oahmxDtWNXOkOqEdMK1t+kVrTFcM7c2mrblr+FWLazDdzILUOqqCSZL0d5XAgMBAAGjQjBAMA8GA1Ud" +
        "EwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBQ5f/9nc/FBNCXxjyhDxFd/R9tthTANBgkqhkiG9w0BAQsF" +
        "AAOCAQEA0xdQ1NkwyCBtwuKXAV+zlutO8Ee03cmTmu9J0FoLdoRFjMQoF9/zNbiW4YjGqkoBRhy569dDaskvKUpBJarZGwce" +
        "SUgVGyp3R10tgGRneaej+TlDKUSSTUOrsTsD6heAUH8vZjitestGdtISzUldupNXdM83LdUmSQib7pmMHQZacHduc4aKAqGT" +
        "bWOEGp74xCR/WmR4MVpDcUbpUcuQlf6X8Xv4/qsM6bHME/uq+3t3T7XaR8a8Szxb6ecEAp+hO2LmZvx9rdVVW5tP12sBdeGq" +
        "lOCJaA81T0Ps5plQi+4336LDIN1IMYczOqAzxlYvlVbbBLpSdSfICW7ESSlR4Q=="

    /** Entry leaf issued by the ingress CA with SAN IP:65.49.214.186. */
    private const val LEAF_PUBLIC_IP_BASE64 =
        "MIIDoDCCAoigAwIBAgIUKs4pdDt1yQ91Uv0Pj0F9WMlEP5swDQYJKoZIhvcNAQELBQAwRDEnMCUGA1UEAwweRFNIIE1vYmls" +
        "ZSBGUlAgaW5ncmVzcyB0ZXN0IENBMRkwFwYDVQQKDBBEU0ggTW9iaWxlIFRlc3RzMB4XDTI2MDkyMzExNDMwOVoXDTM2MDky" +
        "MDExNDMwOVowRjEpMCcGA1UEAwwgRFNIIE1vYmlsZSBGUlAgaW5ncmVzcyB0ZXN0IGxlYWYxGTAXBgNVBAoMEERTSCBNb2Jp" +
        "bGUgVGVzdHMwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCQwsRzrkavT9bqRguYO6aFd/4xa48w97CZDLnze30q" +
        "7kwrW4OP5Kc7Ucjhkix+1ak/wMyR/brWxDyTpvA760C4JYbHQwx2TST8eGNgAEPEeOH3OwAiLnr03bkxuqhkAxWSoC1OkCWZ" +
        "J/kCFike9gHvezvd67vTsVk8zL+bSWfz32fsODIzQCLWz5XHPYgpfdb2oL/6Z5gBzs5EzI6Gpe1eVySXchyCpLk85/oeT/QU" +
        "ljkGDYrFB3MwHjWUS6cSk4gKN6gXU+/nl79stICIDAw4yQ/qFUN5H8QK23gyATieFxdO3EI6YmU7i1wS7mi8wO83AkpnCpXg" +
        "wnL6eoR4YgmJAgMBAAGjgYcwgYQwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEw" +
        "DwYDVR0RBAgwBocEQTHWujAdBgNVHQ4EFgQUMY7yVjr+kyqQfcBFpomYROBePrMwHwYDVR0jBBgwFoAUTfeKcNaPoe810RoL" +
        "ydWC5qnvxNkwDQYJKoZIhvcNAQELBQADggEBAIUF3PR5PRZvMpQVOZ2dY6scjVexDbFXMcpISzzelEFQwKKJIC5H/X70Z5se" +
        "o/nrIW1iuA30tZFD6ImaYHj/9xnB4tt1Ycw476Nw3P0f4CBHpYogv3GJM8J+kXzGuWKbIbu/Uedbu4SjTtlxXxDZQHNYa95d" +
        "HOsmCtyZ6O8t+f6W3ahVjqOYb3uhajZcRrk9VJHPKB10LiTZVq7WlVNOTHjyjkgohJ5l/LPnPqtmDRSeZBZRcJtw14WZBn6s" +
        "MJapL0/86Z/XMmdPFPj3G2FmwydK9gxTq4oTpsms+iqXkRX1qlWNh1eh4GbWfyRA81UkYrLpOeAvzS8Y4KPo56PEf/g="

    /** Entry leaf issued by the ingress CA with SAN IP:10.11.12.13. */
    private const val LEAF_OTHER_IP_BASE64 =
        "MIIDoDCCAoigAwIBAgIUOhVfe0+VLgxJpGMz9mC1lcN43/gwDQYJKoZIhvcNAQELBQAwRDEnMCUGA1UEAwweRFNIIE1vYmls" +
        "ZSBGUlAgaW5ncmVzcyB0ZXN0IENBMRkwFwYDVQQKDBBEU0ggTW9iaWxlIFRlc3RzMB4XDTI2MDkyMzExNDMwOVoXDTM2MDky" +
        "MDExNDMwOVowRjEpMCcGA1UEAwwgRFNIIE1vYmlsZSBGUlAgaW5ncmVzcyB0ZXN0IGxlYWYxGTAXBgNVBAoMEERTSCBNb2Jp" +
        "bGUgVGVzdHMwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCt/HBWcY+nHytTV0GuitQ9lZs3JAKEnlh7V9z+okV0" +
        "1CVDoNUlQ3pTGEia6fy6DbsvK1zZJDJXeg6hyGQxcbf1LjBEOoKkz6TDanHJiEUcULUzkx8NkSW0oW/QcLRIz5Fp3S9qyqmT" +
        "WdngOT0vjgH9FAEJ9A2UYncxY7tSBP6fGoS9+MDJX5d1jeARu0mMSBB1fin6bAqE7CBNPlyVMzOwxBRo7c+2/zSsDe+gL0zF" +
        "bp24Sea8TDzNH2CGerQlsY3VUJ4Siefx4jrPq7GLkHYrRrR94LZmF+vtxw2jnAYZ+xkTl3cGByw4JbyYlhIs5QmV5Hmom5r7" +
        "QO/0IO1Fo03TAgMBAAGjgYcwgYQwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEw" +
        "DwYDVR0RBAgwBocECgsMDTAdBgNVHQ4EFgQUTwgMcjM9E0a9WbYezPnBJojzFycwHwYDVR0jBBgwFoAUTfeKcNaPoe810RoL" +
        "ydWC5qnvxNkwDQYJKoZIhvcNAQELBQADggEBAFYLm+Bf2xaVby9Z0+GkyCO+XQCIiQrGWnVHGPc8shU3NJm0vcS9nuk1/QnT" +
        "wdiByQfnfeyP9m1VTOIaxVg6E0/USK/JtRkfUX+j6mbfKLyouSYKnMF+rRvZrQpIG0DXktul46hCOsz7UPc9FFZC4NupXoK9" +
        "YFs282FsbvzTMccCbnFBQTWlt5m4FW/31VGa6YcDRxN5Q6IGKan1akI5gpC/l6fWuTLlr3rLfW/kAoPkJE7PkXmuFbCYrrs2" +
        "Biqyu5P8U/m6nfqs7S0zsVTyTnRkHDyAQlNYbwQdS23c5Za7bPM2rBmG6xmBGe3FatbIzO5OXa0rWVb4Sfz+7wcPA2c="

    /** Entry leaf issued by the ingress CA with SAN DNS:entry.example.com. */
    private const val LEAF_DNS_NAME_BASE64 =
        "MIIDrTCCApWgAwIBAgIUNwPcLro6aSWvGVwTVcSe0vjr3EgwDQYJKoZIhvcNAQELBQAwRDEnMCUGA1UEAwweRFNIIE1vYmls" +
        "ZSBGUlAgaW5ncmVzcyB0ZXN0IENBMRkwFwYDVQQKDBBEU0ggTW9iaWxlIFRlc3RzMB4XDTI2MDkyMzExNDMwOVoXDTM2MDky" +
        "MDExNDMwOVowRjEpMCcGA1UEAwwgRFNIIE1vYmlsZSBGUlAgaW5ncmVzcyB0ZXN0IGxlYWYxGTAXBgNVBAoMEERTSCBNb2Jp" +
        "bGUgVGVzdHMwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC6DI4ofRBESbABoKGWct4quNfV8RiXv/wgu6FMf0JR" +
        "oQSTVQW6CgYOEaHCCE7gx0M8/2jDIzYFbXprNx7CDjBK/p5pC80sXTkxGvDT2FNN13pD5QkiEIdnApLWD5xJukc1OsHezaLl" +
        "60BJUmYnQyntEsXp3mnPkyBmTvHGAA/tgVmi6xbJeHLPqlpEcxSGKWtcZj7tau2lHeIoCs55LpxHVC0DY8ksxJbIW/gY3awp" +
        "tdQ3xxn+aromIsB5SBHmN7gjCAUH7JPBQ0qzR79p9arfTtQLmdsVGP8j9hK7AwQhnwnjDbzvdcYhK0zqXDXZ8CPeW2keWiKu" +
        "xN4Mvqz4vrm3AgMBAAGjgZQwgZEwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEw" +
        "HAYDVR0RBBUwE4IRZW50cnkuZXhhbXBsZS5jb20wHQYDVR0OBBYEFDTatfaL1PUs/A8DAe1uVqbFzJHpMB8GA1UdIwQYMBaA" +
        "FE33inDWj6HvNdEaC8nVguap78TZMA0GCSqGSIb3DQEBCwUAA4IBAQCVFXDMYH+Lvn1ECYXaA+kGoYv/TzFeYVU9SKxD3jsr" +
        "CCsJcupv2fjEPTI+e8lCKakDOsofYJJzf01gL3H5pWTQtFCTMkbSyvRB+tUa8T++TAujChlB4sRsxAlocpQNDLJXP2cdchoV" +
        "bf69etXWsEWGA5WaS3XZnUPCPgz2bkyl11zXk2qJ6OrvNmO2yFRI4HVJdQppEwH4GeBb8ZsI8/+pmjJCW7ThQcU1N/NthYsN" +
        "3Hcco70QYa2ixlmY0U2D+xYNLv3IrhdwrORbnF+y/T2LG5kQ6zwd4EA+hL/YdokUZURfsBC/0mIsmV5m2G2IETJRlmHMDuZN" +
        "6W8YRHUVXoSt"

    /** Entry leaf with the public IP SAN issued by the foreign CA. */
    private const val LEAF_FOREIGN_ISSUER_BASE64 =
        "MIIDlTCCAn2gAwIBAgIUPe51KFBwDKIqBikUr67CHxiXvYkwDQYJKoZIhvcNAQELBQAwOTEcMBoGA1UEAwwTU3Vic3RpdHV0" +
        "ZWQgdGVzdCBDQTEZMBcGA1UECgwQRFNIIE1vYmlsZSBUZXN0czAeFw0yNjA5MjMxMTQzMDlaFw0zNjA5MjAxMTQzMDlaMEYx" +
        "KTAnBgNVBAMMIERTSCBNb2JpbGUgRlJQIGluZ3Jlc3MgdGVzdCBsZWFmMRkwFwYDVQQKDBBEU0ggTW9iaWxlIFRlc3RzMIIB" +
        "IjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnCBmqzeUOreREN3fZg0tCh6F96J0IVn2RiJVaSDYNAJOiRnzj7I/FEbj" +
        "eHjXE+bg5Q7LlILvtSRlqFrjSZJ7WsSjnFbVRiGfQyHOSaX7+fry/z7kSvsMsEbYY6hhbTJzz7678lDH4v4mgqz3Wl0XPamX" +
        "bi1Mg8I9Hf1t5mwOsffK3AtFxkdJZbC16i3h2VQ2K9vVGep0ikFP2Ew2qPu8s40O/3cCSeuS7SSrAFgEBnmktuvPOSChTb9I" +
        "vwH6NicnOP+WX+KsTiEsqK2goxU3SAk5+Dr/oas6dfItIKqlw6TNWY9WiS/0OWmoumK6k2TuhLv5u9oFqcyY39Gp6AMDTwID" +
        "AQABo4GHMIGEMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgWgMBMGA1UdJQQMMAoGCCsGAQUFBwMBMA8GA1UdEQQIMAaH" +
        "BEEx1rowHQYDVR0OBBYEFGFniPl2U99+k9bs6nsndhxUYxrBMB8GA1UdIwQYMBaAFDl//2dz8UE0JfGPKEPEV39H222FMA0G" +
        "CSqGSIb3DQEBCwUAA4IBAQCa8ZZpDELkQJI/u6wCS+wv/OUmJiwTKUhLnyjb+p+pAM2E/eOWz5O82EzZiSG8rw0REitF+mdI" +
        "4wHZva+ICbD6+p09QPbyLQB578nFSd63EKM7N3x9OrAXc/L+RMDUWfkT6RqSx/vzapj9BVPbCSXBXx3T24T9fz4xxYaId9sJ" +
        "0PMe6zQmpLjatTDd1NECuXlNDyv70LwVoy2UrnBnSZxTPZwe/3dPB14evs5e4RW1prJ1WBk8EryRBvFzDgZOlKaAgupCl6R4" +
        "Ey+GKnAqdwB0MvEfZ5toTIkzEev+M7+6mHtBnP0hFw8LOVREHF4/7ocL5Xad0Q0A3+6cJef9s7t9"

    /** entry leaf issued by the ingress CA with SAN IP:127.0.0.1, used by the local TLS test server. */
    private const val LEAF_LOOPBACK_BASE64 =
        "MIIDqTCCApGgAwIBAgIUJzpGyj3KWHd6fQ2bCXuytV4wmFgwDQYJKoZIhvcNAQELBQAwRDEnMCUGA1UEAwweRFNIIE1vYmls" +
        "ZSBGUlAgaW5ncmVzcyB0ZXN0IENBMRkwFwYDVQQKDBBEU0ggTW9iaWxlIFRlc3RzMB4XDTI2MDkyMzExNTMxOVoXDTM2MDky" +
        "MDExNTMxOVowTzEyMDAGA1UEAwwpRFNIIE1vYmlsZSBGUlAgaW5ncmVzcyB0ZXN0IGxvb3BiYWNrIGxlYWYxGTAXBgNVBAoM" +
        "EERTSCBNb2JpbGUgVGVzdHMwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC/4gTXTvRjp3t56ztRdMGPBf/gs/Yy" +
        "fXP8BQ50N9lBf/I4593IIIv4ewuJ8sIUYpk+TyliSkYeVpLVu5OcU47bREb/gdBrQ8N7cWxBzwAuM8JoFtXFFrXSMFhxhbZ0" +
        "4OfvInds75zH4NZprQbuCGsyF5gmA4vbsdOVAIrhXxzeT8XfGGAESBQ/ZS5sl4BrhQmoLbfmN3GkildIOHOoVrgWcfTbHQr2" +
        "DPKHl2/fC3Z4tRMW1WBhIj01o6FaReVK40GVkdEzUgdGX2ACeZsmhZxC0JgcB1Q56q7x64oBfjvE3hrt45p7z7/zBIOI207i" +
        "wkrfK4m8Uea5RU9arSenLtsdAgMBAAGjgYcwgYQwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCBaAwEwYDVR0lBAwwCgYI" +
        "KwYBBQUHAwEwDwYDVR0RBAgwBocEfwAAATAdBgNVHQ4EFgQUSW517JJxyJ6GRRKlSyVEF1dRhS0wHwYDVR0jBBgwFoAUTfeK" +
        "cNaPoe810RoLydWC5qnvxNkwDQYJKoZIhvcNAQELBQADggEBADSMbA8DxgKYq1j5kvIG2IntMdQ31PyJj3f88VT6AETTnfRg" +
        "eJkSjAIvHYB8RLwRMSOra0Rh0EaQuB/i0PQpLQZyclmwhb3fi5y6kvsl75Tx0O3oh93fNyQl7L4VA59A+/KvUn0PUlMUfTso" +
        "lR0V3Lq+1/QPpqqfh3XnPWV2JB6m/xJ+AFievfXXWhddiPAFZcyGo0iPsR9kQ2M6ZwmQ8Etxu1Z/kda3VL3J5Y3E4io2S7qB" +
        "w9m5df5IebR5REYD8uhint1nQv4vigH+Qag27k02tbs3YP6oZUK7uG7BbVob3b/Zl7PsRdHuTYk2XVD8K5WiQ2Jn6AXNXt2T" +
        "66GYii8="

    /** PKCS#8 private key of [leafLoopback], used by the local TLS test server only. */
    private const val LEAF_LOOPBACK_KEY_BASE64 =
        "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC/4gTXTvRjp3t56ztRdMGPBf/gs/YyfXP8BQ50N9lBf/I4" +
        "593IIIv4ewuJ8sIUYpk+TyliSkYeVpLVu5OcU47bREb/gdBrQ8N7cWxBzwAuM8JoFtXFFrXSMFhxhbZ04OfvInds75zH4NZp" +
        "rQbuCGsyF5gmA4vbsdOVAIrhXxzeT8XfGGAESBQ/ZS5sl4BrhQmoLbfmN3GkildIOHOoVrgWcfTbHQr2DPKHl2/fC3Z4tRMW" +
        "1WBhIj01o6FaReVK40GVkdEzUgdGX2ACeZsmhZxC0JgcB1Q56q7x64oBfjvE3hrt45p7z7/zBIOI207iwkrfK4m8Uea5RU9a" +
        "rSenLtsdAgMBAAECggEABuHF160Kwdo7aPuBVKIR4R3PeBEsRtJOCx9pTczE+37pwpW6VBeqvX44QznUMSP6KAxxyQct7Z+g" +
        "Q48nM6ehi4au3zIaNganp7FBNzkD4iRUGCSdhSST39aBDY1Epnt8hgyf6OXNIzQSrJaalYXyxkinWdGtvfLqSkFLOdsN74Ew" +
        "Ca+hWNLbEFk9VhP6CeVgNz88buNL7D3bypGNl8CkQBrTt3XKyVAhsqE1EqX5TKBIgGcdMJfziSpcXpgIruOuLOt3DFtfHozU" +
        "Flq/eZCTWSyCbBeaBUY93MoC1bPmkrjfJWsz84nZ3JwUnf0Sv0aEFkkZ3+wZW8gw7UN/MqNn4QKBgQDXwz5GulA/utwczill" +
        "5fHydguuThqk8qhWEhWOHE0/uZLYBLJCNYnwoY3vcuwSNpRieZw3DGKNF8p4KWXXEZYgdxHsvJuzG7y6KU0fIPMheLnAGOML" +
        "2AP6Y4HemPNB0QQhO0y8KOQ6J33Qr78ZeSBk28bGt69VYzldceRJ15KTzQKBgQDjqro89oTGm+st5tK5+/jpflKlww28Wo70" +
        "egGNPWBT9YEx05WdVrYyAnlHXh9J1gXGRIBFhFQRXPmBFrExW0wIfm/G29i/dFIXeqe89E3RyKJnxC/6hew+tYa8YCGEv7Aq" +
        "ySaX4qb5B30y0DaKN8ar7gayrbmuX9fqkAdi/zG0kQKBgQCYJZ/WtC8+oX/x+BcNOfdBKKjYA0+anVrDRwFYMvDuTOgV2Enz" +
        "kllxDBtQjNOXjFFal7Lmxp8AK5Sk41xjKo2Y2x4SuHV6+cY96D3wA4YvRjiGE4aXpX44pM7Br01qTgABhxV3YcZ+k7aO4D97" +
        "sQR82tXy7zh+l/etw1BeGdvMyQKBgAvk/5Xvy0AVJVRgmuHcqESKtQa0CiOtF4ruVOZsLnw0d2uDAm4V+a7jMjLoV/ojlGmn" +
        "aow3Pa0qjl6QMPHDM1W+RVi+Y7Sc/yz624ijuu0a7mE9fsQ3+v/LvB5bZ2ToHuwdVkbZMKASJBhjiHXwNBEHfpIXQXw6xa0b" +
        "mUcyzgYBAoGBAMIty+Kc9lsD6cyQUhkRxNLmn1skxjj0d1QA22gcso97E3IqnLkiASn/nk5CkykNzNEZuEm5b7bsLY4ieqOQ" +
        "A7OczWz/1TSpEB9JKX0oMh90paYQ7kPwmN3RiwhA7OtBfujjH1QBJqRIdzU9sTRgR8NoEyGz1IqRu18v1+zLlhST"

    /**
     * Self-signed CA for a public IPv6 LAN entry, plus a leaf it issued.
     *
     * The operational fixtures keep their CA private key out of the repository, so this pair
     * is generated the way the plugin generates LAN material (EC P-256, SAN type 7 IP) and
     * only needs to agree with itself.
     */
    private const val IPV6_CA_BASE64 =
        "MIIBXzCCAQSgAwIBAgIJCwrq6K/bhNFfMAoGCCqGSM49BAMCMCIxIDAeBgNVBAMTF0RTSCBNb2JpbGUgSVB2NiB0ZXN0IENBMB4XDTI2MTExNzE4MTUyN1oXDTM2MTExNzE4MTYyN1owIjEgMB4GA1UEAxMXRFNIIE1vYmlsZSBJUHY2IHRlc3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARDI5VSpWAJDUtZEl1UJKgHog0d3mXI9Rv3Lr+VtGRxw89+8d5ELX7ofzvxv8+ST60wHdWXVAQ48s8F/XM+rZ45oyMwITAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAKBggqhkjOPQQDAgNJADBGAiEA9vMmWNTwZPCQnYW8TZjgu/8+AYr3qMTMhjE0AFJ2kH8CIQCXenaW5IEW1p+2MwsMfOsQbO7zMWQrUQDs8nLfFdyBOA=="

    /** Leaf issued by [IPV6_CA_BASE64] with SAN `IP:240c:ca04:2401:283f:c15:dfff:fe88:549`. */
    private const val LEAF_IPV6_BASE64 =
        "MIIBgzCCASigAwIBAgIJT3kCJ4RG6RLKMAoGCCqGSM49BAMCMCIxIDAeBgNVBAMTF0RTSCBNb2JpbGUgSVB2NiB0ZXN0IENBMB4XDTI2MTExNzE4MTUyN1oXDTM2MTExNzE4MTYyN1owFzEVMBMGA1UEAxMMZHNoIGlwdjYgbGFuMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEebLTbZaDaB/Fmusf9r+zMwUasAxA7iBZ8DADyqUoMSc4+zlXmt7DB/bmA80hkqbeVEDrxybru8ol/yAVd8oPMqNSMFAwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwEwGwYDVR0RBBQwEocQJAzKBCQBKD8MFd///ogFSTAKBggqhkjOPQQDAgNJADBGAiEAozJbuqq1OsWPPoMA6eAZ6NBQk6ne3/K1hjWe8wTZsggCIQCsp8t37O+XYNBq5f9JFhgNIP+jg+bi3EUHlnsoQjHl0A=="

    /** Ingress CA of the self-signed passthrough entry under test. */
    val ingressCa: ByteArray by lazy { decode(INGRESS_CA_BASE64) }

    /** CA of a substituted gateway; never promised by a pairing key. */
    val foreignCa: ByteArray by lazy { decode(FOREIGN_CA_BASE64) }

    /** Entry leaf whose SAN is the public ingress address `65.49.214.186`. */
    val leafPublicIp: ByteArray by lazy { decode(LEAF_PUBLIC_IP_BASE64) }

    /** Entry leaf issued by [ingressCa] with an unrelated SAN address. */
    val leafOtherIp: ByteArray by lazy { decode(LEAF_OTHER_IP_BASE64) }

    /** Entry leaf issued by [ingressCa] for a DNS-named remote entry. */
    val leafDnsName: ByteArray by lazy { decode(LEAF_DNS_NAME_BASE64) }

    /** Entry leaf with the public ingress SAN issued by [foreignCa]. */
    val leafForeignIssuer: ByteArray by lazy { decode(LEAF_FOREIGN_ISSUER_BASE64) }

    /** Entry leaf the local TLS test server presents, issued by [ingressCa]. */
    val leafLoopback: ByteArray by lazy { decode(LEAF_LOOPBACK_BASE64) }

    /** PKCS#8 private key of [leafLoopback]; test material for the local TLS test server. */
    val leafLoopbackKey: ByteArray by lazy { decode(LEAF_LOOPBACK_KEY_BASE64) }

    /** Self-signed CA that issued [leafIpv6]. */
    val ipv6Ca: ByteArray by lazy { decode(IPV6_CA_BASE64) }

    /** Entry leaf whose SAN is the public IPv6 LAN address `240c:ca04:2401:283f:c15:dfff:fe88:549`. */
    val leafIpv6: ByteArray by lazy { decode(LEAF_IPV6_BASE64) }

    /** The SHA-256 fingerprint a pairing key must carry for [der]. */
    fun instanceIdOf(der: ByteArray): String = PairingTrust.fingerprint(certificate(der))

    /** Parses one DER payload the way the app parses a fetched certificate. */
    fun certificate(der: ByteArray): X509Certificate =
        CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate

    private fun decode(base64: String): ByteArray = Base64.getDecoder().decode(base64)
}
