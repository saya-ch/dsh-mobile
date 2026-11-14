package io.github.sayach.dshmobile

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Source checks lock the iroh transport wiring that keyless JVM tests cannot execute. */
class IrohActivityWiringTest {
    @Test
    fun transportLifecycleIsOwnedByTheActivity() {
        val activity = activitySource()
        assertTrue(activity.contains("private val irohController by lazy"))
        assertTrue(activity.contains("IrohNative.initialize(applicationContext)"))
        assertTrue(activity.contains("private fun hasIrohTransport(binding: IrohDeviceBinding)"))
        assertTrue(activity.contains("BuildConfig.IROH_NATIVE_ENABLED"))
        assertTrue(activity.contains("private fun transportFor(origin: GatewayOrigin): TransportEndpoint"))
        assertTrue(activity.contains("private fun stopIrohTransport()"))
        assertTrue(activity.contains("stopIrohTransport()"))
        assertTrue(activity.contains("irohController.close()"))
        assertTrue(activity.contains("activityResumed = true"))
        assertTrue(activity.contains("activityResumed = false"))
    }

    @Test
    fun pairingScreenMintsDescriptorsOverTheNativeTransport() {
        val activity = activitySource()
        assertTrue(activity.contains("private fun showIrohSetup("))
        assertTrue(activity.contains("IrohPairingDescriptor.parse("))
        assertTrue(activity.contains("IrohHttpsTransport(carrier.endpoint)"))
        assertTrue(activity.contains("VersionCompatibility.evaluate(BuildConfig.VERSION_NAME, it)"))
        assertTrue(activity.contains("toastError(R.string.session_storage_failed)"))
        assertTrue(activity.contains("if (BuildConfig.IROH_NATIVE_ENABLED && text.startsWith('{'))"))
    }

    @Test
    fun restoreAndBrowserPathsSelectTheTransportExplicitly() {
        val activity = activitySource()
        assertTrue(activity.contains("transport = transportFor(origin)"))
        assertTrue(activity.contains("if (device.iroh == null) stopIrohTransport()"))
        assertTrue(activity.contains("if (device.iroh != null) showIrohSetup()"))
        assertTrue(activity.contains("startIrohStatusMonitor()"))
        assertTrue(activity.contains("stopIrohStatusMonitor()"))
        assertTrue(activity.contains("IrohDeviceBinding.isIrohHost(origin.host)"))
    }

    @Test
    fun irohCopyExistsInAllThreeLocales() {
        for (locale in listOf("values", "values-zh-rCN", "values-it")) {
            val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder()
                .parse(resFile("res/$locale/strings.xml"))
            val strings = doc.getElementsByTagName("string")
            val names = (0 until strings.length).map { strings.item(it).attributes.getNamedItem("name").nodeValue }
            for (key in listOf(
                "iroh_access_title", "iroh_access_description", "iroh_pairing_help", "iroh_pairing_label",
                "iroh_pairing_hint", "iroh_pairing_private", "iroh_pairing_invalid", "iroh_pairing_retry_new",
                "connection_mode_iroh", "pair_and_connect", "iroh_status_connect_to_check",
                "session_storage_failed",
            )) {
                assertEquals("$locale:$key", 1, names.count { it == key })
            }
        }
    }

    private fun activitySource(): String = resFile("java/io/github/sayach/dshmobile/MainActivity.kt").readText()

    private fun resFile(path: String): File {
        val directories = listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main")
        return generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .flatMap { base -> directories.asSequence().map { File(base, "$it/$path") } }
            .first { it.isFile }
    }
}
