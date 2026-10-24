# Merges the per-language MSIs produced by Tauri into one multilingual MSI.
#
# Tauri builds one MSI per configured WiX language. This script keeps the
# base-language MSI, stores the difference to every other language as an
# embedded language transform named after its LCID and lists all LCIDs in the
# package template. Windows Installer then applies the transform matching the
# user's UI language; `msiexec /i KimaiTray.msi TRANSFORMS=:2070` forces one.
#
# Usage: pwsh scripts/merge-msi-languages.ps1 -BundleDir <bundle/msi> [-BaseCulture en-US]
param(
  [Parameter(Mandatory = $true)][string]$BundleDir,
  [string]$BaseCulture = "en-US",
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"

$msiOpenReadOnly = 0
$msiOpenTransact = 1
$msiViewModifyAssign = 3
# Language transforms legitimately switch the code page (e.g. to 1250 for
# Czech); without this flag Windows Installer refuses to apply them.
$msiTransformErrorChangeCodePage = 32
$pidTemplate = 7

# PowerShell wraps COM objects in PSObject; COM rejects the wrapper with a
# type mismatch, so pass the underlying objects.
function Unwrap([object[]]$values) {
  ,@($values | ForEach-Object { if ($_ -is [psobject]) { $_.psobject.BaseObject } else { $_ } })
}
function Invoke-Com($target, [string]$name, [object[]]$arguments = @()) {
  $target.GetType().InvokeMember($name, "InvokeMethod", $null, $target, (Unwrap $arguments))
}
function Get-ComProperty($target, [string]$name, [object[]]$arguments = @()) {
  $target.GetType().InvokeMember($name, "GetProperty", $null, $target, (Unwrap $arguments))
}
function Set-ComProperty($target, [string]$name, [object[]]$arguments) {
  [void]$target.GetType().InvokeMember($name, "SetProperty", $null, $target, (Unwrap $arguments))
}
function Close-Com([ref]$reference) {
  if ($reference.Value) {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($reference.Value)
    $reference.Value = $null
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}

$installer = New-Object -ComObject WindowsInstaller.Installer

function Open-Database([string]$path, [int]$mode) {
  Invoke-Com $installer "OpenDatabase" @($path, $mode)
}
function Invoke-Sql($database, [string]$sql) {
  $view = Invoke-Com $database "OpenView" @($sql)
  [void](Invoke-Com $view "Execute")
  [void](Invoke-Com $view "Close")
  Close-Com ([ref]$view)
}
function Get-MsiProperty($database, [string]$property) {
  $view = Invoke-Com $database "OpenView" @("SELECT ``Value`` FROM ``Property`` WHERE ``Property``='$property'")
  [void](Invoke-Com $view "Execute")
  $record = Invoke-Com $view "Fetch"
  $value = Get-ComProperty $record "StringData" @(1)
  [void](Invoke-Com $view "Close")
  Close-Com ([ref]$record)
  Close-Com ([ref]$view)
  $value
}

$BundleDir = (Resolve-Path $BundleDir).Path
$msis = @(Get-ChildItem -Path $BundleDir -Filter "*.msi" | Sort-Object Name)
$base = $msis | Where-Object { $_.BaseName.EndsWith("_$BaseCulture") } | Select-Object -First 1
if (-not $base) { throw "No $BaseCulture MSI found in $BundleDir" }
$languages = @($msis | Where-Object { $_.FullName -ne $base.FullName })
if ($languages.Count -eq 0) { throw "No additional language MSIs found in $BundleDir" }

if (-not $OutputPath) {
  $merged = Join-Path $BundleDir "merged"
  New-Item -ItemType Directory -Force -Path $merged | Out-Null
  $OutputPath = Join-Path $merged ($base.Name -replace "_$([regex]::Escape($BaseCulture))\.msi$", ".msi")
}
$work = Join-Path ([IO.Path]::GetTempPath()) ("msi-merge-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
Copy-Item $base.FullName $OutputPath -Force
$OutputPath = (Resolve-Path $OutputPath).Path
Write-Host "Base: $($base.Name); languages: $(($languages | ForEach-Object Name) -join ', ')"

$baseDb = Open-Database $OutputPath $msiOpenReadOnly
$productCode = Get-MsiProperty $baseDb "ProductCode"
$baseLcid = Get-MsiProperty $baseDb "ProductLanguage"

# Every language must share the base ProductCode, so the transform only
# carries localized text and upgrades, repairs and GPO see a single product.
$transforms = @()
foreach ($msi in $languages) {
  $copy = Join-Path $work $msi.Name
  Copy-Item $msi.FullName $copy
  $languageDb = Open-Database $copy $msiOpenTransact
  Invoke-Sql $languageDb "UPDATE ``Property`` SET ``Value``='$productCode' WHERE ``Property``='ProductCode'"
  [void](Invoke-Com $languageDb "Commit")
  $lcid = Get-MsiProperty $languageDb "ProductLanguage"
  $transform = Join-Path $work "$lcid.mst"
  [void](Invoke-Com $languageDb "GenerateTransform" @($baseDb, $transform))
  [void](Invoke-Com $languageDb "CreateTransformSummaryInfo" @($baseDb, $transform, $msiTransformErrorChangeCodePage, 0))
  Close-Com ([ref]$languageDb)
  $transforms += [pscustomobject]@{ Lcid = $lcid; Path = $transform; Source = $msi.Name }
  Write-Host ("{0} -> transform {1} ({2:N0} KB)" -f $msi.Name, $lcid, ((Get-Item $transform).Length / 1KB))
}
Close-Com ([ref]$baseDb)

$database = Open-Database $OutputPath $msiOpenTransact
$view = Invoke-Com $database "OpenView" @("SELECT ``Name``,``Data`` FROM ``_Storages``")
[void](Invoke-Com $view "Execute")
foreach ($transform in $transforms) {
  $record = Invoke-Com $installer "CreateRecord" @(2)
  Set-ComProperty $record "StringData" @(1, [string]$transform.Lcid)
  [void](Invoke-Com $record "SetStream" @(2, $transform.Path))
  [void](Invoke-Com $view "Modify" @($msiViewModifyAssign, $record))
  Close-Com ([ref]$record)
}
[void](Invoke-Com $view "Close")
Close-Com ([ref]$view)

$summary = Get-ComProperty $database "SummaryInformation" @(20)
$template = [string](Get-ComProperty $summary "Property" @($pidTemplate))
$platform = $template.Split(";")[0]
$lcids = @($baseLcid) + @($transforms | ForEach-Object { $_.Lcid })
$newTemplate = "$platform;" + ($lcids -join ",")
Set-ComProperty $summary "Property" @($pidTemplate, $newTemplate)
[void](Invoke-Com $summary "Persist")
Close-Com ([ref]$summary)
[void](Invoke-Com $database "Commit")
Close-Com ([ref]$database)

# Verify: each embedded language applies cleanly and keeps the ProductCode.
foreach ($transform in $transforms) {
  $check = Join-Path $work "check-$($transform.Lcid).msi"
  Copy-Item $OutputPath $check
  $checkDb = Open-Database $check $msiOpenTransact
  try {
    [void](Invoke-Com $checkDb "ApplyTransform" @($transform.Path, $msiTransformErrorChangeCodePage))
  } catch {
    throw "Transform $($transform.Lcid) from $($transform.Source) cannot be applied: $($_.Exception.InnerException.Message)"
  }
  $language = Get-MsiProperty $checkDb "ProductLanguage"
  $code = Get-MsiProperty $checkDb "ProductCode"
  Close-Com ([ref]$checkDb)
  if ($language -ne $transform.Lcid -or $code -ne $productCode) {
    throw "Transform $($transform.Lcid) from $($transform.Source) did not apply as expected"
  }
}

Remove-Item -Recurse -Force $work
Write-Host "Multilingual MSI: $OutputPath"
Write-Host "Template: $newTemplate"
