param([string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent))

$WaterPng  = Join-Path $ProjectRoot 'RpgApi\wwwroot\tilesets\shared\water.png'
$OutputPng = Join-Path $ProjectRoot 'RpgApi\wwwroot\tilesets\shared\water-atlas.png'

if (-not (Test-Path $WaterPng)) { Write-Error "water.png not found at $WaterPng"; exit 1 }

Add-Type -AssemblyName 'System.Drawing'
try { Add-Type -AssemblyName 'System.Drawing.Common' } catch {}
try { Add-Type -AssemblyName 'System.Drawing.Primitives' } catch {}

$refs = [System.AppDomain]::CurrentDomain.GetAssemblies() |
    Where-Object { (-not $_.IsDynamic) -and ($_.Location -ne '') } |
    Select-Object -ExpandProperty Location

$cs = Get-Content (Join-Path $PSScriptRoot 'WaterBaker.cs') -Raw
Add-Type -ReferencedAssemblies $refs -TypeDefinition $cs

Write-Host '=== Water Atlas Baker ===' -ForegroundColor Cyan
Write-Host "Input  : $WaterPng"
Write-Host "Output : $OutputPng"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
[WaterBaker]::Bake($WaterPng, $OutputPng)
$sw.Stop()
$kb = [math]::Round((Get-Item $OutputPng).Length / 1024, 1)
Write-Host "Done in $($sw.ElapsedMilliseconds) ms -- $kb KB" -ForegroundColor Green
Write-Host "Saved : $OutputPng" -ForegroundColor Gray
