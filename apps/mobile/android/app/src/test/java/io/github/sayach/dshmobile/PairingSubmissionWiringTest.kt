package io.github.sayach.dshmobile

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** Ensures the tested submission owner protects the keyboard path in the actual Activity. */
class PairingSubmissionWiringTest {
    @Test fun theSharedConnectionEntryClaimsItsGateBeforeSendingAnyPairRequest() {
        val source = activitySource()
        val form = source.substringAfter("private fun showPairing(").substringBefore("private fun showCompatibilityIssue(")
        assertTrue(form.contains("primaryButton(R.string.pair_and_connect, 52) { connect(harness, pairing, status, this) }"))
        assertTrue(form.substringAfter("setOnEditorActionListener").contains("connect(harness, pairing, status, connect)"))
        val connect = source.substringAfter("private fun connect(").substringBefore("private fun showCompatibilityIssue(")
        assertTrue(connect.indexOf("if (pairingAttemptGate.busy) return") < connect.indexOf("val input ="))
        assertTrue(connect.indexOf("val generation = beginPairingAttempt() ?: return") < connect.indexOf("ioExecutor.execute"))
        assertTrue(connect.contains("if (generation != pairingGeneration) return@runOnUiThread"))
        assertTrue(connect.contains("pairingAttemptGate.complete(generation)"))
        assertTrue(source.substringAfter("private fun invalidatePairingAttempts()").substringBefore("private fun restoreTrustedDevice(")
            .contains("pairingAttemptGate.invalidate()"))
    }

    @Test fun navigationDuringTrustOrRenewalCannotStartTheNextCredentialOperation() {
        val connect = activitySource().substringAfter("private fun connect(").substringBefore("private fun showCompatibilityIssue(")
        val trusted = connect.substringAfter("val (certificate, expectedInstanceId) = trust").substringBefore("val savedOrigin")
        assertTrue(trusted.contains("if (generation != pairingGeneration) return@execute"))
        val renewalFailed = connect.substringAfter("val renewalFailure =").substringBefore("store.clear()")
        assertTrue(renewalFailed.contains("if (generation != pairingGeneration) return@execute"))
    }

    private fun activitySource(): String = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .flatMap { base -> listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main").asSequence()
            .map { File(base, "$it/java/io/github/sayach/dshmobile/MainActivity.kt") } }
        .first { it.isFile }.readText()
}
