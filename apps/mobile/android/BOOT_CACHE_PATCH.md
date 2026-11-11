# Android boot-asset cache

Status: **merged and compiled on** in the Android candidate 0.7.4 (implementation from PR #350). The JVM unit suite passes (78 suites / 534 tests at the 0.7.4 candidate). Device behaviour and byte savings are **not verified**: no phone or emulator has exercised the interception path.

This note replaces the previous pre-merge "local patch" description. That text described an unmerged working copy, an older suite count and a deliberate version freeze; none of those statements apply to the merged code.

## What it does

The gateway rewrites the mobile page into content-revisioned script batches (`/mobile-access/mobile-boot/<64 hex>.js`) and revision-named plugin bundles/assets. The App answers those requests from a device-side store when they were revalidated for the current session, or when their own revision already names the build they belong to, so an unchanged payload is served locally instead of downloaded again.

## Guards

- Only `https`, same gateway origin, and four explicit revisioned URL shapes qualify; only JavaScript/CSS bodies are stored or served. Documents, API responses, credentials and non-revisioned assets never enter the store.
- A body is stored only after its size and SHA-256 match the fetched bytes; a read verifies both again and drops a mismatch.
- Writes are `.part` + `fsync` + atomic rename; the index carries per-entry digests; a byte quota and entry cap apply LRU eviction, and a body survives `clear()` while a reader holds its lease.
- Every miss, cancellation, deadline, rejected fetch or integrity failure returns `null`, leaving the WebView's own request path authoritative. The worst case of being wrong is one duplicated request, never a failed load.

## Kill switch

The single switch is the compile-time `BOOT_ASSET_CACHE_ENABLED` constant in `BootAssetCache.kt`. Setting it to `false` restores the pre-cache behaviour exactly (no store, no interception) and requires a new App build.

## Where the code and evidence live

- Implementation: `app/src/main/java/io/github/sayach/dshmobile/BootAssetCache.kt`, `BootAssetStore.kt`, `BootAssetMetrics.kt`, `HttpBootAssetFetcher.kt`, `SecureWebViewClient.kt`, `MainActivity.kt`.
- Tests: `app/src/test/java/io/github/sayach/dshmobile/BootAsset*Test.kt` and `HttpBootAssetFetcherTest.kt`.
- Counters are diagnostic only: a `DSHMobile` log line is written when a document becomes ready. Device measurement should record `hits`/`misses`/`revalidated`, `bytesServed`/`bytesSaved` and `maxMs`, and a `200` on a second start after a layout change must show a miss with `saved=0`.
