; Inno Setup script template for Synastry.
; IMPORTANT: Output filename is controlled via {#MyAppOutputBase} and is kept in sync by `node scripts/sync_version.mjs`.
; Expected GitHub Releases asset name: `Synastry-<version>-setup.exe`

#include "build\\version.iss"

#ifndef MyAppName
#define MyAppName "Synastry"
#endif

; Directory that contains unpacked Electron app files (built by `electron-builder --dir`).
; Must be provided via ISCC command line: /DMyAppSourceDir="...\\release\\win-unpacked"
#ifndef MyAppSourceDir
#define MyAppSourceDir ""
#endif
#if MyAppSourceDir == ""
  #error MyAppSourceDir is not set. Pass /DMyAppSourceDir="path\\to\\win-unpacked"
#endif

; Fallback values used only if build/version.iss is missing.
#ifndef MyAppVersion
#define MyAppVersion "1.0.8"
#endif

#ifndef MyAppOutputBase
#define MyAppOutputBase "Synastry-1.0.8-setup"
#endif

; Allow overriding installer icon from environment (for CI / A-B testing).
#define MySetupIconFile GetEnv("SYN_SETUP_ICON")
#if MySetupIconFile == ""
#define MySetupIconFile "build\\icons\\icon.ico"
#endif

[Setup]
AppId=com.synastry.desktop
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Vitaliy Alekseev
DefaultDirName={localappdata}\Programs\{#MyAppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
DefaultGroupName={#MyAppName}
SetupIconFile={#MySetupIconFile}
UninstallDisplayIcon={app}\{#MyAppName}.exe
OutputBaseFilename={#MyAppOutputBase}
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
LicenseFile=LICENCE.txt

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\\Russian.isl"

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"

[Files]
Source: "{#MyAppSourceDir}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\\{#MyAppName}"; Filename: "{app}\\{#MyAppName}.exe"
Name: "{autodesktop}\\{#MyAppName}"; Filename: "{app}\\{#MyAppName}.exe"; Tasks: desktopicon

[UninstallDelete]
; Wipe app data on uninstall to avoid keeping stale sessions/cache across reinstalls.
; Trial start time is stored in registry (HKCU\Software\Synastry\FirstLaunchMs) and is preserved.
Type: filesandordirs; Name: "{userappdata}\\Synastry"
Type: filesandordirs; Name: "{userappdata}\\synastry"
Type: filesandordirs; Name: "{localappdata}\\Synastry"
Type: filesandordirs; Name: "{localappdata}\\synastry"
