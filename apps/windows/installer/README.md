# Windows installer

`DshMobile.Win.iss` builds the per-user installer with Inno Setup 6. It is compiled
by `build-installer.ps1`, which reads `<Version>` from
`../DshMobile.Win/DshMobile.Win.csproj` and passes it to the script as
`/DMyAppVersion=...`; the `.iss` file therefore never hardcodes the release version.

```powershell
# after dotnet publish -c Release -r win-x64 --self-contained true -o <publish dir>
pwsh apps/windows/installer/build-installer.ps1 -PublishDir <publish dir>
```

The installer defaults to `{autopf}\DshMobile`, which with `PrivilegesRequired=lowest`
resolves to `%LocalAppData%\Programs\DshMobile`, and it asks for no elevation. The
client keeps its pairings, settings and log in `<install>\data` and runs unelevated, so
the install directory has to be writable by the account that runs it — under
`%ProgramFiles%` every launch would complain that the program folder is not writable and
nothing it saved would survive. The directory page stays enabled, a Start Menu shortcut
plus an optional desktop shortcut are created, and `<install>\data` is preserved when
uninstalling unless the user explicitly chooses to delete it.

`Languages/ChineseSimplified.isl` is vendored from
[kira-96/Inno-Setup-Chinese-Simplified-Translation](https://github.com/kira-96/Inno-Setup-Chinese-Simplified-Translation)
(maintained for Inno Setup 6.5.0+) because the official Inno Setup 6 installer
does not bundle Simplified Chinese. It is a build-time UI translation; refresh it
from upstream when the Inno Setup version changes.
