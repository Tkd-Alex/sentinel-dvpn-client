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
; elevation automatically for per-machine installs), so sc.exe commands work
; without any additional UAC prompts.
;
; Service details:
;   Name:        SentinelHelper
;   Binary:      $INSTDIR\resources\sentinel-helper.exe --service
;   Start type:  auto (starts with Windows, before user login)
;   Display:     Sentinel Privileged Helper

!macro customInstall
  ; --------------------------------------------------------------------------
  ; Idempotent cleanup: stop and remove any previous installation of the
  ; service before creating a fresh one. This handles upgrades gracefully —
  ; if the service does not exist yet, sc.exe returns a non-fatal error that
  ; nsExec silently ignores (we do not check the exit code here).
  ; --------------------------------------------------------------------------
  nsExec::ExecToLog 'sc stop "SentinelHelper"'
  nsExec::ExecToLog 'sc delete "SentinelHelper"'

  ; --------------------------------------------------------------------------
  ; Create the Windows Service.
  ;
  ; Note the space after "binPath=", "start=", and "DisplayName=" — these
  ; spaces are required by sc.exe; the command fails silently without them.
  ;
  ; The escaped quotes around the exe path handle installation directories
  ; that contain spaces (e.g. "C:\Program Files\Sentinel\").
  ; --------------------------------------------------------------------------
  nsExec::ExecToLog 'sc create "SentinelHelper" \
    binPath= "\"$INSTDIR\resources\sentinel-helper.exe\" --service" \
    start= auto \
    DisplayName= "Sentinel Privileged Helper"'

  ; Set a human-readable description shown in services.msc.
  nsExec::ExecToLog 'sc description "SentinelHelper" \
    "Manages network routes and tun2socks for Sentinel transparent proxy mode. \
    Stopping this service will disable transparent proxy and kill switch features."'

  ; Configure recovery: restart the service automatically after a crash,
  ; with a 3-second delay, up to 3 consecutive failures.
  nsExec::ExecToLog 'sc failure "SentinelHelper" reset= 86400 actions= restart/3000/restart/3000/restart/3000'

  ; Start the service immediately so the user does not have to reboot.
  nsExec::ExecToLog 'sc start "SentinelHelper"'
!macroend


!macro customUnInstall
  ; --------------------------------------------------------------------------
  ; Stop and remove the service on uninstall. We check exit codes here via
  ; Pop so that a failure to stop does not block the rest of uninstallation.
  ; --------------------------------------------------------------------------
  nsExec::ExecToLog 'sc stop "SentinelHelper"'
  Pop $0  ; discard exit code — service may already be stopped

  nsExec::ExecToLog 'sc delete "SentinelHelper"'
  Pop $0  ; discard exit code — service may already be absent
!macroend
