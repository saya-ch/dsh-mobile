using System.IO;
using System.Net.Http;
using System.Security.Cryptography;

namespace DshMobile.Win;

/// <summary>
/// Acquires and verifies the official iroh sidecar. The 14.8 MB executable is NOT
/// stored in this repository: it is obtained from the pinned upstream release (the
/// exact URL, byte count and SHA-256 live in <c>src/iroh-component.ts</c>, mirrored
/// in <c>sidecar/manifest.json</c>) and re-verified before every launch. A verified
/// copy in the DSH plugin's private component directory is reused when available,
/// matching the plugin's own installer behavior.
/// </summary>
internal static class SidecarProvisioner
{
    internal const string FileName = "dsh-mobile-iroh-host-win32-x64.exe";
    internal const string Version = "0.1.0-alpha.1";
    internal const string DownloadUrl =
        "https://unpkg.com/dsh-mobile-iroh@" + Version + "/native/" + FileName;
    internal const long ExpectedBytes = 14865920;
    internal const string ExpectedSha256 =
        "883987c636a379dc999a7f15fd1f9addbb7d28f430ed1f952ad5a610c37cc032";

    internal static string CachePath(string dataRoot) =>
        Path.Combine(dataRoot, "components", "iroh", Version, FileName);

    /// <summary>Byte count AND SHA-256 must both match the upstream pin.</summary>
    internal static bool Verify(string path)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length != ExpectedBytes) return false;
            using var stream = File.OpenRead(path);
            return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant() == ExpectedSha256;
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    /// <summary>Read-only reuse of the copy installed by the DSH Mobile plugin.</summary>
    private static string InstalledCopy() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".dsh", "mobile-access", "components", "iroh", Version, FileName);

    /// <summary>
    /// Returns a path that has just passed verification. A corrupt cache is deleted,
    /// never launched. Downloads are staged in a temporary file and only atomically
    /// promoted after verification, so a partial write cannot become the executable.
    /// </summary>
    internal static async Task<string> EnsureAsync(
        string dataRoot, Action<string> log, CancellationToken cancellationToken)
    {
        var target = CachePath(dataRoot);
        if (Verify(target))
        {
            log("iroh sidecar verified (cached)");
            return target;
        }
        try { if (File.Exists(target)) File.Delete(target); }
        catch (Exception error) { log("could not remove corrupt sidecar cache: " + error.Message); }
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);

        var installed = InstalledCopy();
        if (Verify(installed))
        {
            try
            {
                File.Copy(installed, target, overwrite: true);
                if (Verify(target))
                {
                    log("iroh sidecar verified (reused the DSH plugin's installed copy)");
                    return target;
                }
            }
            catch (Exception error) { log("could not reuse installed sidecar: " + error.Message); }
        }

        log($"downloading pinned iroh sidecar {Version} ({ExpectedBytes} bytes)");
        var staged = target + ".download";
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
            using var response = await client.GetAsync(
                DownloadUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            response.EnsureSuccessStatusCode();
            await using (var source = await response.Content.ReadAsStreamAsync(cancellationToken))
            await using (var file = new FileStream(staged, FileMode.Create, FileAccess.Write, FileShare.None))
                await source.CopyToAsync(file, cancellationToken);
            if (!Verify(staged))
                throw new InvalidOperationException("iroh sidecar download failed SHA-256/size verification");
            File.Move(staged, target, overwrite: true);
        }
        finally
        {
            try { if (File.Exists(staged)) File.Delete(staged); }
            catch { /* best-effort cleanup */ }
        }
        if (!Verify(target)) throw new InvalidOperationException("iroh sidecar is not the pinned artifact");
        log("iroh sidecar downloaded and verified");
        return target;
    }
}
