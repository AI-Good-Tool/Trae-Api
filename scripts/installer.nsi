Unicode true
!include "MUI2.nsh"
Name "Trae Switch"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Trae Switch"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\Trae Switch.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Section "Install"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${SOURCE_DIR}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Trae Switch"
  CreateShortCut "$SMPROGRAMS\Trae Switch\Trae Switch.lnk" "$INSTDIR\Trae Switch.exe"
  CreateShortCut "$SMPROGRAMS\Trae Switch\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TraeSwitch" "DisplayName" "Trae Switch"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TraeSwitch" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TraeSwitch" "UninstallString" '$"$INSTDIR\Uninstall.exe$"'
SectionEnd
Section "Uninstall"
  SetShellVarContext current
  Delete "$SMPROGRAMS\Trae Switch\Trae Switch.lnk"
  Delete "$SMPROGRAMS\Trae Switch\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Trae Switch"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TraeSwitch"
  RMDir /r "$INSTDIR"
SectionEnd
