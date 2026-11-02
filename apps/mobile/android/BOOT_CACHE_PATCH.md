# Android boot-batch cache patch (restores #314 under the four 0.8.1 defer conditions)

Status: **local patch. The JVM unit suite compiles and passes (2026-11-02, 74 suites / 503 tests, 0
failures); device behaviour and benefit measurement are still unverified.** See
[Verification](#verification).

0.8.1 withdrew the native boot-batch cache with this release note:

> Defer #314's native boot-batch cache pending request cancellation, durable-body consistency,
> clear-versus-download isolation and device benefit measurements.

This document describes the restored Android implementation and how each of those four conditions
is met in code, where every failure falls back to the untouched upstream path, what the device
measurement records and how to read it on a real phone.

## What a boot batch is

The gateway rewrites its mobile page into a small graph of script batches whose URLs are content
revisioned per module selection:

```
/mobile-access/mobile-boot/<64 hex>.js     (GET, same origin, session cookie, ETag)
```

Those URLs are the only ones this patch touches. The path hash covers the selected modules, but the
gateway can reassemble the same path when its layout file changes, so **a URL hit is still
revalidated**: every interception sends `If-None-Match` to the gateway, `304` keeps the stored body,
`200` replaces it, and everything else falls back.

## Data flow

```
Chromium network thread
  SecureWebViewClient.shouldInterceptRequest
    -> BootAssetResponder.response(GET, !isForMainFrame, url)      (null => WebView owns it)
       -> BootAssetPolicy.key(path + same origin)                  (null => WebView owns it)
       -> BootAssetCache.resolve
          -> BootAssetRequests.await(BootAssetCancellation, 6 s)   (bounded 2-thread pool)
             -> BootAssetStore.acquire(key)                        (size + SHA-256 verified lease)
             -> HttpBootAssetFetcher.fetch(url, storedEtag, cancellation)
                (pinned TLS transport, session cookie, If-None-Match, gzip, Content-Length)
             -> 304  => serve the stored body, HIT
             -> 200  => Serve + BootAssetStore.beginWrite/commit  (epoch-checked, atomic rename)
             -> 401/403/transport/encoding/length failure => Miss
    -> WebResourceResponse(body, headers)   or   null
```

## The four defer conditions

### 1. Request cancellation

| Requirement | Implementation |
| --- | --- |
| The interception runs off the main thread | Chromium calls `shouldInterceptRequest` on a background thread; the download itself runs on `BootAssetRequests`' bounded pool (`dsh-boot-cache-N`, daemon threads, 2 workers + 4 queued jobs) and the Chromium thread only waits on the future — for at most 6 s (`BOOT_ASSET_INTERCEPT_DEADLINE_MS`). |
| A slow download cannot hold the page | The Chromium request thread is blocked while it waits, so the ceiling is deliberately short: 6 s is about twice a healthy LAN batch fetch and above the 3 s connect budget, so a reachable gateway is never cut off mid-handshake. Past it the attempt is cancelled and the WebView performs the request itself with its own budget — the cost of being wrong is one duplicated request, never a failed load. |
| Navigation cancels in-flight downloads | `SecureWebViewClient.onPageStarted` -> `BootAssetResponder.cancelInFlight()` -> `BootAssetRequests.cancelAll()` -> `BootAssetCancellation.cancel()`. |
| WebView destruction / app exit cancels them | `SecureWebViewClient.dispose()` cancels in flight; `MainActivity.destroyWebView` then calls `BootAssetCache.close()`, which cancels again and shuts the pool down (`shutdownNow` + bounded await). `onDestroy` reaches `destroyWebView` unless the process is killed outright. |
| No leaked connections | `HttpBootAssetFetcher` registers `connection.disconnect()` on the cancellation token; a blocking socket read cannot observe a thread interrupt, so cancelling from the main thread is what actually unblocks it. The connection is also disconnected in `finally`. |
| No leaked threads | The pool is owned by one `BootAssetCache` per WebView and closed with it. No thread is created until the first boot batch is intercepted (default `ThreadPoolExecutor` start policy). |
| No leaked temporary files | A body is only written after the transfer completed and verified, through `BootAssetStore.writeAtomically` (`.part` + `fsync` + atomic rename); a `.part` is deleted on any failure and pruned at open. |
| A cancelled download must not land | `BootAssetCache.storeAndServe` refuses to reserve a key when the token is already cancelled, registers `ticket.cancel()` as a cancel listener, checks `ticket.cancelled` inside `BootAssetStore.commit` before the rename, and removes the entry if a cancel is observed after the rename won the race. Nothing from a cancelled attempt is served either. |

Tests: `BootAssetCacheTest.cancellingInFlightStopsTheDownloadAndStoresNothing`,
`BootAssetCacheTest.aDownloadThatOutlivesItsDeadlineFallsBackToTheWebView`,
`HttpBootAssetFetcherTest.cancellingAnInFlightDownloadReportsCancellationInsteadOfBytes`,
`BootAssetCachingWiringTest.navigationAndDisposalCancelAnInFlightBootDownload`.

Residual window: a cancellation that arrives between `commit`'s last check and the atomic rename
still writes a complete, digest-verified body of the current epoch; the caller is not served and
`storeAndServe` deletes that entry when it observes the cancellation.

### 2. Durable-body consistency

| Requirement | Implementation |
| --- | --- |
| Declared length equals the received byte count | `HttpBootAssetFetcher.readResponse` counts the bytes actually read off the wire (`CountingInputStream`) and refuses the transfer when `Content-Length` is known and differs. The check is complete inside the fetcher, so the length does not travel with the body: a `BootAssetFetch.Modified` only exists for a transfer that already matched. The decoded (gunzipped) body is what gets served and stored. |
| A content digest is verified before the write | `HttpBootAssetFetcher` hashes the decoded body (`BootAssetDigest.of`), `BootAssetFetch.Modified.digest` carries it, and `BootAssetStore.commit` recomputes the hash and refuses a mismatch. |
| The write is atomic | `BootAssetStore.writeAtomically`: `.part` + `fd.sync()` + `ATOMIC_MOVE` (falling back to `REPLACE_EXISTING` only where the filesystem has no atomic move), so a crash never leaves a servable half-body. |
| Entry metadata is re-verified before serving | `BootAssetStore.acquire` re-checks the file length and recomputes the SHA-256 against the index; a truncated, padded or tampered file is treated as a miss, deleted, and the request is fetched fresh without a validator. |
| A truncated or invalid entry is not served | Same path: `acquire` returns null, the entry is dropped from the index, and `BootAssetCache` fetches without `If-None-Match`. |
| Index schema | `index.json` is version 2 and stores `etag`, `contentType`, `size`, `digest`, `lastUsedAt`; a v1 or corrupt index is ignored, not trusted. |

Tests: `BootAssetStoreTest.dropsAnEntryWhoseBytesNoLongerMatchTheirDigest`,
`BootAssetStoreTest.dropsATruncatedBodyInsteadOfServingItsPrefix`,
`BootAssetStoreTest.refusesACommitWhoseBodyContradictsItsDigest`,
`BootAssetCacheTest.aStoredBodyThatNoLongerVerifiesIsRefetchedWithoutTheValidator`,
`HttpBootAssetFetcherTest.aTransferThatEndsBeforeItsDeclaredLengthIsRefused`.

Limit: the digest detects damage in the cache directory and truncation on the wire; it does not
defend against a compromised app-private storage directory, which is outside the WebView threat
model this patch inherits.

### 3. Clear-versus-download isolation

`BootAssetStore` keeps a monotonic `epoch` and a per-key version.

| Requirement | Implementation |
| --- | --- |
| `clear()` advances a generation | `BootAssetStore.clear()` increments `epoch` (returned to the caller for logging/tests) in addition to deleting bodies. |
| `clear()` deletes only entries no reader holds | `clear()` marks every slot stale and deletes only files with `leases == 0`; a body a reader holds through `BootAssetStore.acquire` is deleted when the last lease closes. |
| A download that straddles a clear is discarded | `BootAssetCache.resolve` captures `store.currentEpoch()` before fetching; `BootAssetStore.beginWrite(key, expectedEpoch)` refuses a stale epoch and `commit` re-checks it under the store monitor, so nothing is written back into a cleared generation. |
| An evicted key is not resurrected | Every put/remove/evict advances that key's version; `beginWrite` captures it and `commit` refuses a changed version. |
| Only one writer per key | `BootAssetStore.beginWrite` reserves the key (`writers`); a second concurrent interception of the same batch reports `CONTENDED` and lets the WebView fetch it rather than racing the write. |

The cache-clear points are the same two the withdrawn implementation had:
`MainActivity.clearSiteData` (site data) and `MainActivity.confirmDeleteDevice` (removing a paired
device). Both call `MainActivity.clearBootAssetStore()`, which runs `BootAssetStore.clear()` on the
IO executor — `clear()` deletes files and may wait on the store monitor that a running download holds
across an `fsync`, and that must not happen on the UI thread. The timing (site-data clear, device
removal) is unchanged; only the thread is.

Tests: `BootAssetStoreTest.clearAdvancesTheEpochAndRefusesACommitThatStraddledIt`,
`BootAssetStoreTest.aKeyEvictedDuringItsDownloadIsNotResurrected`,
`BootAssetStoreTest.allowsOnlyOneWriterPerKey`,
`BootAssetStoreTest.clearKeepsABodyAliveUntilTheReaderReleasesIt`,
`BootAssetCacheTest.clearingTheStoreDuringADownloadDiscardsTheBodyInsteadOfWritingItBack`,
`BootAssetCacheTest.twoConcurrentRequestsForOneBatchProduceExactlyOneStoredBody`.

### 4. Device benefit measurement

`BootAssetMetrics` is a plain Kotlin, thread-safe counter set. `BootAssetCache` records **exactly one**
outcome per boot-batch request, from the thread that answered it.

| Counter | Meaning |
| --- | --- |
| `hits` | Served from disk after a `304`. |
| `misses` | Transferred by this cache and served (a `200`), or first load. |
| `revalidated` | `304` responses observed (equal to hits today; kept separate because a `304` with an unusable body is counted as `failed`). |
| `rejected` | `401`/`403`; the WebView keeps the request. |
| `failed` | Transport failure, unsupported encoding, declared/actual length mismatch, non-JavaScript response, protocol anomaly. |
| `cancelled` | Navigation, disposal, app exit or deadline. |
| `contended` | Another thread owned the batch or the pool was saturated. |
| `bytesServed` | Bytes handed to the WebView, including bytes served from disk — "what the page received". |
| `bytesFetched` | Response-body bytes that actually crossed the network: the body of every `200` this cache downloaded (a cold load, or the fresh copy that replaced a stale entry). A `304` transfers no body and adds nothing. |
| `bytesSaved` | Bytes delivered from disk after a `304` — the transfer that did not happen. |
| `avgMs` / `maxMs` | Wall-clock per interception. |
| `hitPercent` | `hits / (hits + misses)`. |
| `savedPercent` | `bytesSaved / (bytesSaved + bytesFetched)` — the share of the batch bytes in play that never crossed the network. |

The three byte counters are distinct on purpose, and for the batches this cache answered they satisfy
`bytesServed == bytesFetched + bytesSaved`. That identity is why `savedPercent` must use
`bytesSaved + bytesFetched` as its denominator: a revalidated hit adds to `bytesServed` as well, so a
denominator built from `bytesServed` would report 50% for a start where every batch was revalidated.
A cold start reports `savedPercent=0`, a fully revalidated start reports `100`.

`BootAssetMetrics.snapshot().summary()` renders one line such as:

```
boot-cache requests=3 hits=2 misses=1 revalidated=2 rejected=0 failed=0 cancelled=0 contended=0
served=1000000B fetched=200000B saved=800000B hitPercent=66 savedPercent=80 avgMs=41 maxMs=96
last=HIT:/mobile-access/mobile-boot/<64 hex>.js:37ms
```

(two 400 kB batches revalidated, one 200 kB batch re-downloaded after a layout change:
`served = 1000000 = fetched 200000 + saved 800000`, `savedPercent = 800000 / 1000000 = 80`).

Privacy: a snapshot contains no cookie, no query string, no origin/host and no session or device
identifier. The only per-request string is the revisioned batch path the policy already accepted
(`/mobile-access/mobile-boot/<64 hex>.js`), which is a module-selection hash, not a session value.
`BootAssetCachingWiringTest.aSnapshotCarriesCountersButNeverTheOriginTheCookieOrTheSession` pins that.

`MainActivity.logBootAssetMetrics` writes the summary to logcat with tag `DSHMobile` when a document
becomes ready and again in `destroyWebView`.

## Failure and fallback paths

Every one of these returns from `shouldInterceptRequest` with `null`, i.e. **byte-identical to
upstream 0.8.1**: the WebView performs the request itself with its own cookies, TLS pinning, HTTP
cache, error page and the plugin's boot-failure notice.

| Situation | Result |
| --- | --- |
| Not a `/mobile-access/mobile-boot/<64 hex>.js` URL | `BootAssetPolicy.key` -> null |
| Different origin, `http`, userinfo, query string, fragment, ambiguous path | `BootAssetPolicy.key` -> null |
| Not a `GET`, or a main-frame request | `BootAssetResponder.response` -> null |
| Patch disabled (`BOOT_ASSET_CACHE_ENABLED = false`) or no cache | `BootAssetResponder(null)` -> `enabled == false` -> null |
| Non-JavaScript content type | `FAILED`, not stored, fall back |
| `401` / `403` | `REJECTED`, the stored copy is kept, fall back |
| Network/TLS failure, timeout, unsupported `Content-Encoding` | `FAILED`, fall back |
| Declared length above the 8 MiB cap, or actual != declared | `FAILED`, nothing stored |
| Digest mismatch at commit or at read | nothing stored / entry deleted, miss |
| Another interception owns the batch, or the pool is saturated | `CONTENDED`, fall back |
| Deadline (6 s) exceeded | `CANCELLED`, transfer disconnected, fall back |
| Any exception thrown anywhere in the path | `BootAssetResponder.response` authorises `runCatching`, returns null |
| Cache closed during teardown | `resolve` -> `Miss`, fall back (the page is going away anyway) |

## Verification

### Review round: what changed and why

An independent review of the first delivery found one statistics bug and four robustness gaps. All
of them are fixed in this tree; nothing else changed.

| Finding | Fix |
| --- | --- |
| `savedPercent` divided by `bytesSaved + bytesServed`, so a fully revalidated start reported 50% | `BootAssetMetrics` now counts `bytesFetched` (network body bytes) and computes `saved / (saved + fetched)`; `BootAssetCache` records fetched bytes only on the `200` path. Three tests pin 0 / 100 / mixed. |
| `BootAssetFetch.Modified.declaredLength` was carried but never consumed and its KDoc over-claimed | Field removed: the `Content-Length` check is complete inside `HttpBootAssetFetcher`, so nothing downstream can re-interpret a length it cannot verify. |
| A throwing `WebResourceResponse` construction escaped `shouldInterceptRequest` | The response object is built inside `runCatching` and falls back to `null`, i.e. to the WebView's own request. |
| `bootAssetStore.clear()` ran on the UI thread and could wait on the store monitor | `MainActivity.clearBootAssetStore()` runs it on the IO executor (inline only if that executor is already shut down, so the clear is never dropped); the two call sites keep their timing. |
| Worst-case interception held the Chromium request thread for 20 s | Wait ceiling is 6 s with 3 s connect / 4 s read budgets, and a test pins it to single-digit seconds; the reasoning is in §1 and at `BOOT_ASSET_INTERCEPT_DEADLINE_MS`. |

### Receipt: compiled and unit-tested

Executed on 2026-11-02 (Asia/Shanghai) against this working tree, on a self-contained toolchain
extracted under `/tmp/atc` that changes nothing on the system `PATH` or in any global location:

| Item | Value |
| --- | --- |
| Date | 2026-11-02 17:00 (Asia/Shanghai), after the review fixes in this document |
| JDK | OpenJDK 17.0.2 (build 17.0.2+8-86), `JAVA_HOME=/tmp/atc/jdk` |
| Gradle | 9.8.2 (Kotlin 2.4.10), `GRADLE_USER_HOME=/tmp/atc/gradle-home` |
| Android SDK | platform `android-36`, build-tools `36.0.0`, `ANDROID_HOME=/tmp/atc/android-sdk` |
| Command | `gradle --no-daemon -PirohNative=false :app:clean :app:testDebugUnitTest` |
| Result | **BUILD SUCCESSFUL in 34s**, exit 0 |
| Tests | **74 suites / 503 tests, failures=0, errors=0, skipped=0** |
| Report | `app/build/test-results/testDebugUnitTest/TEST-*.xml` and `app/build/reports/tests/testDebugUnitTest/index.html` |

The exact invocation (no global JDK/SDK on this machine, so the disposable `/tmp/atc` tree supplies
them; a normal checkout replaces the last line with `./gradlew`):

```sh
cd apps/mobile/android               # from the repository root
export JAVA_HOME=/tmp/atc/jdk
export ANDROID_HOME=/tmp/atc/android-sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export GRADLE_USER_HOME=/tmp/atc/gradle-home
export _JAVA_OPTIONS="-Duser.home=/tmp/atc/home"
/tmp/atc/gradle/bin/gradle --no-daemon -PirohNative=false :app:clean :app:testDebugUnitTest
```

A clean build was used so the compile tasks really ran (`compileDebugKotlin`,
`compileDebugUnitTestKotlin`, then `testDebugUnitTest`). The five suites this patch adds are part of
that run and all pass:

| Suite | Tests | Result |
| --- | --- | --- |
| `BootAssetCacheTest` | 19 | pass, 0 skipped |
| `BootAssetStoreTest` | 15 | pass, 0 skipped |
| `HttpBootAssetFetcherTest` | 9 | pass, 0 skipped |
| `BootAssetCachingWiringTest` | 7 | pass, 0 skipped |
| `BootAssetPolicyTest` | 5 | pass, 0 skipped |
| **subtotal** | **55** | **pass** |

What each new suite asserts:

```
BootAssetPolicyTest            same origin, path shape, invalid URLs, metric path
BootAssetStoreTest             atomic write, digest/size verification, LRU, entry cap,
                               epoch clear-vs-download, key eviction, single writer, leases
BootAssetCacheTest             cold load, 304 hit, 200 replace, 401/403, failure, non-JS,
                               no-validator, verification loss, clear-during-download,
                               cancellation, deadline, closed cache, single-writer race,
                               metrics privacy, savedPercent at 0 / 100 / mixed, wait budget
HttpBootAssetFetcherTest       conditional fetch over pinned loopback TLS, 304, 401, 403,
                               timeout, encoding, size cap, truncated transfer, cancellation,
                               digest of the decoded body
BootAssetCachingWiringTest     adapter behaviour (only boot batches, always falls back) plus the
                               source contract that keeps the wiring and both clear points
```

Reproducibility: the pre-review revision was measured three times (74 / 499 / 0 / 0 / 0 on every run
— the initial integration run, a `--rerun` run and a `:app:clean` run). After the review fixes, the
same clean command ran twice and reported 74 / 503 / 0 / 0 / 0 both times (34 s and 35 s); the four
extra tests are the new `savedPercent` and wait-budget cases. No test is skipped or disabled, and
consecutive runs produced no failures; this is not a flakiness proof, but nothing in the suite has
shown order or timing sensitivity so far.

Compiler warnings: exactly two, both pre-existing deprecations in files this patch does not touch
(`NsdDiscovery.kt:34` `resolveService`, `ScanActivity.kt:7` `Camera`). The patch's own sources and
tests compile without warnings.

Note on `--rerun-tasks`: that flag produced a build that reported `testDebugUnitTest` as executed but
wrote no result XML (a Gradle/AGP task-graph quirk with the global flag). Use the per-task `--rerun`
or a `:app:clean` build instead; neither affects the numbers above.

### Still not verified

- **No device or emulator was used.** `adb`/logcat measurements, real WebView interception, gzip
  validator behaviour on a real gateway, cancellation when a page navigates on a physical phone and
  the actual bytes saved are all unmeasured. The fourth defer condition stays open until the
  [measurement procedure](#measuring-on-a-real-device) has been run on hardware.
- `:app:lintDebug` and `:app:assembleDebug` were not run here; only the JVM unit lane was.
- The iroh native lane (`-PirohNative=true`, Rust + NDK) was not exercised; this patch is orthogonal
  to it, but the full-fidelity build remains to be checked.

### Commands for a machine with JDK 17 and Android SDK 36

These are the generic forms (from [apps/mobile/README.md](../README.md#build)); a normal checkout
with a system JDK/SDK needs no `/tmp` toolchain:

```sh
cd apps/mobile/android
# Unit tests, no Rust/NDK requirement (this is the lane verified above):
./gradlew :app:testDebugUnitTest -PirohNative=false

# Same, with the iroh native transport (needs Rust targets + NDK):
./gradlew :app:testDebugUnitTest

# Full debug lane used by the repository:
./gradlew :app:lintDebug :app:testDebugUnitTest :app:assembleDebug \
  -x :app:lintAnalyzeDebugUnitTest -x :app:lintAnalyzeDebugAndroidTest
```

The integration run above used the equivalent `gradle` binary from the temporary toolchain because
this machine has no global JDK/SDK; that directory is disposable — rebuild it by installing JDK 17
and Android SDK 36 as the README describes (or let Android Studio provision them), then use the
`./gradlew` forms above.

## Measuring on a real device

The point of the exercise is the fourth defer condition: prove the cache actually helps on a phone.
**This has not been done yet** — the numbers below are the procedure to run on hardware, not results.

1. Build and install the Debug package (it installs beside the official App):
   ```sh
   cd apps/mobile/android
   ./gradlew :app:assembleDebug -PirohNative=false
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```
2. Start logcat filtering on the app's tag:
   ```sh
   adb logcat -c
   adb logcat -s DSHMobile:I
   ```
3. Cold start: pair/connect to the gateway once so the page loads. On the first document the run
   reports `hits=0`, `misses=<number of boot batches>`, `fetched=<the batch bytes>`, `saved=0B` and
   therefore `savedPercent=0`.
4. Warm start: force-stop and reopen the App on the same gateway and wait for the page to become
   ready. The second line of the same session reports `hits>0`, `revalidated>0`, `saved>0` and
   `savedPercent` above zero — with every batch revalidated it should read `100`, and
   `served` should equal `fetched + saved`. Those saved bytes are what the device no longer
   transfers.
5. Compare the same two runs with the patch disabled (`BOOT_ASSET_CACHE_ENABLED = false`, rebuild):
   every request is then a `misses` transfer and no line is logged at all, which is the 0.8.1
   baseline. Use `adb shell dumpsys package io.github.sayach.dshmobile.debug` only for version checks;
   no pairing or app data needs to be cleared for this comparison.
6. A useful sample is five cold/warm pairs on each of: LAN (Wi-Fi), remote HTTPS (cpolar/Tailscale)
   and iroh, with the gateway layout unchanged. Record `hitPercent`, `savedPercent`, `avgMs`,
   `maxMs` and the batch count. Report the medians; a single pair is not evidence.
7. Sanity checks while measuring: `hits` must never exceed the number of boot batches on the page,
   `bytesSaved` must be a multiple of the served batch sizes, and a `200` on the second start
   (layout changed) must show `misses` and a fresh `saved=0`.

There is no user-visible setting: this is an internal measurement, and the counters are diagnostic
only. The single kill switch is the compile-time `BOOT_ASSET_CACHE_ENABLED` constant in
`BootAssetCache.kt`.

## Files

Restored from the withdrawn implementation (commit `41ce1a86`, removed by `53aa1bdb`) and then
hardened:

| File | Change vs. the withdrawn implementation |
| --- | --- |
| `app/src/main/java/io/github/sayach/dshmobile/BootAssetCache.kt` | Policy kept. Fetch results gained `Cancelled` and the digest (the `Content-Length` check stays inside the fetcher and is not carried on the result). New `BootAssetCancellation`, `BootAssetRequests` (owned, closable, cancellable pool), `BootAssetDecision` (served/fetched/saved bytes, recorded exactly once), and `BootAssetResponder` as the WebView-facing adapter. The old "304 without a stored body, retry without a validator" path is gone: a body is read under a verified lease before its validator is sent, so that state cannot occur; a `304` without a lease is now a protocol anomaly that falls back. |
| `app/src/main/java/io/github/sayach/dshmobile/BootAssetStore.kt` | Index v2 with per-entry SHA-256; `put` replaced by `beginWrite`/`commit`/`abort` with epoch + key-version guards and one writer per key; `read` replaced by `acquire`/lease with digest verification; `clear()` advances the epoch and defers deletion of leased bodies; entry cap (`maxEntries`) added next to the byte quota. |
| `app/src/main/java/io/github/sayach/dshmobile/HttpBootAssetFetcher.kt` | Cancellation token with a `disconnect` hook, counted wire bytes vs `Content-Length`, digest of the decoded body, short budgets (3 s connect / 4 s read) and a 6 s interception ceiling. |
| `app/src/main/java/io/github/sayach/dshmobile/BootAssetMetrics.kt` | New: outcome counters, bytes, latency and a bounded recent-event ring, with a logcat-safe `summary()`. |
| `app/src/main/java/io/github/sayach/dshmobile/SecureWebViewClient.kt` | `shouldInterceptRequest` restored through `BootAssetResponder`; the `WebResourceResponse` itself is built inside `runCatching` so a rejected header or stream falls back to the WebView instead of throwing out of the interception; `onPageStarted` and `dispose` cancel in-flight downloads. |
| `app/src/main/java/io/github/sayach/dshmobile/MainActivity.kt` | One persistent `BootAssetStore` plus one `BootAssetCache` per WebView; `clearBootAssetStore()` runs the store clear on the IO executor (falling back to inline when that executor is already shut down) at the same two moments as before; `close()` and metrics logging in `destroyWebView`; metrics logged when a document becomes ready. |
| `app/src/test/java/io/github/sayach/dshmobile/BootAsset*Test.kt`, `HttpBootAssetFetcherTest.kt` | Rewritten for the hardened API and the four conditions; the wiring test now also proves the adapter's fallback behaviour, not only the source contract. |
| `android/BOOT_CACHE_PATCH.md` | This document. |

Out of scope by instruction: `src/`, `tests/`, `docs/`, `CHANGELOG.md` (the gateway side of the same
patch is owned by a separate change), and the Android App version/manifest (a submission would bump
`versionName`/`versionCode`, which this local patch deliberately does not do).

## Known limits and open questions

- **The 6 s wait ceiling is a judgement call.** It is short enough to protect the page and above the
  connect budget, but no device data exists yet for the slowest real batch; the measurement procedure
  should record `maxMs` and any `cancelled` growth so the number can be re-tuned with evidence.
- **Verified on the JVM only.** The unit suite compiles and passes (see
  [Verification](#verification)), but no device, emulator, lint run or APK build was exercised here.
  What only hardware can settle — WebView interception, cancellation on real navigation, gzip
  validator handling and the measured saving — is still an open measurement.
- **Duplicated preload.** The mobile page preloads the batch and then executes it, so two
  interceptions of one URL can race. The second one reports `CONTENDED` and falls back to the
  WebView, which serves it from Chromium's own cache — the same total network cost as upstream, not
  worse. Serving the second one from the first writer's result would be a further optimisation and
  would need its own measurement.
- **gzip validator.** The gateway's `ETag` for a gzip transfer ends in `-gzip`, while the cached body
  is the decoded bytes. Revalidation is consistent because every request advertises
  `Accept-Encoding: gzip`; the fabricated WebView response advertises the gateway's validator with an
  identity body, which Chromium accepts because the validator covers the same entity. Worth
  re-checking on a device if the gateway ever stops compressing boot batches.
- **iroh.** The cache fetches through `transportFor(origin)`, exactly like the withdrawn
  implementation, so an iroh page revalidates through its CONNECT proxy. Failure to resolve the
  transport falls back to `LocalTransport`, which the iroh host rejects immediately — a miss, not a
  hang.
- **Cookie source.** The fetcher reads `CookieManager` for the batch URL. That is the WebView's own
  session, so a revoked session returns `401`/`403` and falls back; the cache can never outlive the
  cookie that authorised the body.
- **Process death.** `onDestroy` closes the cache; a hard kill leaves only `.part`/`.bin` files that
  the next open verifies or prunes.
