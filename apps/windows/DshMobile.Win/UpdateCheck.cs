namespace DshMobile.Win;

/// <summary>
/// A Windows client release published on GitHub.
/// </summary>
/// <remarks>
/// <paramref name="DownloadUrl"/> is the page a user can always open (it prefers the
/// portable zip for older releases). <paramref name="SetupUrl"/> and
/// <paramref name="SetupChecksumUrl"/> are the installer and its SHA-256 sidecar: they are
/// null for a release that only published the portable zip, and the update row falls back
/// to the release page in that case instead of running something it cannot verify.
/// </remarks>
internal sealed record WindowsRelease(
    string Tag,
    string Version,
    string DownloadUrl,
    bool Prerelease,
    string? SetupUrl = null,
    string? SetupChecksumUrl = null);

/// <summary>
/// Compares release versions and picks the newest <c>windows-v*</c> GitHub release.
/// </summary>
/// <remarks>
/// The Windows client has its own release track (<c>.github/workflows/windows-release.yml</c>
/// publishes <c>windows-v&lt;version&gt;</c> tags), so the plugin's tags must never be
/// offered as a client update. Versions follow the project's own
/// <c>&lt;Version&gt;</c> value, which is SemVer-shaped (<c>0.1.0-alpha</c>): build
/// metadata after '+' is ignored, and a prerelease sorts below its release.
/// </remarks>
internal static class UpdateCheck
{
    internal const string ReleasesApi = "https://api.github.com/repos/saya-ch/dsh-mobile/releases";

    internal const string TagPrefix = "windows-v";

    internal const string ReleasesPage = "https://github.com/saya-ch/dsh-mobile/releases";

    /// <summary>Extract the version from a release tag, or null when it is not ours.</summary>
    internal static string? ParseTagVersion(string? tag)
    {
        if (string.IsNullOrWhiteSpace(tag)) return null;
        var trimmed = tag.Trim();
        if (!trimmed.StartsWith(TagPrefix, StringComparison.OrdinalIgnoreCase)) return null;
        var version = trimmed[TagPrefix.Length..].Trim();
        return version.Length == 0 ? null : version;
    }

    /// <summary>Split into numeric core and prerelease identifiers.</summary>
    internal static (int[] Core, string[] Prerelease) ParseVersion(string? version)
    {
        if (string.IsNullOrWhiteSpace(version)) return ([], []);
        var text = version.Trim().TrimStart('v', 'V');
        var plus = text.IndexOf('+');
        if (plus >= 0) text = text[..plus];
        var dash = text.IndexOf('-');
        var coreText = dash >= 0 ? text[..dash] : text;
        var preText = dash >= 0 ? text[(dash + 1)..] : string.Empty;
        var core = coreText.Split('.', StringSplitOptions.RemoveEmptyEntries)
            .Select(part => int.TryParse(part, out var value) && value >= 0 ? value : 0)
            .ToArray();
        var prerelease = preText.Length == 0
            ? []
            : preText.Split('.', StringSplitOptions.RemoveEmptyEntries);
        return (core, prerelease);
    }

    /// <summary>
    /// SemVer precedence: <paramref name="candidate"/> &gt; <paramref name="current"/>.
    /// </summary>
    internal static bool IsNewer(string? candidate, string? current)
    {
        var (candidateCore, candidatePre) = ParseVersion(candidate);
        var (currentCore, currentPre) = ParseVersion(current);
        if (candidateCore.Length == 0) return false;
        if (currentCore.Length == 0) return true;
        var length = Math.Max(candidateCore.Length, currentCore.Length);
        for (var index = 0; index < length; index++)
        {
            var left = index < candidateCore.Length ? candidateCore[index] : 0;
            var right = index < currentCore.Length ? currentCore[index] : 0;
            if (left != right) return left > right;
        }
        // Same numeric core: a release outranks any prerelease of that core.
        if (candidatePre.Length == 0 && currentPre.Length > 0) return true;
        if (candidatePre.Length > 0 && currentPre.Length == 0) return false;
        for (var index = 0; index < Math.Max(candidatePre.Length, currentPre.Length); index++)
        {
            if (index >= candidatePre.Length) return false;
            if (index >= currentPre.Length) return true;
            var left = candidatePre[index];
            var right = currentPre[index];
            var leftNumeric = int.TryParse(left, out var leftValue);
            var rightNumeric = int.TryParse(right, out var rightValue);
            if (leftNumeric && rightNumeric)
            {
                if (leftValue != rightValue) return leftValue > rightValue;
                continue;
            }
            // Numeric identifiers always have lower precedence than alphanumeric ones.
            if (leftNumeric != rightNumeric) return !leftNumeric;
            var comparison = string.Compare(left, right, StringComparison.Ordinal);
            if (comparison != 0) return comparison > 0;
        }
        return false;
    }

    /// <summary>
    /// Pick the newest published <c>windows-v*</c> release newer than
    /// <paramref name="currentVersion"/>. Returns null when the client is up to date,
    /// when the payload is unusable, or when no client release exists yet.
    /// </summary>
    internal static WindowsRelease? SelectLatest(string? releasesJson, string? currentVersion)
    {
        if (string.IsNullOrWhiteSpace(releasesJson)) return null;
        WindowsRelease? best = null;
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(releasesJson);
            if (document.RootElement.ValueKind != System.Text.Json.JsonValueKind.Array) return null;
            foreach (var release in document.RootElement.EnumerateArray())
            {
                if (release.ValueKind != System.Text.Json.JsonValueKind.Object) continue;
                // A draft is not published, so it must never be offered.
                if (release.TryGetProperty("draft", out var draft) && draft.ValueKind == System.Text.Json.JsonValueKind.True)
                    continue;
                if (!release.TryGetProperty("tag_name", out var tagElement) ||
                    tagElement.ValueKind != System.Text.Json.JsonValueKind.String)
                    continue;
                var tag = tagElement.GetString() ?? string.Empty;
                var version = ParseTagVersion(tag);
                if (version is null) continue;
                var prerelease = release.TryGetProperty("prerelease", out var pre) &&
                                 pre.ValueKind == System.Text.Json.JsonValueKind.True;
                var links = CollectAssets(release);
                var url = links.Zip ?? links.Setup ?? PageUrl(release) ?? ReleasesPage;
                var candidate = new WindowsRelease(tag, version, url, prerelease, links.Setup, links.Checksum);
                if (best is null || IsNewer(candidate.Version, best.Version)) best = candidate;
            }
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
        if (best is null || !IsNewer(best.Version, currentVersion)) return null;
        return best;
    }

    /// <summary>Download URLs of the assets the updater can use, when the release has them.</summary>
    private readonly record struct Assets(string? Zip, string? Setup, string? Checksum);

    /// <summary>
    /// Collect the portable zip, the installer and the installer's checksum sidecar.
    /// </summary>
    /// <remarks>
    /// The Windows release workflow publishes
    /// <c>dsh-mobile-windows-v&lt;version&gt;-win-x64-setup.exe</c> beside
    /// <c>…-setup.exe.sha256</c>, so the match is on those suffixes rather than on the
    /// version number. The portable zip stays the preferred <see cref="DownloadUrl"/>
    /// because it is the link a user opens by hand; the updater asks for
    /// <see cref="Assets.Setup"/> explicitly.
    /// </remarks>
    private static Assets CollectAssets(System.Text.Json.JsonElement release)
    {
        if (!release.TryGetProperty("assets", out var assets) ||
            assets.ValueKind != System.Text.Json.JsonValueKind.Array) return default;
        string? zip = null, setup = null, checksum = null;
        foreach (var asset in assets.EnumerateArray())
        {
            if (asset.ValueKind != System.Text.Json.JsonValueKind.Object) continue;
            if (!asset.TryGetProperty("name", out var nameElement) ||
                nameElement.ValueKind != System.Text.Json.JsonValueKind.String) continue;
            if (!asset.TryGetProperty("browser_download_url", out var urlElement) ||
                urlElement.ValueKind != System.Text.Json.JsonValueKind.String) continue;
            var name = nameElement.GetString() ?? string.Empty;
            var url = urlElement.GetString();
            if (string.IsNullOrEmpty(url)) continue;
            if (name.EndsWith(".exe.sha256", StringComparison.OrdinalIgnoreCase)) checksum ??= url;
            else if (name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)) zip ??= url;
            else if (name.EndsWith("-setup.exe", StringComparison.OrdinalIgnoreCase)) setup ??= url;
        }
        return new Assets(zip, setup, checksum);
    }

    private static string? PageUrl(System.Text.Json.JsonElement release) =>
        release.TryGetProperty("html_url", out var element) &&
        element.ValueKind == System.Text.Json.JsonValueKind.String
            ? element.GetString() : null;
}
