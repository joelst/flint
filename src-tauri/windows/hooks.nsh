; The updater does not uninstall first, and Windows keeps a DLL with a higher
; file version. Foundry's ONNX Runtime files are unversioned names
; (onnxruntime.dll, onnxruntime-genai.dll), so installing Foundry 2.0.1 over
; 1.2.4, or the reverse, would otherwise leave the previous runtime loaded.
; Remove the installed SDK tree before the new files are copied.
; This hook runs before the installer's own process check.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  Sleep 500
  RMDir /r "$INSTDIR\foundry-local-sdk"
  ClearErrors
  SetOverwrite on
!macroend
