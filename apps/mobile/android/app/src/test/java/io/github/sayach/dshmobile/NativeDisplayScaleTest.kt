package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeDisplayScaleTest {
    @Test fun smallerScaleOffersMoreLayoutWidthWithoutChangingPhysicalInsets() {
        assertEquals(450, NativeDisplayScalePolicy.viewportWidth(1080, 3f, 80))
        assertEquals(360, NativeDisplayScalePolicy.viewportWidth(1080, 3f, 100))
        assertEquals(288, NativeDisplayScalePolicy.viewportWidth(1080, 3f, 125))
        assertEquals(854, NativeDisplayScalePolicy.viewportWidth(2050, 3f, 80))
    }

    @Test fun invalidStoredValuesReturnToDefaultAndWireValuesAreStrict() {
        assertEquals(100, NativeDisplayScalePolicy.storedPercent(0))
        assertEquals(100, NativeDisplayScalePolicy.storedPercent(500))
        assertEquals(80, NativeDisplayScalePolicy.storedPercent(80))
        assertTrue(NativeDisplayScalePolicy.isValid(125.0))
        assertFalse(NativeDisplayScalePolicy.isValid(79.0))
        assertFalse(NativeDisplayScalePolicy.isValid(126.0))
        assertFalse(NativeDisplayScalePolicy.isValid(100.5))
        assertFalse(NativeDisplayScalePolicy.isValid(Double.NaN))
        assertFalse(NativeDisplayScalePolicy.isValid(Double.POSITIVE_INFINITY))
    }
}
