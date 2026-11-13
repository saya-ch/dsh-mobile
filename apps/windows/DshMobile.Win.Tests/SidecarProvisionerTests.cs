using Xunit;

namespace DshMobile.Win.Tests;

public class SidecarProvisionerTests
{
    [Fact]
    public void PinConstantsAreWellFormed()
    {
        Assert.Equal(64, SidecarProvisioner.ExpectedSha256.Length);
        Assert.All(SidecarProvisioner.ExpectedSha256, c => Assert.Contains(c, "0123456789abcdef"));
        Assert.StartsWith("https://unpkg.com/dsh-mobile-iroh@", SidecarProvisioner.DownloadUrl);
        Assert.EndsWith(SidecarProvisioner.FileName, SidecarProvisioner.DownloadUrl);
        Assert.True(SidecarProvisioner.ExpectedBytes > 0);
    }

    [Fact]
    public void Verify_RejectsWrongSizeOrHash()
    {
        var path = Path.Combine(Path.GetTempPath(), "dshm-pin-" + Guid.NewGuid().ToString("N") + ".bin");
        try
        {
            File.WriteAllBytes(path, new byte[1024]);
            Assert.False(SidecarProvisioner.Verify(path));
            File.WriteAllBytes(path, new byte[(int)SidecarProvisioner.ExpectedBytes]);
            Assert.False(SidecarProvisioner.Verify(path)); // right size, wrong hash
        }
        finally { if (File.Exists(path)) File.Delete(path); }
    }

    [Fact]
    public void Verify_RejectsMissingFile()
    {
        Assert.False(SidecarProvisioner.Verify(
            Path.Combine(Path.GetTempPath(), "dshm-missing-" + Guid.NewGuid().ToString("N"))));
    }

    [Fact]
    public void CachePathIsVersionScopedUnderDataRoot()
    {
        var path = SidecarProvisioner.CachePath(@"D:\portable\data");
        Assert.Contains(SidecarProvisioner.Version, path);
        Assert.EndsWith(SidecarProvisioner.FileName, path);
    }
}
