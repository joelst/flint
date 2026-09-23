; The updater does not uninstall first, and Windows keeps a DLL with a higher
; file version. Move the installed Foundry SDK aside before the new files are
; copied. A locked directory stays where it is and the install stops. If the
; install does not finish, the moved tree is put back. The backup is removed
; only after the new ONNX Runtime is on disk.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  Sleep 500
  IfFileExists "$INSTDIR\foundry-local-sdk\*" 0 foundry_sdk_aside_done
    IfFileExists "$INSTDIR\foundry-local-sdk.previous\*" 0 foundry_sdk_rename
      RMDir /r "$INSTDIR\foundry-local-sdk.previous"
    foundry_sdk_rename:
      ClearErrors
      Rename "$INSTDIR\foundry-local-sdk" "$INSTDIR\foundry-local-sdk.previous"
      IfErrors 0 foundry_sdk_aside_done
        MessageBox MB_OK|MB_ICONSTOP "Flint could not move the installed Foundry SDK aside. Close Flint, then run this installer again. Continuing would leave an older ONNX Runtime in place."
        Abort
  foundry_sdk_aside_done:
  SetOverwrite on
!macroend

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\foundry-local-sdk\prebuilds\win32-x64\onnxruntime.dll" foundry_sdk_new_ok
  IfFileExists "$INSTDIR\foundry-local-sdk\prebuilds\win32-arm64\onnxruntime.dll" foundry_sdk_new_ok
  IfFileExists "$INSTDIR\foundry-local-sdk\foundry-local-core\win32-x64\onnxruntime.dll" foundry_sdk_new_ok
  IfFileExists "$INSTDIR\foundry-local-sdk\foundry-local-core\win32-arm64\onnxruntime.dll" foundry_sdk_new_ok
    RMDir /r "$INSTDIR\foundry-local-sdk"
    Rename "$INSTDIR\foundry-local-sdk.previous" "$INSTDIR\foundry-local-sdk"
    MessageBox MB_OK|MB_ICONSTOP "Flint could not install the Foundry SDK that belongs with this version. The previous SDK was put back."
    Abort
  foundry_sdk_new_ok:
    RMDir /r "$INSTDIR\foundry-local-sdk.previous"
!macroend

Function RestoreFoundrySdkBackup
  IfFileExists "$INSTDIR\foundry-local-sdk.previous\*" 0 restore_foundry_done
    RMDir /r "$INSTDIR\foundry-local-sdk"
    Rename "$INSTDIR\foundry-local-sdk.previous" "$INSTDIR\foundry-local-sdk"
  restore_foundry_done:
FunctionEnd

Function .onInstFailed
  Call RestoreFoundrySdkBackup
FunctionEnd

Function .onUserAbort
  Call RestoreFoundrySdkBackup
FunctionEnd
