; The updater does not uninstall first, and Windows keeps a DLL with a higher
; file version. Move the installed Foundry SDK aside before the new files are
; copied. A locked directory stays where it is and the install stops. If the
; install does not finish, the moved tree is put back. The backup is removed
; only after the new ONNX Runtime is on disk.
!define MUI_CUSTOMFUNCTION_ABORT RestoreFoundrySdkOnAbort
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  Sleep 500
  ; A stranded backup is the only known-good SDK after a failed restore.
  ; Put it back first. If that fails, stop. Do not delete the backup.
  IfFileExists "$INSTDIR\foundry-local-sdk.previous\*" 0 foundry_sdk_move
    Call RestoreFoundrySdkBackup
    Pop $0
    StrCmp $0 "stranded" foundry_sdk_keep_backup
  foundry_sdk_move:
    IfFileExists "$INSTDIR\foundry-local-sdk\*" 0 foundry_sdk_aside_done
      ClearErrors
      Rename "$INSTDIR\foundry-local-sdk" "$INSTDIR\foundry-local-sdk.previous"
      IfErrors 0 foundry_sdk_aside_done
        MessageBox MB_OK|MB_ICONSTOP "Flint could not move the installed Foundry SDK aside. Close Flint, then run this installer again. Continuing would leave an older ONNX Runtime in place."
        Abort
  foundry_sdk_keep_backup:
    MessageBox MB_OK|MB_ICONSTOP "Flint could not put the previous Foundry SDK back because a file in the new copy is still open. Close that program, then rename foundry-local-sdk.previous to foundry-local-sdk in the Flint install folder."
    Abort
  foundry_sdk_aside_done:
  SetOverwrite on
!macroend

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\foundry-local-sdk\prebuilds\win32-${ARCH}\onnxruntime.dll" foundry_sdk_new_ok
  IfFileExists "$INSTDIR\foundry-local-sdk\foundry-local-core\win32-${ARCH}\onnxruntime.dll" foundry_sdk_new_ok
    Call RestoreFoundrySdkBackup
    Pop $0
    StrCmp $0 "stranded" foundry_sdk_stranded
    MessageBox MB_OK|MB_ICONSTOP "Flint could not install the Foundry SDK that belongs with this version. The previous SDK was put back."
    Abort
  foundry_sdk_stranded:
    Abort
  foundry_sdk_new_ok:
    RMDir /r "$INSTDIR\foundry-local-sdk.previous"
!macroend

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
    Push "restored"
    Return
  restore_foundry_stranded:
    Push "stranded"
FunctionEnd

Function .onInstFailed
  Call RestoreFoundrySdkBackup
  Pop $0
  StrCmp $0 "stranded" 0 inst_failed_done
    MessageBox MB_OK|MB_ICONSTOP "Flint could not put the previous Foundry SDK back because a file in the new copy is still open. Close that program, then rename foundry-local-sdk.previous to foundry-local-sdk in the Flint install folder."
  inst_failed_done:
FunctionEnd

Function RestoreFoundrySdkOnAbort
  Call RestoreFoundrySdkBackup
  Pop $0
  StrCmp $0 "restored" user_abort_restored
  StrCmp $0 "stranded" 0 user_abort_done
    MessageBox MB_OK|MB_ICONSTOP "Flint could not put the previous Foundry SDK back because a file in the new copy is still open. Close that program, then rename foundry-local-sdk.previous to foundry-local-sdk in the Flint install folder."
    Goto user_abort_done
  user_abort_restored:
    MessageBox MB_OK "The previous Foundry SDK was put back."
  user_abort_done:
FunctionEnd
