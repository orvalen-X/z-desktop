; Z's uninstaller leaves nothing behind (O 26.11): installing again starts from zero, like a new computer.
; %APPDATA%\Z holds the sign-in, settings and cache. "Z" is a short name another program could also use, so the
; folder is deleted only when Z's own file (z-desktop.json, which Z writes on every start) is in it.
; electron-builder removes HKCU\Software\<guid> itself, at the end. An update (the uninstaller run with --updated) keeps everything.

!macro zRemoveRunValues ROOTKEY
  ; "Start Z with the computer": any value of this user's Run list that starts this Z.exe.
  ; The registers are saved and given back: the uninstaller around this macro may still use them.
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
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
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${If} $INSTDIR != ""
      !insertmacro zRemoveRunValues "Software\Microsoft\Windows\CurrentVersion\Run"
    ${EndIf}
    ; Z's own data. The uninstall runs per user, so $APPDATA is this user's Roaming folder.
    ${If} ${FileExists} "$APPDATA\Z\z-desktop.json"
      RMDir /r "$APPDATA\Z"
    ${EndIf}
    ${If} ${FileExists} "$APPDATA\z-desktop\z-desktop.json"
      RMDir /r "$APPDATA\z-desktop"
    ${EndIf}
    ; The updater's downloads and the stored install package.
    RMDir /r "$LOCALAPPDATA\z-desktop-updater"
    ; Z Setup's folder (its download, if any, and setup.log).
    RMDir /r "$TEMP\ZSetup"
  ${endIf}
!macroend
