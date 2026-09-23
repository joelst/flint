; 0.9.1 installs Foundry Local 2.0.1. This release installs 1.2.4.
; The updater does not uninstall first, and Windows keeps a higher file
; version, so the old SDK tree has to be removed before files are copied.
; This hook runs before the installer's own process check.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  Sleep 500
  RMDir /r "$INSTDIR\foundry-local-sdk"
  ClearErrors
  SetOverwrite on
!macroend
