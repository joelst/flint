; The updater does not uninstall first, and Windows keeps a DLL with a higher
; file version. Move the installed Foundry SDK aside before the new files are
; copied. A locked directory stays where it is and the install stops. If the
; install does not finish, the moved tree is put back. The backup is removed
; only after the new ONNX Runtime is on disk.
;
; The failure and cancel handlers restore only a backup this run moved aside.
; A foundry-local-sdk.previous that was already there when a page was
; cancelled, or that preinstall could not clear, is a leftover. Putting it back
; would move the working SDK to foundry-local-sdk.failed, which the next
; install deletes.
!define MUI_CUSTOMFUNCTION_ABORT RestoreFoundrySdkOnAbort
!define FOUNDRY_SDK_STRANDED_MESSAGE "Flint could not put the previous Foundry SDK back because a file in the new copy is still open. Close that program, then rename foundry-local-sdk.previous to foundry-local-sdk in the Flint install folder."
Var FoundrySdkMovedAside
!macro NSIS_HOOK_PREINSTALL
  ; The macro passes this to nsis_tauri_utils::FindProcess, which walks a
  ; Toolhelp process snapshot and compares the executable's file name. A full
  ; path never matches. This is the same call Tauri's installer template makes.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  Sleep 500
  ; A backup beside a working runtime is a leftover from cleanup, not the
  ; only good SDK. Move that leftover aside. A backup beside a tree with no
  ; runtime is the recovery copy: put it back, and do not delete it.
  IfFileExists "$INSTDIR\foundry-local-sdk.previous\*" 0 foundry_sdk_move
    Call FoundryLiveRuntimeExists
    Pop $0
    StrCmp $0 "yes" foundry_sdk_stale_backup
    Call RestoreFoundrySdkBackup
    Pop $0
    StrCmp $0 "stranded" foundry_sdk_keep_backup
    Goto foundry_sdk_move
  foundry_sdk_stale_backup:
    ; This run did not make this backup, so a later failure must not restore it.
    ClearErrors
    RMDir /r "$INSTDIR\foundry-local-sdk.previous"
    IfFileExists "$INSTDIR\foundry-local-sdk.previous\*" 0 foundry_sdk_move
      ; A leftover from an earlier cleanup is already here. It is older still.
      RMDir /r "$INSTDIR\foundry-local-sdk.previous-kept"
      ClearErrors
      Rename "$INSTDIR\foundry-local-sdk.previous" "$INSTDIR\foundry-local-sdk.previous-kept"
      IfErrors 0 foundry_sdk_move
        MessageBox MB_OK|MB_ICONSTOP "An older Foundry SDK backup at foundry-local-sdk.previous could not be moved. Close the program using that folder, then run the installer again. The installed SDK was not changed." /SD IDOK
        Abort
  foundry_sdk_move:
    IfFileExists "$INSTDIR\foundry-local-sdk.failed\*" 0 foundry_sdk_failed_clear
      ClearErrors
      RMDir /r "$INSTDIR\foundry-local-sdk.failed"
      IfFileExists "$INSTDIR\foundry-local-sdk.failed\*" 0 foundry_sdk_failed_clear
        MessageBox MB_OK|MB_ICONSTOP "Flint could not remove foundry-local-sdk.failed. Close the program using that folder, then run the installer again. The installed SDK was not changed." /SD IDOK
        Abort
    foundry_sdk_failed_clear:
    IfFileExists "$INSTDIR\foundry-local-sdk\*" 0 foundry_sdk_aside_done
      ClearErrors
      Rename "$INSTDIR\foundry-local-sdk" "$INSTDIR\foundry-local-sdk.previous"
      IfErrors 0 foundry_sdk_moved
        MessageBox MB_OK|MB_ICONSTOP "Flint could not move the installed Foundry SDK aside. Close Flint, then run this installer again. Continuing would leave an older ONNX Runtime in place." /SD IDOK
        Abort
  foundry_sdk_keep_backup:
    MessageBox MB_OK|MB_ICONSTOP "${FOUNDRY_SDK_STRANDED_MESSAGE}" /SD IDOK
    Abort
  foundry_sdk_moved:
    StrCpy $FoundrySdkMovedAside "1"
  foundry_sdk_aside_done:
  SetOverwrite on
!macroend

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\foundry-local-sdk\prebuilds\win32-x64\onnxruntime.dll" foundry_sdk_new_ok
  IfFileExists "$INSTDIR\foundry-local-sdk\prebuilds\win32-arm64\onnxruntime.dll" foundry_sdk_new_ok
  IfFileExists "$INSTDIR\foundry-local-sdk\foundry-local-core\win32-x64\onnxruntime.dll" foundry_sdk_new_ok
  IfFileExists "$INSTDIR\foundry-local-sdk\foundry-local-core\win32-arm64\onnxruntime.dll" foundry_sdk_new_ok
    StrCmp $FoundrySdkMovedAside "1" 0 foundry_sdk_nothing_moved
    ; Restore here, then clear the flag so .onInstFailed does not try again.
    StrCpy $FoundrySdkMovedAside ""
    Call RestoreFoundrySdkBackup
    Pop $0
    StrCmp $0 "stranded" foundry_sdk_stranded
    MessageBox MB_OK|MB_ICONSTOP "Flint could not install the Foundry SDK that belongs with this version. The previous SDK was put back." /SD IDOK
    Abort
  foundry_sdk_nothing_moved:
    MessageBox MB_OK|MB_ICONSTOP "Flint could not install the Foundry SDK that belongs with this version." /SD IDOK
    Abort
  foundry_sdk_stranded:
    MessageBox MB_OK|MB_ICONSTOP "${FOUNDRY_SDK_STRANDED_MESSAGE}" /SD IDOK
    Abort
  foundry_sdk_new_ok:
    StrCpy $FoundrySdkMovedAside ""
    ; .failed only holds a tree that was parked aside; nothing restores from it.
    RMDir /r "$INSTDIR\foundry-local-sdk.failed"
    RMDir /r "$INSTDIR\foundry-local-sdk.previous-kept"
    RMDir /r "$INSTDIR\foundry-local-sdk.previous"
    IfFileExists "$INSTDIR\foundry-local-sdk.previous\*" 0 foundry_sdk_backup_gone
      MessageBox MB_OK|MB_ICONEXCLAMATION "Flint installed the new Foundry SDK, but could not remove foundry-local-sdk.previous. The installed SDK is the new one. The next upgrade moves that leftover aside instead of replacing the installed SDK with it." /SD IDOK
    foundry_sdk_backup_gone:
!macroend

Function FoundryLiveRuntimeExists
  IfFileExists "$INSTDIR\foundry-local-sdk\prebuilds\win32-x64\onnxruntime.dll" foundry_live_yes
  IfFileExists "$INSTDIR\foundry-local-sdk\prebuilds\win32-arm64\onnxruntime.dll" foundry_live_yes
  IfFileExists "$INSTDIR\foundry-local-sdk\foundry-local-core\win32-x64\onnxruntime.dll" foundry_live_yes
  IfFileExists "$INSTDIR\foundry-local-sdk\foundry-local-core\win32-arm64\onnxruntime.dll" foundry_live_yes
  Push "no"
  Return
  foundry_live_yes:
    Push "yes"
FunctionEnd

; Pushes "none", "restored", or "stranded". The backup is renamed back only
; after the partial copy has been renamed aside. A locked file makes that
; rename fail as a whole, so foundry-local-sdk.previous stays intact.
Function RestoreFoundrySdkBackup
  IfFileExists "$INSTDIR\foundry-local-sdk.previous\*" 0 restore_foundry_none
    IfFileExists "$INSTDIR\foundry-local-sdk.failed\*" 0 restore_foundry_move_partial
      RMDir /r "$INSTDIR\foundry-local-sdk.failed"
    restore_foundry_move_partial:
      IfFileExists "$INSTDIR\foundry-local-sdk\*" 0 restore_foundry_rename_backup
        ClearErrors
        Rename "$INSTDIR\foundry-local-sdk" "$INSTDIR\foundry-local-sdk.failed"
      restore_foundry_rename_backup:
        ClearErrors
        Rename "$INSTDIR\foundry-local-sdk.previous" "$INSTDIR\foundry-local-sdk"
        IfFileExists "$INSTDIR\foundry-local-sdk.previous\*" restore_foundry_stranded restore_foundry_ok
  restore_foundry_none:
    Push "none"
    Return
  restore_foundry_ok:
    ; The backup is back, so the tree parked at .failed is only garbage now.
    ; A stranded restore keeps it, as it changes nothing else on that path.
    RMDir /r "$INSTDIR\foundry-local-sdk.failed"
    Push "restored"
    Return
  restore_foundry_stranded:
    Push "stranded"
FunctionEnd

Function .onInstFailed
  StrCmp $FoundrySdkMovedAside "1" 0 inst_failed_done
  StrCpy $FoundrySdkMovedAside ""
  Call RestoreFoundrySdkBackup
  Pop $0
  StrCmp $0 "stranded" 0 inst_failed_done
    MessageBox MB_OK|MB_ICONSTOP "${FOUNDRY_SDK_STRANDED_MESSAGE}" /SD IDOK
  inst_failed_done:
FunctionEnd

; Cancel on a page before the install section has moved nothing, so this
; leaves the install folder alone.
Function RestoreFoundrySdkOnAbort
  StrCmp $FoundrySdkMovedAside "1" 0 user_abort_done
  StrCpy $FoundrySdkMovedAside ""
  Call RestoreFoundrySdkBackup
  Pop $0
  StrCmp $0 "restored" user_abort_restored
  StrCmp $0 "stranded" 0 user_abort_done
    MessageBox MB_OK|MB_ICONSTOP "${FOUNDRY_SDK_STRANDED_MESSAGE}" /SD IDOK
    Goto user_abort_done
  user_abort_restored:
    MessageBox MB_OK "The previous Foundry SDK was put back." /SD IDOK
  user_abort_done:
FunctionEnd
