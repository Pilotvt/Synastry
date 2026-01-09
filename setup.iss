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
#define MyAppVersion "1.1.1"
#endif

#ifndef MyAppVersionFour
#define MyAppVersionFour "1.1.1.0"
#endif

#ifndef MyAppOutputBase
#define MyAppOutputBase "Synastry-1.1.1-setup"
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
VersionInfoVersion={#MyAppVersionFour}
VersionInfoProductVersion={#MyAppVersionFour}
VersionInfoCopyright=Copyright (C) Vitaly Alekseev
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

[Registry]
; Register synastry:// protocol handler for deep links from Supabase emails.
Root: HKCU; Subkey: "Software\\Classes\\synastry"; ValueType: string; ValueName: ""; ValueData: "URL:Synastry Protocol"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\\Classes\\synastry"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\\Classes\\synastry\\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppName}.exe,0"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\\Classes\\synastry\\shell\\open\\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppName}.exe"" ""%1"""; Flags: uninsdeletekey

[Code]
function IsUpgradeUninstall(): Boolean;
begin
  Result := Pos('/UPGRADE', Uppercase(GetCmdTail())) > 0;
end;

function IsSilentUninstall(): Boolean;
var
  Tail: string;
begin
  Tail := Uppercase(GetCmdTail());
  Result := (Pos('/SILENT', Tail) > 0) or (Pos('/VERYSILENT', Tail) > 0);
end;

var
  ShouldWipeUserData: Boolean;
  UserDataChoiceAsked: Boolean;

procedure EnsureUserDataChoice();
var
  Answer: Integer;
begin
  if UserDataChoiceAsked then
    exit;
  UserDataChoiceAsked := True;

  if IsUpgradeUninstall() then
  begin
    ShouldWipeUserData := False;
    exit;
  end;

  // In silent mode we should not block on UI; keep user data by default.
  if IsSilentUninstall() then
  begin
    ShouldWipeUserData := False;
    exit;
  end;

  Answer := MsgBox(
    'Удалить данные приложения Synastry?' + #13#10 + #13#10 +
    'Это удалит локальные настройки/кэш и сохранённый лицензионный ключ на этом компьютере.' + #13#10 +
    'Лицензия в Supabase останется привязанной к вашему логину и не пропадёт.',
    mbConfirmation,
    MB_YESNO
  );

  ShouldWipeUserData := (Answer = IDYES);
end;

procedure DeletePycacheDirs(const Root: string);
var
  FindRec: TFindRec;
  PathName: string;
begin
  if not DirExists(Root) then
    exit;

  if FindFirst(Root + '\*', FindRec) then
  try
    repeat
      if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
      begin
        PathName := Root + '\' + FindRec.Name;
        if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
        begin
          if CompareText(FindRec.Name, '__pycache__') = 0 then
            DelTree(PathName, True, True, True)
          else
            DeletePycacheDirs(PathName);
        end;
      end;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResourcesRoot: string;
begin
  if CurUninstallStep <> usUninstall then
    exit;

  EnsureUserDataChoice();

  // During upgrade, Inno runs previous uninstaller first. Do not wipe user data on upgrades.
  if ShouldWipeUserData then
  begin
    // Full uninstall (optional): wipe app data to avoid keeping stale sessions/cache across reinstalls.
    // Trial start time is stored in registry (HKCU\Software\Synastry\FirstLaunchMs) and is preserved.
    DelTree(ExpandConstant('{userappdata}\Synastry'), True, True, True);
    DelTree(ExpandConstant('{userappdata}\synastry'), True, True, True);
    DelTree(ExpandConstant('{localappdata}\Synastry'), True, True, True);
    DelTree(ExpandConstant('{localappdata}\synastry'), True, True, True);
  end;

  ResourcesRoot := ExpandConstant('{app}\resources');
  DeletePycacheDirs(ResourcesRoot);
  DeleteFile(ExpandConstant('{app}\resources\python-embed\_asyncio.pyd.disabled'));
end;
