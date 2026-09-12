import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const alphaColorTypes = new Set([4, 6])

function fail(message) {
  throw new Error(message)
}

async function read(relativePath, encoding) {
  return readFile(resolve(root, relativePath), encoding)
}

function asString(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a string`)
  return value
}

function singleMatch(source, pattern, label) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1 || matches[0][1] === undefined) {
    fail(`${label} must appear exactly once`)
  }
  return matches[0][1]
}

function androidResourceNames(source, element) {
  return [...source.matchAll(new RegExp(`<${element}\\s+name="([^"]+)"`, 'gu'))]
    .map(match => match[1])
    .filter(value => value !== undefined)
    .sort()
}

function requireSameResourceNames(referenceSource, candidateSource, element, candidateLabel) {
  const reference = androidResourceNames(referenceSource, element)
  const candidate = androidResourceNames(candidateSource, element)
  if (reference.length === 0 || JSON.stringify(candidate) !== JSON.stringify(reference)) {
    fail(`${candidateLabel} must define the same Android ${element} resources as the default locale`)
  }
}

function pngMetadata(buffer, label) {
  if (buffer.length < 33 || !buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
    fail(`${label} is not a valid PNG`)
  }
  const ihdrLength = buffer.readUInt32BE(8)
  const ihdrName = buffer.toString('ascii', 12, 16)
  if (ihdrLength !== 13 || ihdrName !== 'IHDR') fail(`${label} has an invalid IHDR chunk`)

  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const colorType = buffer[25]
  if (colorType === undefined) fail(`${label} has a truncated IHDR chunk`)

  let offset = 8
  let hasTransparencyChunk = false
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const chunkEnd = offset + 12 + length
    if (chunkEnd > buffer.length) fail(`${label} has a truncated PNG chunk`)
    const chunkName = buffer.toString('ascii', offset + 4, offset + 8)
    if (chunkName === 'tRNS') hasTransparencyChunk = true
    offset = chunkEnd
    if (chunkName === 'IEND') break
  }

  return {
    width,
    height,
    hasAlpha: alphaColorTypes.has(colorType) || hasTransparencyChunk,
  }
}

async function checkPng(relativePath, expectedWidth, expectedHeight = expectedWidth, requireAlpha = false) {
  const metadata = pngMetadata(await read(relativePath), relativePath)
  if (metadata.width !== expectedWidth || metadata.height !== expectedHeight) {
    fail(`${relativePath} must be ${expectedWidth}x${expectedHeight}, got ${metadata.width}x${metadata.height}`)
  }
  if (requireAlpha && !metadata.hasAlpha) {
    fail(`${relativePath} must contain an alpha channel for its transparent background`)
  }
}

async function checkBrandAndStoreIcon() {
  const masterPath = 'apps/mobile/brand/app-icon-master.png'
  const master = pngMetadata(await read(masterPath), masterPath)
  if (master.width !== master.height || master.width < 1024) {
    fail(`${masterPath} must be square and at least 1024x1024, got ${master.width}x${master.height}`)
  }
  if (!master.hasAlpha) fail(`${masterPath} must contain an alpha channel`)
  await checkPng('apps/mobile/store/android/icon-512.png', 512, 512, true)
}

async function checkAndroid() {
  const [gradle, manifest, networkSecurity, packageManifest, discovery, nativeAuth, nsdDiscovery, credentialStore, webViewClient, scanActivity, qrDecoder, nativeBridge, nativeBridgePolicy, mainActivity, defaultStrings, chineseStrings, italianStrings, defaultColors, nightColors, clientSource, mobileLayoutSource, nativeMobileSource] = await Promise.all([
    read('apps/mobile/android/app/build.gradle.kts', 'utf8'),
    read('apps/mobile/android/app/src/main/AndroidManifest.xml', 'utf8'),
    read('apps/mobile/android/app/src/main/res/xml/network_security_config.xml', 'utf8'),
    read('package.json', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/LanDiscovery.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/NativeAuthClient.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/NsdDiscovery.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/DeviceCredentialStore.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/SecureWebViewClient.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/ScanActivity.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/QrDecoder.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/NativeBridge.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/NativeBridgePolicy.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/MainActivity.kt', 'utf8'),
    read('apps/mobile/android/app/src/main/res/values/strings.xml', 'utf8'),
    read('apps/mobile/android/app/src/main/res/values-zh-rCN/strings.xml', 'utf8'),
    read('apps/mobile/android/app/src/main/res/values-it/strings.xml', 'utf8'),
    read('apps/mobile/android/app/src/main/res/values/colors.xml', 'utf8'),
    read('apps/mobile/android/app/src/main/res/values-night/colors.xml', 'utf8'),
    read('src/client.ts', 'utf8'),
    read('src/mobile-layout.ts', 'utf8'),
    read('src/native-mobile.ts', 'utf8'),
  ])
  const packageVersion = asString(JSON.parse(packageManifest).version, 'package.version')
  const compileSdk = singleMatch(gradle, /^\s*compileSdk\s*=\s*(\d+)\s*$/gm, 'Android compileSdk')
  const targetSdk = singleMatch(gradle, /^\s*targetSdk\s*=\s*(\d+)\s*$/gm, 'Android targetSdk')
  const versionName = singleMatch(gradle, /^\s*versionName\s*=\s*"([^"]+)"\s*$/gm, 'Android versionName')
  if (compileSdk !== '36' || targetSdk !== '36') {
    fail(`Android compileSdk and targetSdk must both be 36, got ${compileSdk} and ${targetSdk}`)
  }
  if (versionName !== packageVersion) {
    fail(`Android versionName ${JSON.stringify(versionName)} must equal package.version ${JSON.stringify(packageVersion)}`)
  }
  if (!/android:icon="@mipmap\/ic_launcher"/.test(manifest)
    || !/android:roundIcon="@mipmap\/ic_launcher"/.test(manifest)) {
    fail('Android manifest must use the checked launcher icon for icon and roundIcon')
  }
  if (!/android:usesCleartextTraffic="false"/.test(manifest)) {
    fail('Android manifest must keep cleartext traffic disabled')
  }
  for (const permission of [
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.NEARBY_WIFI_DEVICES',
    'android.permission.CHANGE_WIFI_MULTICAST_STATE',
  ]) {
    if (!manifest.includes(permission)) fail(`Android manifest must declare ${permission}`)
  }
  if (!nativeAuth.includes('/mobile-access/discovery') || !nativeAuth.includes('HttpsURLConnection')) {
    fail('Android LAN discovery must probe the HTTPS discovery endpoint')
  }
  if (!discovery.includes('NsdDiscovery.scan') || !nsdDiscovery.includes('_dsh-mobile._tcp.')) {
    fail('Android LAN discovery must listen for DSH DNS-SD services')
  }
  if (!credentialStore.includes('AndroidKeyStore') || !credentialStore.includes('AES/GCM/NoPadding')) {
    fail('Android device credentials must remain encrypted by Android Keystore AES-GCM')
  }
  if (networkSecurity.includes('src="user"')) {
    fail('Android must not trust system-wide user-installed CAs')
  }
  if (!manifest.includes('android.permission.CAMERA')) {
    fail('Android manifest must declare CAMERA for QR pairing')
  }
  if (!manifest.includes('android.permission.POST_NOTIFICATIONS')) {
    fail('Android manifest must declare POST_NOTIFICATIONS for task reminders')
  }
  if (!qrDecoder.includes('MultiFormatReader') || !scanActivity.includes('QrDecoder.decodeNv21')) {
    fail('Android QR pairing must keep ZXing decoding wired to the scanner')
  }
  if (/\.\s*addJavascriptInterface\s*\(/u.test(nativeBridge)
    || /^\s*@(?:android\.webkit\.)?JavascriptInterface\b/mu.test(nativeBridge)) {
    fail('Android native bridge must not use the legacy JavascriptInterface API')
  }
  for (const marker of ['WebViewCompat.addWebMessageListener', 'setOf(origin.serialized)', 'MAX_MESSAGE_BYTES', 'MAX_PENDING', 'files.pick', 'camera.capture']) {
    if (!nativeBridge.includes(marker)) fail(`Android native bridge is missing ${marker}`)
  }
  for (const marker of ['notification.notify', 'NotificationChannel', 'notification_channel_tasks', 'ic_task_notification', 'VISIBILITY_PRIVATE']) {
    if (!nativeBridge.includes(marker)) fail(`Android task reminders are missing ${marker}`)
  }
  for (const marker of ['POST_NOTIFICATIONS', 'TASK_NOTIFICATION_PERMISSION_REQUEST', 'ACTION_APP_NOTIFICATION_SETTINGS']) {
    if (!mainActivity.includes(marker)) fail(`Android task-reminder permission UI is missing ${marker}`)
  }
  if (!nativeBridgePolicy.includes('TASK_NOTIFICATION_CHANNEL_ID')
    || !nativeBridgePolicy.includes('sanitizeNotificationField')
    || !nativeBridgePolicy.includes('sanitizeNotificationTag')) {
    fail('Android task reminders must bound notification text through NativeBridgePolicy')
  }
  if (!nativeBridge.includes('NativeBridgePolicy.isTrustedMessage(origin, sourceOrigin.toString(), isMainFrame)')
    || !nativeBridgePolicy.includes('isMainFrame && GatewayOrigin.parse(sourceOrigin) == origin')) {
    fail('Android native bridge must accept only exact-origin main-frame WebMessages')
  }
  requireSameResourceNames(defaultColors, nightColors, 'color', 'Night theme')
  if (!mainActivity.includes('R.color.app_setup_scrim') || mainActivity.includes('0x99FFFFFF')) {
    fail('Android setup artwork must use the theme-aware app_setup_scrim resource')
  }
  if (!mainActivity.includes('DSHMobile/${BuildConfig.VERSION_NAME}')) {
    fail('Android WebView user agent must report BuildConfig.VERSION_NAME')
  }
  for (const [source, label] of [[chineseStrings, 'Chinese'], [italianStrings, 'Italian']]) {
    requireSameResourceNames(defaultStrings, source, 'string', label)
    requireSameResourceNames(defaultStrings, source, 'plurals', label)
  }
  if (![clientSource, mobileLayoutSource, nativeMobileSource].every(source => !source.includes('dsh-mobile-control-locale'))) {
    fail('Web plugin language must follow DSH and must not persist an independent locale preference')
  }
  if (!webViewClient.includes('error.primaryError == SslError.SSL_UNTRUSTED')
    || !webViewClient.includes('PinnedTls.acceptsWebViewLeaf')
    || !webViewClient.includes('handler.proceed()')) {
    fail('Android WebView private-CA handling must remain restricted to the pinned exact-origin leaf')
  }

  const densitySizes = {
    mdpi: 48,
    hdpi: 72,
    xhdpi: 96,
    xxhdpi: 144,
    xxxhdpi: 192,
  }
  await Promise.all(Object.entries(densitySizes).map(([density, size]) =>
    checkPng(`apps/mobile/android/app/src/main/res/mipmap-${density}/ic_launcher.png`, size, size, true)))
}

async function checkFunnelHost() {
  const [manifestSource, goModule, goSum, source, executable, thirdPartyLicenses] = await Promise.all([
    read('package.json', 'utf8'),
    read('native/funnel-host/go.mod', 'utf8'),
    read('native/funnel-host/go.sum', 'utf8'),
    read('native/funnel-host/main.go', 'utf8'),
    read('bin/dsh-mobile-funnel-win32-x64.exe'),
    read('FUNNEL_THIRD_PARTY_LICENSES.txt', 'utf8'),
  ])
  const manifest = JSON.parse(manifestSource)
  if (!manifest.files?.includes('bin/dsh-mobile-funnel-win32-x64.exe')) {
    fail('package files must include the Windows Funnel host')
  }
  if (!manifest.files?.includes('THIRD_PARTY_NOTICES.md')) fail('package files must include third-party notices')
  if (!manifest.files?.includes('FUNNEL_THIRD_PARTY_LICENSES.txt')) {
    fail('package files must include the generated Funnel third-party licenses')
  }
  if (!/^go 1\.26\.6$/mu.test(goModule) || !/^require tailscale\.com v1\.102\.3$/mu.test(goModule)) {
    fail('Funnel host must pin Go 1.26.6 and Tailscale 1.102.3')
  }
  if (goSum.length === 0 || !source.includes('tailscale.com/tsnet')) fail('Funnel host source and module checksums are incomplete')
  if (executable.byteLength < 2 || executable.subarray(0, 2).toString('ascii') !== 'MZ') {
    fail('Funnel host must be a Windows executable built from the checked source')
  }
  if (executable.byteLength >= 40 * 1024 * 1024) fail('Funnel host must remain below 40 MiB')
  if (!thirdPartyLicenses.includes('Go toolchain: go1.26.6')
    || !thirdPartyLicenses.includes('Embedded third-party modules:')
    || !thirdPartyLicenses.includes('--- BEGIN Go toolchain LICENSE ---')
    || !thirdPartyLicenses.includes('--- BEGIN Go toolchain PATENTS ---')) {
    fail('Funnel third-party license artifact is incomplete')
  }
}

async function main() {
  await Promise.all([
    checkBrandAndStoreIcon(),
    checkAndroid(),
    checkFunnelHost(),
  ])
  console.log('mobile release assets ok: transparent Android icons and Android API 36')
}

main().catch((error) => {
  console.error(`mobile release check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
