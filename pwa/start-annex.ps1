# Serves Annex on http://localhost:27180 (local only) so the browser can install it as an app.
# After installing, the app runs without this server (fully offline). Close this window to stop.
$port = 27180
$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$url = "http://localhost:$port/"
function Open-Browser {
    foreach ($b in @("chrome.exe", "msedge.exe", "brave.exe")) {
        try { Start-Process $b $url -ErrorAction Stop; return } catch {}
    }
    Start-Process $url
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)
try { $listener.Start() } catch {
    # Already served by another instance? Then just open it; otherwise let start-annex.cmd fall back to Python.
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $url | Out-Null; Write-Host "Annex is already being served. Opening it."; Open-Browser; Start-Sleep 2; exit 0 }
    catch { Write-Host "Could not start the PowerShell server: $($_.Exception.Message)"; exit 1 }
}
Write-Host "Annex is served at $url (only reachable from this PC). Close this window to stop."
Open-Browser
$types = @{ ".html" = "text/html; charset=utf-8"; ".js" = "text/javascript; charset=utf-8"; ".json" = "application/json"; ".png" = "image/png" }
while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    try {
        $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
        if ($path -eq "/") { $path = "/index.html" }
        $file = [IO.Path]::GetFullPath((Join-Path $root $path.TrimStart("/")))
        if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
            $bytes = [IO.File]::ReadAllBytes($file)
            $ext = [IO.Path]::GetExtension($file).ToLower()
            $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { "application/octet-stream" }
            $res.Headers.Add("Cache-Control", "no-cache")
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else { $res.StatusCode = 404 }
    } catch { $res.StatusCode = 500 } finally { $res.Close() }
}
