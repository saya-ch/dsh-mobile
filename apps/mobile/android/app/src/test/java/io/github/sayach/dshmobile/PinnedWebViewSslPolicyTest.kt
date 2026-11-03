package io.github.sayach.dshmobile

import android.net.http.SslError
import java.util.Base64
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Exercise the same complete decision used by the actual SSL callback. */
class PinnedWebViewSslPolicyTest {
    private val origin = requireNotNull(GatewayOrigin.parse("https://gateway.example.test:3443"))
    private val ca = Base64.getDecoder().decode(CA)
    private val leaf = TestCertificates.certificate(Base64.getDecoder().decode(VALID))

    @Test
    fun acceptsPinnedHttpsAndWssWithoutRelaxingNavigation() {
        for (scheme in listOf("https", "wss")) {
            assertTrue(acceptsPinnedWebViewSslError(origin, ca, SslError.SSL_UNTRUSTED,
                "$scheme://gateway.example.test:3443/api/remote.mux", leaf))
        }
        assertFalse(GatewayUrlPolicy.isSameOrigin(origin, "wss://gateway.example.test:3443/"))
        assertFalse(GatewayUrlPolicy.isAllowedDownload(origin, "wss://gateway.example.test:3443/file"))
    }

    @Test
    fun matchingWssAuthorityCannotReplaceThePinnedCertificateChecks() {
        val url = "wss://gateway.example.test:3443/api/remote.mux"
        assertFalse(acceptsPinnedWebViewSslError(origin, null, SslError.SSL_UNTRUSTED, url, leaf))
        assertFalse(acceptsPinnedWebViewSslError(origin, byteArrayOf(1), SslError.SSL_UNTRUSTED, url, leaf))
        assertFalse(acceptsPinnedWebViewSslError(origin, TestCertificates.foreignCa, SslError.SSL_UNTRUSTED, url, leaf))
        assertFalse(acceptsPinnedWebViewSslError(origin, TestCertificates.expiredCa, SslError.SSL_UNTRUSTED, url, leaf))
        assertFalse(acceptsPinnedWebViewSslError(origin, ca, SslError.SSL_UNTRUSTED, url, null))
        assertFalse(acceptsPinnedWebViewSslError(origin, ca, SslError.SSL_UNTRUSTED, url,
            TestCertificates.certificate(TestCertificates.leafForeignIssuer)))
        val mismatched = requireNotNull(GatewayOrigin.parse("https://other.example.test:3443"))
        assertFalse(acceptsPinnedWebViewSslError(mismatched, ca, SslError.SSL_UNTRUSTED,
            "wss://other.example.test:3443/api/remote.mux", leaf))
    }

    @Test
    fun rejectsAnExpiredOtherwiseAuthenticLeaf() {
        val expired = TestCertificates.certificate(Base64.getDecoder().decode(EXPIRED))
        expired.verify(TestCertificates.certificate(ca).publicKey)
        assertTrue(expired.subjectX500Principal == leaf.subjectX500Principal)
        assertFalse(acceptsPinnedWebViewSslError(origin, ca, SslError.SSL_UNTRUSTED,
            "wss://gateway.example.test:3443/api/remote.mux", expired))
    }

    @Test
    fun rejectsOtherSslFailuresEvenWithTheRightPin() {
        for (error in listOf(SslError.SSL_EXPIRED, SslError.SSL_NOTYETVALID, SslError.SSL_IDMISMATCH,
            SslError.SSL_DATE_INVALID, SslError.SSL_INVALID, -1)) {
            assertFalse(acceptsPinnedWebViewSslError(origin, ca, error,
                "wss://gateway.example.test:3443/api/remote.mux", leaf))
        }
    }

    @Test
    fun rejectsForeignOrInsecureAuthoritiesWithAValidCertificate() {
        for (url in listOf("ws://gateway.example.test:3443/api/remote.mux", "http://gateway.example.test:3443/",
            "wss://other.example.test:3443/", "wss://gateway.example.test:443/",
            "wss://user:secret@gateway.example.test:3443/")) {
            assertFalse(acceptsPinnedWebViewSslError(origin, ca, SslError.SSL_UNTRUSTED, url, leaf))
        }
    }

    // Public EC fixtures only: CA valid 2020–2046, good leaf 2020–2040, expired
    // leaf 2020–2021. Both leaves have the same subject, key, SAN and issuer.
    private companion object {
        const val CA = "MIIBSzCB8aADAgECAgFvMAoGCCqGSM49BAMCMCMxITAfBgNVBAMMGE93bmVkIFRMUyBwb2xpY3kgdGVzdCBDQTAeFw0yMDAxMDEwMDAwMDBaFw00NjAxMDEwMDAwMDBaMCMxITAfBgNVBAMMGE93bmVkIFRMUyBwb2xpY3kgdGVzdCBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABFCdu+67qK2SVPyx5FIz4aKePPwDIza+jTU7w4RZuwAtwfNA4m5kchbol9Rhf4mIDOvk0rMTYd6FuFjjOdjPcOGjFjAUMBIGA1UdEwEB/wQIMAYBAf8CAQAwCgYIKoZIzj0EAwIDSQAwRgIhAM3+8rS/dNoDhRVaDeaNmfmonYd3XIsmf4VXqRlXiF0HAiEAt1RwwQplcyNBjWaNd0gyhWP4beB+d+fjGv5gotNWNOQ="
        const val VALID = "MIIBeDCCAR2gAwIBAgIBcDAKBggqhkjOPQQDAjAjMSEwHwYDVQQDDBhPd25lZCBUTFMgcG9saWN5IHRlc3QgQ0EwHhcNMjAwMTAxMDAwMDAwWhcNNDAwMTAxMDAwMDAwWjAfMR0wGwYDVQQDDBRnYXRld2F5LmV4YW1wbGUudGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABK7HJlM0oWUosmyR5iYVuWq4UYuUipkstXfJuyUsispusgt/E3zSDXBBh10cajTdX0AAaLq5D0FhIhVG+ryn6LmjRjBEMAwGA1UdEwEB/wQCMAAwHwYDVR0RBBgwFoIUZ2F0ZXdheS5leGFtcGxlLnRlc3QwEwYDVR0lBAwwCgYIKwYBBQUHAwEwCgYIKoZIzj0EAwIDSQAwRgIhAJeuA+fWE2AA4yy1VXHw6/H95Lp14WDZmNs/d57x9SViAiEAlTjlv6e8AsIi7z5qEreihfT973C7cH8kGyOK8u5PH+0="
        const val EXPIRED = "MIIBdjCCAR2gAwIBAgIBcTAKBggqhkjOPQQDAjAjMSEwHwYDVQQDDBhPd25lZCBUTFMgcG9saWN5IHRlc3QgQ0EwHhcNMjAwMTAxMDAwMDAwWhcNMjEwMTAxMDAwMDAwWjAfMR0wGwYDVQQDDBRnYXRld2F5LmV4YW1wbGUudGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABK7HJlM0oWUosmyR5iYVuWq4UYuUipkstXfJuyUsispusgt/E3zSDXBBh10cajTdX0AAaLq5D0FhIhVG+ryn6LmjRjBEMAwGA1UdEwEB/wQCMAAwHwYDVR0RBBgwFoIUZ2F0ZXdheS5leGFtcGxlLnRlc3QwEwYDVR0lBAwwCgYIKwYBBQUHAwEwCgYIKoZIzj0EAwIDRwAwRAIgWm7+Ving36pJAQ9N4fNn3nQ2Kky3gDVfRTgmpiJBlJMCIFyIivHOZ5UxtyxZe1o4dxjBMs9uaHxT4OBJwizx6Yi8"
    }
}
