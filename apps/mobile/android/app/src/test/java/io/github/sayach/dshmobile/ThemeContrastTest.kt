package io.github.sayach.dshmobile

import java.io.File
import kotlin.math.pow
import kotlin.math.roundToInt
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/** Measures the colour pairs the native screens actually paint text on. */
class ThemeContrastTest {
    @Test fun primaryButtonLabelsMeetNormalTextContrastInBothThemes() {
        for (theme in THEMES) {
            val colors = themeColors(theme)
            // The button is a three-stop gradient, so the caption has to clear the
            // lightest and the darkest stop, not only the middle one.
            for (stop in listOf("app_button_top", "app_button_mid", "app_button_bottom")) {
                val contrast = contrastRatio(parse(colors.getValue("app_button_text")), parse(colors.getValue(stop)))
                assertTrue("$theme $stop label contrast $contrast must be at least 4.5:1", contrast >= 4.5)
            }
        }
    }

    @Test fun captionsStayReadableOverTheAuroraWash() {
        for (theme in THEMES) {
            val colors = themeColors(theme)
            val base = parse(colors.getValue("app_background"))
            // Each wash stop is composited over the page background at its own alpha;
            // the caption colour must stay readable on the strongest one.
            for (stop in listOf("app_aurora_one", "app_aurora_two", "app_aurora_three")) {
                val washed = composite(parse(colors.getValue(stop)), base)
                for (caption in listOf("app_secondary", "app_foreground")) {
                    val contrast = contrastRatio(parse(colors.getValue(caption)), washed)
                    assertTrue(
                        "$theme $caption on $stop contrast $contrast must be at least 4.5:1",
                        contrast >= 4.5,
                    )
                }
            }
        }
    }

    /** The inline validation label sits on the page background, under its field. */
    @Test fun inlineErrorsStayReadableOnThePageBackground() {
        for (theme in THEMES) {
            val colors = themeColors(theme)
            val contrast = contrastRatio(parse(colors.getValue("app_error")), parse(colors.getValue("app_background")))
            assertTrue("$theme error label contrast $contrast must be at least 4.5:1", contrast >= 4.5)
        }
    }

    private fun themeColors(theme: String): Map<String, String> {
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(sourceFile("res/$theme/colors.xml"))
        val nodes = document.getElementsByTagName("color")
        return (0 until nodes.length).map { nodes.item(it) as Element }
            .associate { it.getAttribute("name") to it.textContent.trim() }
    }

    /** Parses #RRGGBB and #AARRGGBB into a packed ARGB integer. */
    private fun parse(value: String): Int {
        val hex = value.removePrefix("#")
        return if (hex.length == 8) hex.toLong(16).toInt() else (0xFF000000L or hex.toLong(16)).toInt()
    }

    /** Source-over composite of a possibly translucent colour onto an opaque one. */
    private fun composite(overlay: Int, base: Int): Int {
        val alpha = (overlay ushr 24 and 255) / 255.0
        fun channel(shift: Int): Int {
            val top = (overlay ushr shift and 255) * alpha
            val bottom = (base ushr shift and 255) * (1 - alpha)
            return (top + bottom).roundToInt().coerceIn(0, 255)
        }
        return (255 shl 24) or (channel(16) shl 16) or (channel(8) shl 8) or channel(0)
    }

    private fun contrastRatio(first: Int, second: Int): Double {
        val a = luminance(first)
        val b = luminance(second)
        return (maxOf(a, b) + 0.05) / (minOf(a, b) + 0.05)
    }

    private fun luminance(color: Int): Double {
        fun channel(shift: Int): Double {
            val value = ((color shr shift) and 255).toDouble() / 255
            return if (value <= 0.04045) value / 12.92 else ((value + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    }

    private fun sourceFile(path: String): File = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .flatMap { base -> listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main").asSequence()
            .map { File(base, "$it/$path") } }
        .first { it.isFile }

    private companion object {
        val THEMES = listOf("values", "values-night")
    }
}
