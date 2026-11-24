// Standalone browser entry: run before DSH evaluates its boot scripts or plugins.
import 'core-js/es/iterator/index.js'
import 'core-js/actual/iterator/join.js'
import 'core-js/es/promise/with-resolvers.js'
import 'core-js/es/object/has-own.js'
import 'core-js/es/array/at.js'
import 'core-js/es/string/at.js'
import 'core-js/es/array/find-last.js'
import 'core-js/es/array/find-last-index.js'
import 'core-js/es/array/to-sorted.js'
import 'core-js/es/array/to-reversed.js'
// URL.canParse/URL.parse are Chromium 120 and 126 respectively; assistant text failed to
// render on an Android 12 WebView below that baseline (#450).
import 'core-js/actual/url/can-parse.js'
import 'core-js/actual/url/parse.js'
import 'core-js/stable/structured-clone.js'
import { installAbortSignalCompatibility } from './mobile-abort-signal.js'
import { installMobileBootFeedback } from './mobile-boot-feedback.js'
// A custom-scheme address parses as an opaque path on some WebViews, which empties the
// authority that client resource records are filed under (#415).
import { installUrlAuthorityCompatibility } from './mobile-url-authority.js'

installAbortSignalCompatibility()
installUrlAuthorityCompatibility()
installMobileBootFeedback()
