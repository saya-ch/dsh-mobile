package io.github.sayach.dshmobile

/** Engine identity uses Chromium's user-agent version, never a vendor package major. */
internal data class WebViewEngine(
    val chromiumVersion: String?,
    val providerPackage: String?,
    val providerVersion: String?,
) {
    val chromiumMajor: Int? get() = chromiumVersion?.substringBefore('.')?.toIntOrNull()
    val needsUpdateReminder: Boolean get() = chromiumMajor?.let { it < 100 } == true
    val reminderKey: String get() = listOf(providerPackage.orEmpty(), providerVersion.orEmpty(), chromiumVersion.orEmpty()).joinToString("|")
}

/** Read the actual Chrome token; Android releases and DSH App tokens are unrelated. */
internal fun inspectWebViewEngine(userAgent: String, providerPackage: String?, providerVersion: String?): WebViewEngine =
    WebViewEngine(
        chromiumVersion = Regex("(?:^|\\s)(?:Chrome|Chromium)/(\\d+(?:\\.\\d+)*)\\b").find(userAgent)?.groupValues?.get(1),
        providerPackage = providerPackage,
        providerVersion = providerVersion,
    )
