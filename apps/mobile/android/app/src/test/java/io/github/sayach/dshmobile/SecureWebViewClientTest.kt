package io.github.sayach.dshmobile

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SecureWebViewClientTest {
    @Test
    fun sslCallbackUsesTheCompleteTestedDecisionBeforeProceeding() {
        val source = clientSource().substringAfter("override fun onReceivedSslError(").substringBefore("override fun onReceivedError(")
        assertTrue(source.contains("acceptsPinnedWebViewSslError(origin, caCertificate, error.primaryError,"))
        assertTrue(source.contains("error.url, error.certificate.x509Certificate"))
        assertTrue(source.indexOf("acceptsPinnedWebViewSslError(") < source.indexOf("handler.proceed()"))
        assertTrue(source.contains("handler.cancel()"))
        assertTrue(source.contains("onFailure(LoadFailure.TLS)"))
    }

    @Test
    fun cpolarPagesReceiveEnoughTimeForTheProxiedClientBundle() {
        assertEquals(120_000L, webViewLoadTimeoutMs("private-name.r8.cpolar.cn"))
        assertEquals(120_000L, webViewLoadTimeoutMs("PRIVATE-NAME.CPOLAR.IO"))
    }

    @Test
    fun otherRemotePagesKeepTheShorterRemoteBudget() {
        assertEquals(30_000L, webViewLoadTimeoutMs("computer.tail1234.ts.net"))
        assertEquals(30_000L, webViewLoadTimeoutMs("dsh.example.com"))
        assertEquals(15_000L, webViewLoadTimeoutMs("192.168.1.20"))
    }

    @Test
    fun irohPagesReceiveTheRemoteBudgetWithoutBecomingRemoteCandidates() {
        assertEquals(30_000L, webViewLoadTimeoutMs("0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef.iroh.localhost"))
    }

    @Test
    fun subframesCannotNavigateAcrossOrigins() {
        val origin = GatewayOrigin.parse("https://trusted.example:3443")!!
        assertFalse(shouldBlockSubframeNavigation(origin, "https://trusted.example:3443/embed"))
        assertTrue(shouldBlockSubframeNavigation(origin, "https://other.example/embed"))
        assertTrue(shouldBlockSubframeNavigation(origin, "https://trusted.example/embed"))
    }

    @Test
    fun visibleContentStartsAnOwnedProbeWithoutWaitingForAllResources() {
        val source = clientSource()
        val visible = source.substringAfter("override fun onPageCommitVisible(").substringBefore("\n    override fun ")
        assertTrue(visible.contains("document.canInspectContent(url, view.url ?: url)"))
        assertTrue(visible.contains("onContentVisible(document.generation)"))
        assertFalse("A commit only permits DOM inspection, not unconditional connection completion", visible.contains("confirmContentReady"))
        assertFalse(visible.contains("clearTimeout()"))
        val confirm = source.substringAfter("fun confirmContentReady(").substringBefore("\n    fun dispose(")
        assertTrue(confirm.indexOf("document.confirmContentReady(expectedGeneration)") >= 0)
        assertTrue(confirm.indexOf("document.confirmContentReady(expectedGeneration)") < confirm.indexOf("clearTimeout()"))
        val timeout = source.substringAfter("private fun armTimeout(").substringBefore("\n    private fun ")
        assertTrue(timeout.contains("val expectedGeneration = document.generation"))
        assertTrue(timeout.contains("!document.shouldTimeout(expectedGeneration, connectionDeadlineActive())"))
        assertTrue(timeout.indexOf("document.shouldTimeout(") < timeout.indexOf("document.failed()"))
        assertTrue(timeout.indexOf("document.shouldTimeout(") < timeout.indexOf("view.stopLoading()"))
    }

    // `onReceivedSslError` proceeds only when a CA is pinned, the error is SSL_UNTRUSTED, the
    // failing URL keeps the exact origin, and `PinnedTls.acceptsWebViewLeaf` accepts the leaf.
    // The last two legs are locked here for the self-signed passthrough entry; the decision itself
    // is `handler.proceed()` on true and `handler.cancel()` plus a TLS load failure on false.

    @Test
    fun pinnedIngressCaProceedsForTheSelfSignedLeafOfTheRemoteEntry() {
        val origin = GatewayOrigin.parse("https://65.49.214.186:33080")!!

        assertTrue(PinnedTls.acceptsWebViewLeaf(origin, TestCertificates.ingressCa, leaf(TestCertificates.leafPublicIp)))
    }

    @Test
    fun pinnedIngressCaProceedsForADnsNamedSelfSignedEntry() {
        val origin = GatewayOrigin.parse("https://entry.example.com:33080")!!

        assertTrue(PinnedTls.acceptsWebViewLeaf(origin, TestCertificates.ingressCa, leaf(TestCertificates.leafDnsName)))
    }

    @Test
    fun pinnedIngressCaCancelsALeafWhoseSanDoesNotMatchTheOrigin() {
        val origin = GatewayOrigin.parse("https://65.49.214.186:33080")!!

        assertFalse(PinnedTls.acceptsWebViewLeaf(origin, TestCertificates.ingressCa, leaf(TestCertificates.leafOtherIp)))
        assertFalse(PinnedTls.acceptsWebViewLeaf(origin, TestCertificates.ingressCa, leaf(TestCertificates.leafDnsName)))
    }

    @Test
    fun pinnedIngressCaCancelsALeafIssuedByAnotherCa() {
        val origin = GatewayOrigin.parse("https://65.49.214.186:33080")!!

        assertFalse(PinnedTls.acceptsWebViewLeaf(origin, TestCertificates.ingressCa, leaf(TestCertificates.leafForeignIssuer)))
        assertFalse(PinnedTls.acceptsWebViewLeaf(origin, TestCertificates.foreignCa, leaf(TestCertificates.leafPublicIp)))
    }

    @Test
    fun pinnedIngressCaCancelsALeafPresentedForAnotherHostOrWithNoLeafAtAll() {
        val origin = GatewayOrigin.parse("https://65.49.214.186:33080")!!

        assertFalse(PinnedTls.acceptsWebViewLeaf(origin, TestCertificates.ingressCa, null))
        assertFalse(
            PinnedTls.acceptsWebViewLeaf(
                GatewayOrigin.parse("https://65.49.214.187:33080")!!,
                TestCertificates.ingressCa,
                leaf(TestCertificates.leafPublicIp),
            ),
        )
    }

    @Test
    fun theSslErrorUrlLegKeepsTheExactPinnedOrigin() {
        val origin = GatewayOrigin.parse("https://65.49.214.186:33080")!!

        assertTrue(GatewayUrlPolicy.isSameOrigin(origin, "https://65.49.214.186:33080/"))
        assertTrue(GatewayUrlPolicy.isSameOrigin(origin, "https://65.49.214.186:33080/mobile-access/pair"))
        assertFalse(GatewayUrlPolicy.isSameOrigin(origin, "https://65.49.214.186/"))
        assertFalse(GatewayUrlPolicy.isSameOrigin(origin, "https://65.49.214.186:443/"))
    }

    private fun leaf(der: ByteArray): java.security.cert.X509Certificate = TestCertificates.certificate(der)

    private fun clientSource(): String = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .flatMap { base -> listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main").asSequence()
            .map { File(base, "$it/java/io/github/sayach/dshmobile/SecureWebViewClient.kt") } }
        .first { it.isFile }.readText()
}
