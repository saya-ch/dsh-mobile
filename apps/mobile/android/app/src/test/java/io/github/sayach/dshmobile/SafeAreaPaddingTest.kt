package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Test

/** Verifies safe-area union and repeat-dispatch behavior without an Android device. */
class SafeAreaPaddingTest {
    @Test
    fun reservesThreeButtonNavigationWithoutAddingItAgainToTheKeyboard() {
        val system = SafeAreaEdges(left = 0, top = 72, right = 0, bottom = 144)
        val keyboard = SafeAreaEdges(left = 0, top = 0, right = 0, bottom = 840)
        assertEquals(144, system.union(SafeAreaEdges(0, 0, 0, 0)).bottom)
        assertEquals(840, system.union(keyboard).bottom)
    }

    @Test
    fun reservesOnlyTheImeAreaBeyondTheWebSafeArea() {
        assertEquals(0, additionalImeInset(coveredBottom = 48, webSafeBottom = 48))
        assertEquals(0, additionalImeInset(coveredBottom = 0, webSafeBottom = 48))
        assertEquals(792, additionalImeInset(coveredBottom = 840, webSafeBottom = 48))
    }

    @Test
    fun landscapeNavigationAndCutoutReserveTheOccupiedSide() {
        val navigation = SafeAreaEdges(left = 0, top = 0, right = 144, bottom = 0)
        val cutout = SafeAreaEdges(left = 96, top = 0, right = 0, bottom = 0)
        assertEquals(SafeAreaEdges(left = 96, top = 0, right = 144, bottom = 0), navigation.union(cutout))
    }

    @Test
    fun nativeCardsFitPortraitLandscapeAndSmallResizedWindows() {
        assertEquals(312, setupCardWidth(360, horizontalGutter = 24, maximumWidth = 560))
        assertEquals(560, setupCardWidth(804, horizontalGutter = 24, maximumWidth = 560))
        assertEquals(232, setupCardWidth(280, horizontalGutter = 24, maximumWidth = 560))
        assertEquals(0, setupCardWidth(32, horizontalGutter = 24, maximumWidth = 560))
    }

    @Test
    fun unionsSystemBarsCutoutAndImePerEdge() {
        val systemBars = SafeAreaEdges(left = 0, top = 72, right = 24, bottom = 48)
        val displayCutout = SafeAreaEdges(left = 36, top = 96, right = 0, bottom = 0)
        val ime = SafeAreaEdges(left = 0, top = 0, right = 0, bottom = 840)

        assertEquals(
            SafeAreaEdges(left = 36, top = 96, right = 24, bottom = 840),
            systemBars.union(displayCutout).union(ime),
        )
    }

    @Test
    fun insetRedispatchAlwaysStartsFromOriginalPadding() {
        val original = ContentPadding(left = 8, top = 16, right = 24, bottom = 32)

        assertEquals(
            ContentPadding(left = 8, top = 88, right = 24, bottom = 80),
            original.withSafeArea(SafeAreaEdges(left = 0, top = 72, right = 0, bottom = 48)),
        )
        assertEquals(
            ContentPadding(left = 44, top = 16, right = 48, bottom = 872),
            original.withSafeArea(SafeAreaEdges(left = 36, top = 0, right = 24, bottom = 840)),
        )
        assertEquals(
            original,
            original.withSafeArea(SafeAreaEdges(left = 0, top = 0, right = 0, bottom = 0)),
        )
    }
}
