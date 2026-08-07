param(
    [Parameter(Mandatory = $true)]
    [string]$Tool,

    [string]$ArgsJson = '{}'
)

# qqmcp (QQ-MCP-Server) Streamable HTTP 客户端
$ErrorActionPreference = 'Stop'
$endpoint = 'http://127.0.0.1:8888/mcp'

# 命令行传 JSON 会丢失引号；优先从环境变量 QQMCP_ARGS_JSON 读取
if ($ArgsJson -eq '{}' -and $env:QQMCP_ARGS_JSON) {
    $ArgsJson = $env:QQMCP_ARGS_JSON
}

# 从 ~/.codex/config.toml 读取 MCP token（不打印）
$authHeader = $null
$configPath = Join-Path $env:USERPROFILE '.codex\config.toml'
if (Test-Path $configPath) {
    $m = Select-String -Path $configPath -Pattern 'http_headers\s*=\s*\{\s*Authorization\s*=\s*"Bearer\s+([^"]+)"' | Select-Object -First 1
    if ($m -and $m.Matches[0].Groups[1].Value) {
        $authHeader = 'Bearer ' + $m.Matches[0].Groups[1].Value
    }
}

function Invoke-JsonRpc {
    param(
        [string]$Body,
        [string]$SessionId = $null
    )
    $headers = @{
        'Accept'       = 'application/json, text/event-stream'
        'Content-Type' = 'application/json; charset=utf-8'
    }
    if ($authHeader) { $headers['Authorization'] = $authHeader }
    if ($SessionId) { $headers['Mcp-Session-Id'] = $SessionId }
    $resp = Invoke-WebRequest -Uri $endpoint -Method Post `
        -Headers $headers -Body $Body -UseBasicParsing
    $text = $resp.Content
    $sid = $null
    if ($resp.Headers['Mcp-Session-Id']) { $sid = $resp.Headers['Mcp-Session-Id'] }
    return ,@{ text = $text; sessionId = $sid }
}

# 1. initialize
$initBody = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"codex-test","version":"1.0"}}}'
$initResp = Invoke-JsonRpc -Body $initBody
$sessionId = $initResp.sessionId

# 2. notifications/initialized
if ($sessionId) {
    $null = Invoke-JsonRpc -Body '{"jsonrpc":"2.0","method":"notifications/initialized"}' -SessionId $sessionId
}

# 3. tools/call
$callBody = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"' + $Tool + '","arguments":' + $ArgsJson + '}}'
$result = Invoke-JsonRpc -Body $callBody -SessionId $sessionId

# 输出结构化结果（便于上层断言）：优先取 SSE data 中 result.content[].text
$outText = $result.text
foreach ($line in ($result.text -split "`n")) {
    if ($line -like 'data:*') {
        $dataJson = $line.Substring(5).Trim()
        try {
            $parsed = $dataJson | ConvertFrom-Json
            if ($parsed.result.content) {
                foreach ($c in $parsed.result.content) {
                    if ($c.text) { $outText = $c.text; break }
                }
            }
        } catch { }
    }
}
$outText | Write-Output
