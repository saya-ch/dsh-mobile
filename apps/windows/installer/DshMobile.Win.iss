; DSH Mobile Windows client installer (Inno Setup 6).
;
; Build it through build-installer.ps1, which reads <Version> from
; ..\DshMobile.Win\DshMobile.Win.csproj and passes it as /DMyAppVersion=...
; so this script never hardcodes the release version.
;
; The installer is the second distribution form beside the portable zip:
;   - per-machine install by default ({autopf} resolves to %ProgramFiles% because
;     PrivilegesRequired=admin), so an upgrade can write a protected directory;
;   - the directory page stays visible so the user can choose another path;
;   - UsePreviousAppDir keeps an existing per-user install where it is instead of
;     installing a second copy under Program Files;
;   - uninstall deliberately keeps <install>\data (paired computers, settings,
;     logs) unless the user explicitly chooses to delete it.
;
; Elevation is required rather than optional: the client stores its data under
; <install>\data, and an unelevated installer silently fails to write a directory
; the current user does not own.
;
; How the elevation happens matters. Inno's setup loader is always asInvoker and
; raises the UAC prompt itself when PrivilegesRequired=admin, so the in-app
; updater starts the installer WITHOUT Verb=runas on purpose: a setup started
; from an already-elevated process cannot use [Run]'s runasoriginaluser, and the
; relaunched client would then run as administrator.

#ifndef MyAppVersion
  #error MyAppVersion is required. Pass /DMyAppVersion=<version> (read from DshMobile.Win.csproj).
#endif

#ifndef MyAppVersionNumeric
  #define MyAppVersionNumeric "0.0.0.0"
#endif

#ifndef MyPublishDir
  #define MyPublishDir "..\..\..\portable\DshMobile.Win-" + MyAppVersion + "-win-x64"
#endif

#ifndef MyOutputDir
  #define MyOutputDir "..\..\..\dist\windows"
#endif

[Setup]
; Keep this AppId stable: it is the identity used for upgrades and for the
; uninstall entry, so changing it would leave two entries for one product.
AppId={{3BF27463-E736-436E-B558-2603041CAB38}
AppName=DSH Mobile
AppVersion={#MyAppVersion}
AppVerName=DSH Mobile {#MyAppVersion}
AppPublisher=DSH Mobile contributors
AppPublisherURL=https://github.com/saya-ch/dsh-mobile
AppSupportURL=https://github.com/saya-ch/dsh-mobile/issues
AppUpdatesURL=https://github.com/saya-ch/dsh-mobile/releases
VersionInfoVersion={#MyAppVersionNumeric}
VersionInfoProductName=DSH Mobile
VersionInfoDescription=DSH Mobile Windows client installer
VersionInfoCompany=DSH Mobile contributors
VersionInfoCopyright=Copyright (c) DSH Mobile contributors

; Per-machine installation: {autopf} resolves to %ProgramFiles% and the user
; sees one UAC prompt, which the setup raises itself (see the note above). The
; directory page remains enabled so the user can pick another path.
DefaultDirName={autopf}\DshMobile
DefaultGroupName=DSH Mobile
DisableDirPage=no
; Keep an existing per-user install in place instead of adding a second copy under
; Program Files now that the installer is per-machine.
UsePreviousAppDir=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
MinVersion=10.0.17763
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

LicenseFile=..\..\..\LICENSE
OutputDir={#MyOutputDir}
OutputBaseFilename=dsh-mobile-windows-v{#MyAppVersion}-win-x64-setup
SetupIconFile=..\DshMobile.Win\app.ico
UninstallDisplayIcon={app}\DshMobile.Win.exe

Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
AllowNoIcons=yes
CloseApplications=yes

[Languages]
; ChineseSimplified.isl is vendored under Languages\ because the official Inno
; Setup 6 installer does not bundle it (it is a maintained user-contributed
; translation for 6.5.0+, from https://github.com/kira-96/Inno-Setup-Chinese-Simplified-Translation).
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "Languages\ChineseSimplified.isl"

[CustomMessages]
english.DataRetentionPrompt=Keep the data folder? It holds paired computers, settings and logs. Choose Yes to keep it so a reinstall keeps your pairings, or No to delete it.
chinesesimplified.DataRetentionPrompt=是否保留 data 目录？其中包含已配对电脑、设置与日志。选择“是”保留，重新安装后可继续使用原有配对；选择“否”删除。

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Everything in the portable publish folder: DshMobile.Win.exe, icons, docs,
; licences and the WebView2 runtime files. The sidecar is not part of the
; publish folder; the client acquires and verifies it on first iroh use.
Source: "{#MyPublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\DSH Mobile"; Filename: "{app}\DshMobile.Win.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\DSH Mobile"; Filename: "{app}\DshMobile.Win.exe"; WorkingDir: "{app}"; Tasks: desktopicon

; Runs for a silent install too, which is how the in-app updater installs: without this
; the client exits, the installer finishes, and nothing reopens the window. runasoriginaluser
; keeps the relaunched client unelevated.
[Run]
Filename: "{app}\DshMobile.Win.exe"; Description: "{cm:LaunchProgram,DSH Mobile}"; Flags: nowait postinstall runasoriginaluser

; [UninstallDelete] intentionally has no entry for {app}\data. Inno Setup only
; removes the files it installed and anything listed here, so runtime data
; survives an uninstall by default; CurUninstallStepChanged below offers an
; explicit opt-in deletion instead.

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{app}\data');
    if DirExists(DataDir) then
    begin
      { Default is Yes (keep). SuppressibleMsgBox returns the default in silent
        installs/uninstalls, so /VERYSILENT never deletes pairings. }
      if SuppressibleMsgBox(
        ExpandConstant('{cm:DataRetentionPrompt}'),
        mbConfirmation, MB_YESNO or MB_DEFBUTTON1, IDYES) = IDNO then
      begin
        DelTree(DataDir, True, True, True);
      end;
    end;
  end;
end;
