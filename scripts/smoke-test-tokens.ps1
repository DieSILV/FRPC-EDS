# Prueba del plugin de autenticación por token (una por servidor)
param(
  [string]$Base = "http://127.0.0.1:7800",
  [string]$User = "admin",
  [string]$Password = "test-1234"
)

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$suffix = -join ((97..122) | Get-Random -Count 4 | ForEach-Object { [char]$_ })

function Api {
  param([string]$Method, [string]$Path, $Body)
  $p = @{ Uri = "$Base$Path"; Method = $Method; WebSession = $session; UseBasicParsing = $true }
  if ($null -ne $Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8); $p.ContentType = "application/json" }
  try {
    $r = Invoke-WebRequest @p
    return ($r.Content | ConvertFrom-Json)
  } catch {
    return $null
  }
}

# Plugin: simula exactamente la llamada que hace frps
function Plugin {
  param([string]$Op, $Content)
  $body = @{ version = "0.1.0"; op = $Op; content = $Content } | ConvertTo-Json -Depth 8
  $r = Invoke-WebRequest "$Base/api/frp/plugin?version=0.1.0&op=$Op" -Method POST -Body $body -ContentType "application/json" -UseBasicParsing
  return ($r.Content | ConvertFrom-Json)
}

if ($null -eq (Api POST "/api/login" @{ user = $User; password = $Password })) {
  Write-Host "Login del panel fallido" -ForegroundColor Red; exit 1
}

# Dominio base necesario para crear túneles http con subdominio
Api PUT "/api/settings" @{ subDomainHost = "eds.dev"; vhostHTTPPort = 8080 } | Out-Null

# Dos servidores con token propio
$n1 = (Api POST "/api/nodes" @{ name = "web-$suffix"; mode = "remote" }).node
$n2 = (Api POST "/api/nodes" @{ name = "db-$suffix"; mode = "remote" }).node
Write-Host "servidor A             -> $($n1.name) slug=$($n1.slug)"
Write-Host "servidor B             -> $($n2.name) slug=$($n2.slug)"
Write-Host "tokens distintos       -> $($n1.token -ne $n2.token)"

$t1 = (Api POST "/api/tunnels" @{ nodeId = $n1.id; name = "app-$suffix"; type = "http"; localPort = 8080; subdomain = "app$suffix" }).tunnel
$t2 = (Api POST "/api/tunnels" @{ nodeId = $n2.id; name = "sql-$suffix"; type = "tcp"; localPort = 3306; remotePort = 6200 }).tunnel
if ($null -eq $t1 -or $null -eq $t2) {
  Write-Host "No se pudieron crear los túneles de prueba" -ForegroundColor Red; exit 1
}
Write-Host "tuneles de prueba      -> $($t1.name), $($t2.name)"

$loginContent = @{
  version       = "0.71.1"
  hostname      = "srv-$suffix"
  os            = "linux"
  arch          = "amd64"
  user          = ""
  privilege_key = "cualquiera"
  timestamp     = 1761000000
  run_id        = ""
  pool_count    = 5
  client_address = "203.0.113.9:51515"
}

# 1. Login con el token correcto de A
$c = $loginContent.Clone(); $c.metas = @{ auth_token = $n1.token; node = $n1.slug }
$r = Plugin "Login" $c
Write-Host "login token de A       -> reject=$($r.reject) (esperado False)"

# 2. Login con token inventado
$c = $loginContent.Clone(); $c.metas = @{ auth_token = "000000000000000000000000000000000000000000000000" }
$r = Plugin "Login" $c
Write-Host "login token invalido   -> reject=$($r.reject) «$($r.reject_reason)»"

# 3. Login sin token
$c = $loginContent.Clone(); $c.metas = @{}
$r = Plugin "Login" $c
Write-Host "login sin token        -> reject=$($r.reject) «$($r.reject_reason)»"

# 4. Login con token de A pero identificador de B
$c = $loginContent.Clone(); $c.metas = @{ auth_token = $n1.token; node = $n2.slug }
$r = Plugin "Login" $c
Write-Host "token de A como B      -> reject=$($r.reject) (esperado True)"

# 5. NewProxy autorizado (A crea su túnel)
$r = Plugin "NewProxy" @{ user = @{ user = ""; metas = @{ auth_token = $n1.token }; run_id = "r1" }; name = $t1.name; type = "http" }
Write-Host "proxy propio           -> reject=$($r.reject) (esperado False)"

# 6. NewProxy de un túnel ajeno (A intenta crear el de B)
$r = Plugin "NewProxy" @{ user = @{ user = ""; metas = @{ auth_token = $n1.token }; run_id = "r1" }; name = $t2.name; type = "tcp" }
Write-Host "proxy de otro servidor -> reject=$($r.reject) «$($r.reject_reason)»"

# 7. NewProxy inexistente
$r = Plugin "NewProxy" @{ user = @{ user = ""; metas = @{ auth_token = $n1.token }; run_id = "r1" }; name = "no-existe"; type = "http" }
Write-Host "proxy inexistente      -> reject=$($r.reject) «$($r.reject_reason)»"

# 8. Rotación: el token viejo deja de valer
$rotated = (Api POST "/api/nodes/$($n1.id)/token" @{}).node
$c = $loginContent.Clone(); $c.metas = @{ auth_token = $n1.token; node = $n1.slug }
$old = Plugin "Login" $c
$c.metas = @{ auth_token = $rotated.token; node = $rotated.slug }
$new = Plugin "Login" $c
Write-Host "token antiguo tras rotar -> reject=$($old.reject) (esperado True)"
Write-Host "token nuevo tras rotar   -> reject=$($new.reject) (esperado False)"
Write-Host "B sigue funcionando      -> reject=$((Plugin 'Login' ($loginContent.Clone() + @{ metas = @{ auth_token = $n2.token } })).reject) (esperado False)"

# 9. El frpc.toml del servidor lleva su token y el maestro
$toml = (Invoke-WebRequest "$Base/api/nodes/$($n1.id)/frpc.toml" -WebSession $session -UseBasicParsing).Content
$settings = (Api GET "/api/settings" $null).settings
$hasOwn = $toml -match [regex]::Escape($rotated.token)
$hasSlug = $toml -match "metadatas.node = `"$($rotated.slug)`""
$hasMaster = $toml -match [regex]::Escape($settings.authToken)
Write-Host "frpc.toml              -> token_propio=$hasOwn slug=$hasSlug token_maestro=$hasMaster"

# 10. frps.toml declara el plugin
$frps = (Invoke-WebRequest "$Base/api/server/frps.toml" -WebSession $session -UseBasicParsing).Content
$hasPlugin = $frps -match '\[\[httpPlugins\]\]' -and $frps -match '/api/frp/plugin' -and $frps -match 'Login'
Write-Host "frps.toml con plugin   -> $hasPlugin"

# Limpieza
Api DELETE "/api/tunnels/$($t1.id)" $null | Out-Null
Api DELETE "/api/tunnels/$($t2.id)" $null | Out-Null
Api DELETE "/api/nodes/$($n1.id)" $null | Out-Null
Api DELETE "/api/nodes/$($n2.id)" $null | Out-Null
Write-Host "limpieza               -> ok"
