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

    @Test fun aFloatingWindowShrinksTheFullScreenLayoutInsteadOfRefittingIt() {
        // 1080 px wide at density 3 is the 360 CSS px layout a phone normally uses. The floating
        // window is a fifth of that width, so the page is drawn at 30% rather than reflowed to
        // 108 CSS px, which is what made a fixed-size widget fill the window.
        assertEquals(360 to 0.3, NativeDisplayScalePolicy.pictureInPictureViewport(1080, 324, 3f, 100))
        // Resizing the window rescales, it does not reflow.
        assertEquals(360 to 0.5, NativeDisplayScalePolicy.pictureInPictureViewport(1080, 540, 3f, 100))
    }

    @Test fun anExtremelyNarrowWindowFallsBackToAFittingLayout() {
        // Below the smallest scale Chromium honours the full layout would be clipped, so the width
        // narrows to what still fits at that scale instead.
        val (width, scale) = NativeDisplayScalePolicy.pictureInPictureViewport(1080, 200, 3f, 100)
        assertEquals(267, width)
        assertEquals(0.25, scale, 0.0001)
        val scaled = NativeDisplayScalePolicy.pictureInPictureViewport(1080, 324, 3f, 80)
        assertEquals(432, scaled.first)
        assertEquals(0.25, scaled.second, 0.0001)
    }

    @Test fun tabletWidthsKeepTheirOwnLayoutInTheWindow() {
        val (width, scale) = NativeDisplayScalePolicy.pictureInPictureViewport(2050, 800, 3f, 100)
        assertEquals(683, width)
        assertEquals(0.3904, scale, 0.0001)
        assertEquals(width, NativeDisplayScalePolicy.viewportWidth(2050, 3f, 100))
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
