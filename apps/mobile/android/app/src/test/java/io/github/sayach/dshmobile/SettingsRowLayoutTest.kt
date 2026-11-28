package io.github.sayach.dshmobile

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A settings row must stay readable in every shipped language.
 *
 * Found on a real device (Android 16, 1080x2412): the Japanese settings page rendered
 * "同じコンピューターへの自動接続" as "同じコンピューターへの自動" — clipped at the card edge with no
 * ellipsis at all — and the value column was squeezed until "クジラ娘 A" became "クジラ…". The title
 * TextView had maxLines=1 with neither an ellipsize nor a weight, while the value column took
 * weight=1 and absorbed whatever the title did not use.
 *
 * Japanese is not the worst case by character count: the German and Italian titles for the same
 * row are wider, so this is a property of the layout, not of one translation.
 */
class SettingsRowLayoutTest {
    @Test
    fun aLongTitleWrapsAndEllipsisesInsteadOfBeingClipped() {
        val row = settingsRow()
        assertTrue(
            "a translated title needs more than one line beside a value",
            row.contains("maxLines = 2"),
        )
        assertTrue(
            "without an ellipsis the title is cut mid-word at the card edge",
            row.contains("ellipsize = TextUtils.TruncateAt.END"),
        )
        assertTrue(
            "the title has to claim the leftover width or the value column crowds it out",
            row.contains("LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)"),
        )
    }

    @Test
    fun theValueKeepsItsNaturalWidth() {
        val row = settingsRow()
        // The value used to take weight=1, which left it either squeezed or squeezing the title.
        assertTrue(
            "the value column must be measured before the title takes the remainder",
            !row.contains(
                "LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {\n" +
                    "                    marginStart = dp(UiTokens.gapSm)\n                }",
            ),
        )
    }

    private fun settingsRow(): String {
        for (root in listOf("app/src/main", "src/main", ".")) {
            val file = File(root, "java/io/github/sayach/dshmobile/MainActivity.kt")
            if (!file.exists()) continue
            val source = file.readText()
            val start = source.indexOf("private fun settingsRow(")
            assertTrue("settingsRow not found", start > 0)
            val end = source.indexOf("private fun ", start + 10)
            return if (end > start) source.substring(start, end) else source.substring(start)
        }
        throw AssertionError("cannot locate MainActivity.kt")
    }
}