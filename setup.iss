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
#define MyAppVersion "1.0.6"
#endif

#ifndef MyAppOutputBase
#define MyAppOutputBase "Synastry-1.0.6-setup"
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
OutputBaseFilename={#MyAppOutputBase}
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; Flags: unchecked

[Files]
Source: "{#MyAppSourceDir}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\\{#MyAppName}"; Filename: "{app}\\{#MyAppName}.exe"
Name: "{autodesktop}\\{#MyAppName}"; Filename: "{app}\\{#MyAppName}.exe"; Tasks: desktopicon
