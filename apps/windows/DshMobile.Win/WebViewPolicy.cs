namespace DshMobile.Win;

/// <summary>
/// Same-origin decisions for the WebView2 surface, mirroring Android's
/// SecureWebViewClient/GatewayUrlPolicy: only the exact paired gateway
/// authority (host and port) is trusted for navigation, downloads and the
/// microphone. Kept free of WebView2 types so it stays unit-testable.
/// </summary>
internal static class WebViewPolicy
{
    internal static bool IsSameGatewayOrigin(string raw, string gatewayOrigin)
    {
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            return false;
        if (!Uri.TryCreate(gatewayOrigin, UriKind.Absolute, out var expected) ||
            expected.Scheme != Uri.UriSchemeHttps)
            return false;
        return string.Equals(uri.GetLeftPart(UriPartial.Authority),
            expected.GetLeftPart(UriPartial.Authority), StringComparison.OrdinalIgnoreCase);
    }
}
