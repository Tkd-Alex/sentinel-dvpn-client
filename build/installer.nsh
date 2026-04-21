; installer.nsh
;
; Custom NSIS hooks for the Sentinel installer, included by electron-builder
; via the "include" option in the "nsis" section of electron-builder.json.
;
; These macros are called at the right moment by the electron-builder-generated
; NSIS script:
;   customInstall   → after all files have been copied to $INSTDIR
;   customUnInstall → before files are removed on uninstall
;
; The installer already runs with administrator privileges (NSIS requests
; elevation automatically for per-machine installs), so nsExec commands work
; without any additional UAC prompts.
;
; Service details:
;   Name:        SentinelHelper
;   Binary:      $INSTDIR\resources\sentinel-helper.exe --service
;   Start type:  auto (starts with Windows, before user login)
;   Display:     Sentinel Privileged Helper

!macro customInstall
  ; Remove previous task if it exists (idempotent update)
  nsExec::ExecToLog 'schtasks /delete /tn "SentinelHelper" /f'

  ; Create scheduled task: run at system startup, as SYSTEM, without user login
  nsExec::ExecToLog 'schtasks /create /tn "SentinelHelper" \
    /tr "\"$INSTDIR\resources\sentinel-helper.exe\" --service" \
    /sc onstart \
    /ru SYSTEM \
    /rl HIGHEST \
    /f'

  ; Start immediately without waiting for the next reboot
  nsExec::ExecToLog 'schtasks /run /tn "SentinelHelper"'
!macroend


!macro customUnInstall
  nsExec::ExecToLog 'schtasks /end /tn "SentinelHelper"'
  nsExec::ExecToLog 'schtasks /delete /tn "SentinelHelper" /f'
!macroend
