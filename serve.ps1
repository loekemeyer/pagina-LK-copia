# Servidor estatico de desarrollo estilo Live Server
# Uso: powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 5500]
param([int]$Port = 5500)

$root = (Get-Location).ProviderPath
$prefix = "http://localhost:$Port/"

# === Mounts: prefijo URL -> carpeta absoluta ===
$mounts = @{
  "/comprobantes/" = "Z:\AAA COBRANZAS\A Depositos a Imprimir"
  "/banco/"        = "Z:\AAA Bancos y Cajas\BANCOS\1) Bancos Loeke\1 ) Conciliacion Bancos Vigente\1 ) Conciliacion Vigente Cta en `$"
}

# === Aliases: URL exacto -> archivo exacto ===
$aliases = @{
  "/banco/credicoop.xls" = "Z:\AAA Bancos y Cajas\BANCOS\1) Bancos Loeke\1 ) Conciliacion Bancos Vigente\1 ) Conciliacion Vigente Cta en `$\1) CONCILIACION CREDICOOP LOEKE.xls"
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch {
  Write-Host "No se pudo iniciar en $prefix. Puerto ocupado? Probar con -Port 5501"
  Write-Host $_.Exception.Message
  exit 1
}

$mime = @{
  ".html"="text/html; charset=utf-8"; ".htm"="text/html; charset=utf-8"
  ".js"="application/javascript; charset=utf-8"
  ".mjs"="application/javascript; charset=utf-8"
  ".css"="text/css; charset=utf-8"
  ".json"="application/json; charset=utf-8"
  ".png"="image/png"; ".jpg"="image/jpeg"; ".jpeg"="image/jpeg"
  ".gif"="image/gif"; ".webp"="image/webp"; ".avif"="image/avif"
  ".svg"="image/svg+xml"; ".ico"="image/x-icon"
  ".woff"="font/woff"; ".woff2"="font/woff2"; ".ttf"="font/ttf"; ".otf"="font/otf"
  ".mp4"="video/mp4"; ".webm"="video/webm"; ".mp3"="audio/mpeg"
  ".xml"="application/xml"; ".txt"="text/plain; charset=utf-8"
  ".pdf"="application/pdf"; ".map"="application/json; charset=utf-8"
  ".xls"="application/vnd.ms-excel"
  ".xlsx"="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
}

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " Dev server: $prefix" -ForegroundColor Cyan
Write-Host " Sirviendo : $root" -ForegroundColor Cyan
Write-Host " Ctrl+C para detener" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $res.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate")
    $res.Headers.Add("X-Content-Type-Options", "nosniff")

    $absPath = [uri]::UnescapeDataString($req.Url.AbsolutePath)
    $rawPath = $absPath.TrimStart('/')
    if ([string]::IsNullOrEmpty($rawPath)) { $rawPath = "index.html" }
    # Evitar path traversal
    if ($rawPath -match '\.\.') {
      $res.StatusCode = 400
      $res.Close()
      Write-Host "[400] $rawPath" -ForegroundColor Red
      continue
    }

    # === API endpoints ===
    if ($absPath -eq "/api/comprobantes-list") {
      $compRoot = $mounts["/comprobantes/"]
      $items = @()
      if (Test-Path $compRoot) {
        $files = Get-ChildItem -Path $compRoot -Recurse -File -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -ne "Thumbs.db" -and $_.Extension -match '\.(jpg|jpeg|png|gif|webp|pdf|bmp)$' }
        foreach ($f in $files) {
          $rel = $f.FullName.Substring($compRoot.Length).TrimStart('\','/').Replace('\','/')
          $items += [pscustomobject]@{
            name = $f.Name
            path = $rel
            url  = "/comprobantes/" + $rel
            size = $f.Length
            mtime = $f.LastWriteTime.ToString("o")
            folder = $f.Directory.Name
          }
        }
      }
      $json = $items | ConvertTo-Json -Depth 3 -Compress
      if ($null -eq $json) { $json = "[]" }
      if ($json -notmatch '^\[') { $json = "[$json]" }
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
      $res.ContentType = "application/json; charset=utf-8"
      $res.Headers.Add("Access-Control-Allow-Origin","*")
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      $res.StatusCode = 200
      $res.OutputStream.Close()
      Write-Host "[200] $absPath ($($items.Count) files)" -ForegroundColor Cyan
      continue
    }

    # === Aliases (URL exacta -> archivo exacto) ===
    $mountedFull = $null
    if ($aliases.ContainsKey($absPath)) {
      $mountedFull = $aliases[$absPath]
    } else {
      # === Mounts (prefijo URL -> carpeta) ===
      foreach ($prefix2 in $mounts.Keys) {
        if ($absPath.StartsWith($prefix2)) {
          $rest = $absPath.Substring($prefix2.Length)
          $rest = $rest -replace '/','\'
          $mountedFull = Join-Path $mounts[$prefix2] $rest
          break
        }
      }
    }

    if ($mountedFull) {
      $full = $mountedFull
    } else {
      $full = Join-Path $root $rawPath
    }
    if ((Test-Path $full) -and (Get-Item $full).PSIsContainer) {
      $full = Join-Path $full "index.html"
    }

    if (Test-Path $full -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $ct = $mime[$ext]
      if (-not $ct) { $ct = "application/octet-stream" }
      # Read with FileShare.ReadWrite so we can read files open in Excel
      try {
        $fs = [System.IO.File]::Open($full, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $ms = New-Object System.IO.MemoryStream
        $fs.CopyTo($ms)
        $fs.Close()
        $bytes = $ms.ToArray()
        $ms.Close()
      } catch {
        $res.StatusCode = 500
        $msg = [System.Text.Encoding]::UTF8.GetBytes("500 - Read error: $($_.Exception.Message)")
        $res.ContentType = "text/plain; charset=utf-8"
        $res.ContentLength64 = $msg.Length
        $res.OutputStream.Write($msg, 0, $msg.Length)
        $res.OutputStream.Close()
        Write-Host "[500] $rawPath - $($_.Exception.Message)" -ForegroundColor Red
        continue
      }
      $res.ContentType = $ct
      $res.Headers.Add("Access-Control-Allow-Origin","*")
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      $res.StatusCode = 200
      Write-Host "[200] $rawPath ($([Math]::Round($bytes.Length/1024))KB)" -ForegroundColor Green
    } else {
      $res.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 - No existe: $rawPath")
      $res.ContentType = "text/plain; charset=utf-8"
      $res.ContentLength64 = $msg.Length
      $res.OutputStream.Write($msg, 0, $msg.Length)
      Write-Host "[404] $rawPath" -ForegroundColor Yellow
    }
    $res.OutputStream.Close()
  } catch {
    Write-Host "ERROR: $_" -ForegroundColor Red
  }
}
