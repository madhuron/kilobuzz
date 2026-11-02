; При удалении Kilobuzz снимаем системный модуль и возвращаем прежние настройки звука Windows.
; При обновлении приложения модуль и режим совместимости не трогаем — новая версия переустановит модуль сама.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadRegStr $0 HKLM "SOFTWARE\Kilobuzz\APO" "Installed"
    ${If} $0 == "1"
      ExecShellWait "runas" "$INSTDIR\resources\bin\kilobuzz-apo-setup.exe" "uninstall" SW_HIDE
    ${EndIf}
  ${endIf}
!macroend
