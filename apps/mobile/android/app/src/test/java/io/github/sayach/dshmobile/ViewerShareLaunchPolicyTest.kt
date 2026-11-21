package io.github.sayach.dshmobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ViewerShareLaunchPolicyTest {
    @Test fun onlyTheCurrentTrustedDocumentMayLaunchTheChooser() {
        assertTrue(NativeBridgePolicy.canLaunchViewerShare(available = true, preservingForConfiguration = false, beganDocumentGeneration = 3, currentDocumentGeneration = 3))
        assertFalse(NativeBridgePolicy.canLaunchViewerShare(available = false, preservingForConfiguration = false, beganDocumentGeneration = 3, currentDocumentGeneration = 3))
        assertFalse(NativeBridgePolicy.canLaunchViewerShare(available = true, preservingForConfiguration = true, beganDocumentGeneration = 3, currentDocumentGeneration = 3))
        assertFalse(NativeBridgePolicy.canLaunchViewerShare(available = true, preservingForConfiguration = false, beganDocumentGeneration = 2, currentDocumentGeneration = 3))
        assertFalse(NativeBridgePolicy.canLaunchViewerShare(available = true, preservingForConfiguration = false, beganDocumentGeneration = -1, currentDocumentGeneration = 3))
    }
}
