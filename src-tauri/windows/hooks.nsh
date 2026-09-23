; The updater does not uninstall first, and Windows keeps a DLL with a higher
; file version. Foundry's ONNX Runtime files are unversioned names, so the
; previous SDK tree has to be gone before the new files are copied. If a
; file is still locked, stop. Copying over it would leave the old runtime.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  Sleep 500
  IfFileExists "$INSTDIR\foundry-local-sdk\*" foundry_sdk_present foundry_sdk_gone
  foundry_sdk_present:
    RMDir /r "$INSTDIR\foundry-local-sdk"
    IfFileExists "$INSTDIR\foundry-local-sdk\prebuilds\win32-x64\onnxruntime.dll" foundry_sdk_locked
    IfFileExists "$INSTDIR\foundry-local-sdk\foundry-local-core\win32-x64\onnxruntime.dll" foundry_sdk_locked
    IfFileExists "$INSTDIR\foundry-local-sdk\*" foundry_sdk_locked foundry_sdk_gone
  foundry_sdk_locked:
    MessageBox MB_OK|MB_ICONSTOP "Flint could not remove the installed Foundry SDK. Close Flint, then run this installer again. Continuing would leave an older ONNX Runtime in place."
    Abort
  foundry_sdk_gone:
  SetOverwrite on
!macroend
