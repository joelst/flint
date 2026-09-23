; 0.9.1 installs Foundry Local 2.0.1. This release installs 1.2.4.
; Windows keeps a higher file version, so the old SDK has to move aside
; before the new files are copied. A locked directory stays where it is and
; the install stops. If the install does not finish, the moved tree is put
; back. The backup is removed only after the new ONNX Runtime is on disk.
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
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  Sleep 500
  ; foundry-local-sdk.moved marks .previous as the backup of an install that did
  ; not finish (the MSI writes the same marker). That backup is put back even
  ; when the current tree holds a runtime file, because a partial copy can.
  ; An unmarked backup beside a working runtime is a leftover from cleanup:
  ; move it aside. An unmarked backup beside a tree with no runtime is the
  ; recovery copy: put it back, and do not delete it.
  IfFileExists "$INSTDIR\foundry-local-sdk.previous\*" 0 foundry_sdk_move
    IfFileExists "$INSTDIR\foundry-local-sdk.moved" foundry_sdk_recover
    Call FoundryLiveRuntimeExists
    Pop $0
    StrCmp $0 "yes" foundry_sdk_stale_backup
  foundry_sdk_recover:
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
      ; Own the backup before moving anything, so a later run can tell it from
      ; a leftover even if this installer dies or cannot restore it.
      ClearErrors
      FileOpen $1 "$INSTDIR\foundry-local-sdk.moved" w
      FileClose $1
      IfFileExists "$INSTDIR\foundry-local-sdk.moved" foundry_sdk_owned
        MessageBox MB_OK|MB_ICONSTOP "Flint could not write foundry-local-sdk.moved in the install folder. The installed SDK was not changed." /SD IDOK
        Abort
    foundry_sdk_owned:
      ClearErrors
      Rename "$INSTDIR\foundry-local-sdk" "$INSTDIR\foundry-local-sdk.previous"
      IfErrors 0 foundry_sdk_moved
        Delete "$INSTDIR\foundry-local-sdk.moved"
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
  IfFileExists "$INSTDIR\foundry-local-sdk\foundry-local-core\win32-x64\Microsoft.AI.Foundry.Local.Core.dll" foundry_sdk_new_ok
  IfFileExists "$INSTDIR\foundry-local-sdk\foundry-local-core\win32-arm64\Microsoft.AI.Foundry.Local.Core.dll" foundry_sdk_new_ok
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
    ; The install finished, so .previous is no longer a backup to put back. The
    ; marker goes first: a .previous that cannot be removed is then a leftover.
    Delete "$INSTDIR\foundry-local-sdk.moved"
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
  IfFileExists "$INSTDIR\foundry-local-sdk\foundry-local-core\win32-x64\Microsoft.AI.Foundry.Local.Core.dll" foundry_live_yes
  IfFileExists "$INSTDIR\foundry-local-sdk\foundry-local-core\win32-arm64\Microsoft.AI.Foundry.Local.Core.dll" foundry_live_yes
  Push "no"
  Return
  foundry_live_yes:
    Push "yes"
FunctionEnd

; Pushes "none", "restored", or "stranded". The backup is renamed back only
; after the partial copy has been renamed aside. A locked file makes that
; rename fail as a whole, so foundry-local-sdk.previous stays intact.
; A stranded restore keeps foundry-local-sdk.moved, so the next run puts that
; backup back instead of judging it by the partial copy's files.
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
    ; With no backup, a marker marks nothing.
    Delete "$INSTDIR\foundry-local-sdk.moved"
    Push "none"
    Return
  restore_foundry_ok:
    ; The backup is back, so the tree parked at .failed is only garbage now.
    ; A stranded restore keeps it, as it changes nothing else on that path.
    Delete "$INSTDIR\foundry-local-sdk.moved"
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
