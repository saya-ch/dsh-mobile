/** Check that the Android callback delegates only to the complete pinned-TLS decision. */
export function assertPinnedSslSource(source) {
  const policy = source.split('internal fun acceptsPinnedWebViewSslError(')[1]?.split('/** Categories')[0] ?? ''
  const callback = source.split('override fun onReceivedSslError(')[1]?.split('override fun onReceivedError(')[0] ?? ''
  const policyChecks = ['caCertificate != null', 'primaryError == SslError.SSL_UNTRUSTED',
    'GatewayUrlPolicy.isPinnedAuthority(origin, url)', 'PinnedTls.acceptsWebViewLeaf(origin, caCertificate, leaf)']
  const callbackChecks = ['acceptsPinnedWebViewSslError(origin, caCertificate, error.primaryError,',
    'error.url, error.certificate.x509Certificate)', 'if (pinned)', 'handler.proceed()', 'handler.cancel()', 'onFailure(LoadFailure.TLS)']
  if (!policyChecks.every(check => policy.includes(check)) || !callbackChecks.every(check => callback.includes(check))) {
    throw new Error('Android WebView private-CA handling must retain the complete pinned secure-authority and leaf decision')
  }
}
