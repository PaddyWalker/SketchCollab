# Waits for the next "Send to Claude" from SketchCollab, prints which session it was, then exits.
# Claude runs this in the background while a chat is open, so a sent session wakes Claude up.
$log = Join-Path $PSScriptRoot 'sessions\_sent.log'
$start = if (Test-Path $log) { @(Get-Content $log).Count } else { 0 }
while ($true) {
  Start-Sleep -Seconds 2
  if (Test-Path $log) {
    $lines = @(Get-Content $log)
    if ($lines.Count -gt $start) { "NEW SKETCH SESSION SENT: " + $lines[-1] + "  (the last word is the request: sketch, build, changes or approved; see AGENT_LOOP.md)"; break }
  }
}
