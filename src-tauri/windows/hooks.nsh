; 0.9.1 installs Foundry Local 2.0.1. This release installs 1.2.4.
; The updater does not uninstall first, and Windows keeps a higher file
; version. The old SDK tree has to be gone before the new files are copied.
; If a file is still locked, stop. Copying over it would leave ONNX Runtime 1.28.
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
