# Smoke test del flujo multiseridor (Linux/Windows) + autorización TLS
param(
  [string]$Base = "http://127.0.0.1:7800",
  [string]$User = "admin",
  [string]$Password = "test-1234"
)

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$suffix = -join ((48..57) + (97..122) | Get-Random -Count 4 | ForEach-Object { [char]$_ })

function Req {
  param([string]$Method, [string]$Path, $Body)
  $params = @{ Uri = "$Base$Path"; Method = $Method; WebSession = $session; UseBasicParsing = $true; ErrorAction = "Stop" }
  if ($null -ne $Body) {
    $params.Body = ($Body | ConvertTo-Json -Depth 6)
    $params.ContentType = "application/json"
  }
  try {
    $r = Invoke-WebRequest @params
    $json = $null; try { $json = $r.Content | ConvertFrom-Json } catch { }
    return [pscustomobject]@{ Status = [int]$r.StatusCode; Body = $json; Raw = $r.Content }
  } catch {
    $resp = $_.Exception.Response
    $status = if ($resp) { [int]$resp.StatusCode } else { 0 }
    return [pscustomobject]@{ Status = $status; Body = $null; Raw = "" }
  }
}

$r = Req POST "/api/login" @{ user = $User; password = $Password }
if ($r.Status -ne 200) { Write-Host "Login falló: $($r.Status)" -ForegroundColor Red; exit 1 }
Write-Host "login                  -> $($r.Status)"

# 1. Servidor Linux remoto
$node = (Req POST "/api/nodes" @{ name = "srv-linux-$suffix"; mode = "remote" }).Body.node
Write-Host "crear servidor linux   -> $($node.name) ($($node.mode))"

# 2. Túnel de ese servidor
$tun = (Req POST "/api/tunnels" @{ nodeId = $node.id; name = "api-$suffix"; type = "http"; localIP = "127.0.0.1"; localPort = 9000; subdomain = "api$suffix" }).Body
Write-Host "crear tunel remoto     -> $($tun.tunnel.name) subdominio=$($tun.tunnel.subdomain)"

# 3. Instalador Linux
$sh = Invoke-WebRequest "$Base/api/nodes/$($node.id)/install.sh" -WebSession $session -UseBasicParsing
$okToml = $sh.Content -match '\[\[proxies\]\]' -and $sh.Content -match 'name = "api-' -and $sh.Content -match 'systemd'
Write-Host "install.sh             -> $($sh.StatusCode) ($($sh.Content.Length) bytes, contenido correcto=$okToml)"

# 4. Instalador Windows
$ps = Invoke-WebRequest "$Base/api/nodes/$($node.id)/install.ps1" -WebSession $session -UseBasicParsing
Write-Host "install.ps1            -> $($ps.StatusCode) ($($ps.Content.Length) bytes)"

# 5. frpc.toml del nodo remoto (no debe incluir webServer local)
$toml = Invoke-WebRequest "$Base/api/nodes/$($node.id)/frpc.toml" -WebSession $session -UseBasicParsing
$hasAdmin = $toml.Content -match 'webServer\.port'
Write-Host "frpc.toml remoto       -> $($toml.StatusCode) webServer incluido=$hasAdmin (debe ser False)"

# 6. Autorización TLS on-demand
$allow = Req GET "/api/tls/ask?domain=api$suffix.eds.dev" $null
$deny = Req GET "/api/tls/ask?domain=noexiste.eds.dev" $null
$anon = Req GET "/api/tls/ask?domain=api$suffix.eds.dev" $null
Write-Host "tls/ask permitido      -> $($allow.Status) (esperado 200)"
Write-Host "tls/ask no registrado  -> $($deny.Status) (esperado 403)"

# 7. Estado del túnel remoto (offline: no hay frpc corriendo en esa máquina)
$ov = (Req GET "/api/overview" $null).Body
$t = $ov.tunnels | Where-Object { $_.name -eq "api-$suffix" }
Write-Host "estado tunel remoto    -> online=$($t.online) nodo=$($t.nodeName)"

# 8. Limpieza
Write-Host "eliminar tunel         -> $((Req DELETE "/api/tunnels/$($t.id)" $null).Status)"
Write-Host "eliminar servidor      -> $((Req DELETE "/api/nodes/$($node.id)" $null).Status)"

$localNode = $ov.nodes | Where-Object { $_.mode -eq "local" } | Select-Object -First 1
$localToml = Invoke-WebRequest "$Base/api/nodes/$($localNode.id)/frpc.toml" -WebSession $session -UseBasicParsing
$localAdmin = $localToml.Content -match 'webServer\.port'
Write-Host "frpc.toml local        -> webServer incluido=$localAdmin (debe ser True)"
