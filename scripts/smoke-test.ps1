# Smoke test del panel (requiere el panel en ejecución)
param(
  [string]$Base = "http://127.0.0.1:7800",
  [string]$User = "admin",
  [string]$Password = "test-1234"
)

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

function Req {
  param([string]$Method, [string]$Path, $Body)
  $params = @{
    Uri         = "$Base$Path"
    Method      = $Method
    WebSession  = $session
    UseBasicParsing = $true
    ErrorAction = "Stop"
  }
  if ($null -ne $Body) {
    $params.Body = ($Body | ConvertTo-Json -Depth 6)
    $params.ContentType = "application/json"
  }
  try {
    $r = Invoke-WebRequest @params
    $json = $null
    try { $json = $r.Content | ConvertFrom-Json } catch { }
    return [pscustomobject]@{ Status = [int]$r.StatusCode; Body = $json }
  } catch {
    $resp = $_.Exception.Response
    $status = if ($resp) { [int]$resp.StatusCode } else { 0 }
    $text = ""
    if ($resp) {
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $text = $reader.ReadToEnd()
    }
    $json = $null
    try { $json = $text | ConvertFrom-Json } catch { }
    return [pscustomobject]@{ Status = $status; Body = $json }
  }
}

$r = Req GET "/api/overview" $null
Write-Host "1) sin sesion           -> $($r.Status) $($r.Body.error)"

$r = Req POST "/api/login" @{ user = $User; password = "incorrecta" }
Write-Host "2) login incorrecto     -> $($r.Status) $($r.Body.error)"

$r = Req POST "/api/login" @{ user = $User; password = $Password }
Write-Host "3) login correcto       -> $($r.Status)"
if ($r.Status -ne 200) { exit 1 }

$r = Req GET "/api/overview" $null
Write-Host "4) overview             -> $($r.Status) frps=$($r.Body.frps.online) nodos=$($r.Body.nodes.Count) tuneles=$($r.Body.tunnels.Count)"

$r = Req PUT "/api/settings" @{
  serverAddr    = "127.0.0.1"
  subDomainHost = "eds.dev"
  vhostHTTPPort = 8080
  vhostHTTPSPort = 0
  publicScheme  = "http"
}
Write-Host "5) guardar ajustes      -> $($r.Status) dominio=$($r.Body.settings.subDomainHost)"

$r = Req POST "/api/tunnels" @{ name = "qpos"; type = "http"; localIP = "127.0.0.1"; localPort = 8000; subdomain = "qpos"; enabled = $true }
Write-Host "6) crear tunel http     -> $($r.Status) $($r.Body.error)"

$r = Req GET "/api/overview" $null
foreach ($t in $r.Body.tunnels) {
  Write-Host "7) tunel                -> $($t.name) online=$($t.online) frp=$($t.frpStatus) url=$($t.url) in=$($t.todayTrafficIn)"
}

$r = Req POST "/api/tunnels" @{ name = "duplicado"; type = "http"; localPort = 9000; subdomain = "qpos" }
Write-Host "8) subdominio duplicado -> $($r.Status) $($r.Body.error)"

$r = Req POST "/api/tunnels" @{ name = "db"; type = "tcp"; localPort = 3306; remotePort = 6100 }
Write-Host "9) crear tunel tcp      -> $($r.Status) $($r.Body.error)"

$r = Req GET "/api/overview" $null
Write-Host "10) stats               -> online=$($r.Body.stats.online)/$($r.Body.stats.total) conns=$($r.Body.stats.curConns) in=$($r.Body.stats.trafficIn) out=$($r.Body.stats.trafficOut)"

$r = Req POST "/api/agent/start" @{}
Write-Host "11) iniciar agente      -> $($r.Status) $($r.Body.error)"

$r = Req GET "/api/nodes" $null
$localNode = $r.Body.nodes | Where-Object { $_.mode -eq "local" } | Select-Object -First 1
$toml = Invoke-WebRequest "$Base/api/nodes/$($localNode.id)/frpc.toml" -WebSession $session -UseBasicParsing
Write-Host "12) descargar frpc.toml -> $($toml.StatusCode) ($($toml.Content.Length) bytes)"

$r = Req GET "/api/server/frps.toml" $null
Write-Host "13) descargar frps.toml -> consultado"

$r = Req POST "/api/logout" @{}
Write-Host "14) logout              -> $($r.Status)"

$r = Req GET "/api/overview" $null
Write-Host "15) tras logout         -> $($r.Status) $($r.Body.error)"
