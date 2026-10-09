package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WebViewEngineTest {
    @Test fun chromiumTokenControlsReminderInsteadOfVendorPackageMajor() {
        val old = inspectWebViewEngine("Mozilla/5.0 Chrome/93.0.4577.82 Mobile DSHMobile/0.6.2", "com.vendor.webview", "999.2.1")
        assertEquals(93, old.chromiumMajor)
        assertTrue(old.needsUpdateReminder)
        val modern = inspectWebViewEngine("Mozilla/5.0 Chrome/100.0.4896.127 Mobile", "com.vendor.webview", "6.0.0")
        assertFalse(modern.needsUpdateReminder)
    }

    @Test fun unknownEngineDoesNotClaimIncompatibility() {
        assertFalse(inspectWebViewEngine("Mozilla/5.0 Version/4.0 DSHMobile/0.6.2", "com.vendor.webview", "74.1").needsUpdateReminder)
        assertNull(inspectWebViewEngine("Mozilla/5.0 Chrome/not-a-version", null, null).chromiumMajor)
    }

    @Test fun onlyTheSameActualEngineBuildSharesAcknowledgement() {
        val first = inspectWebViewEngine("Mozilla/5.0 Chrome/99.0.1.2 DSHMobile/0.6.2", "provider", "4.1")
        val appUpgrade = inspectWebViewEngine("Mozilla/5.0 Chrome/99.0.1.2 DSHMobile/0.6.3", "provider", "4.1")
        val engineUpgrade = inspectWebViewEngine("Mozilla/5.0 Chrome/99.0.1.3 DSHMobile/0.6.3", "provider", "4.1")
        assertEquals(first.reminderKey, appUpgrade.reminderKey)
        assertNotEquals(first.reminderKey, engineUpgrade.reminderKey)
    }
}
