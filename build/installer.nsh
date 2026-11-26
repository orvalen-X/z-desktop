; Z's uninstaller leaves nothing behind (O 26.11): installing again starts from zero, like a new computer.
; electron-builder already removes %APPDATA%\Z (sign-in, settings, cache) with nsis.deleteAppDataOnUninstall.
; This adds what it does not know about. An update (the uninstaller run with --updated) keeps everything.

!macro zRemoveRunValues ROOTKEY
  ; "Start Z with the computer": any value of this user's Run list that starts this Z.exe.
  StrCpy $R0 0
  StrLen $R4 '"$INSTDIR\Z.exe"'
  StrLen $R5 '$INSTDIR\Z.exe'
  ${Do}
    EnumRegValue $R1 HKCU "${ROOTKEY}" $R0
    ${If} $R1 == ""
      ${Break}
    ${EndIf}
    ReadRegStr $R2 HKCU "${ROOTKEY}" $R1
    StrCpy $R3 $R2 $R4
    StrCpy $R6 $R2 $R5
    ${If} $R3 == '"$INSTDIR\Z.exe"'
    ${OrIf} $R6 == '$INSTDIR\Z.exe'
      DeleteRegValue HKCU "${ROOTKEY}" $R1
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" $R1
    ${Else}
      IntOp $R0 $R0 + 1
    ${EndIf}
  ${Loop}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    !insertmacro zRemoveRunValues "Software\Microsoft\Windows\CurrentVersion\Run"
    ; The updater's downloads and the stored install package.
    RMDir /r "$LOCALAPPDATA\z-desktop-updater"
    ; Z Setup's folder (its download, if any, and setup.log).
    RMDir /r "$TEMP\ZSetup"
    ; Where electron-builder keeps where Z was installed.
    DeleteRegKey HKCU "Software\${APP_GUID}"
  ${endIf}
!macroend
