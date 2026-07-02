# Link this repo's `jamat` skill into the global Claude skills dir via an NTFS
# junction — independent of the claude-extensions repo (this skill is
# project-specific and versions with the bridge endpoints it documents).
#
# Run once per machine:  pwsh -File .\bin\enable-jamat-skill.ps1
# Re-run is safe (no-op if already linked). Restart Claude Code afterwards.

$ErrorActionPreference = 'Stop'

# Script lives in bin/; the repo root (which holds skills/) is its parent.
$repo   = Split-Path $PSScriptRoot -Parent
$target = Join-Path $repo 'skills\jamat'
$link   = Join-Path $env:USERPROFILE '.claude\skills\jamat'

if (-not (Test-Path $target)) {
  Write-Error "jamat skill source not found: $target"
  exit 1
}

if (Test-Path $link) {
  Write-Host "[jamat] already enabled: $link"
  exit 0
}

$skillsDir = Split-Path $link -Parent
if (-not (Test-Path $skillsDir)) {
  New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
}

New-Item -ItemType Junction -Path $link -Target $target | Out-Null
Write-Host "[jamat] linked: $link -> $target"
Write-Host "[jamat] restart Claude Code to pick up the skill."
