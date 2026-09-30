#!/usr/bin/env node
import { spawn } from 'node:child_process'

export const DEFAULT_OBSERVER_ENDPOINT = 'http://127.0.0.1:33333/api/anthropic'
export const REQUIRED_OBSERVER_PORT = 33333
export const FORBIDDEN_LOCAL_PORT = 23333
export const ROUTING_FIDELITY_VERIFIED = 'ROUTING_FIDELITY_VERIFIED'
export const ROUTING_FIDELITY_FAILED = 'ROUTING_FIDELITY_FAILED'
export const ROUTING_EVIDENCE_UNAVAILABLE = 'ROUTING_EVIDENCE_UNAVAILABLE'

function asArray(value) {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

function finiteInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : null
}

export function normalizeObserverEndpoint(value = DEFAULT_OBSERVER_ENDPOINT) {
  let parsed
  try {
    parsed = new URL(String(value))
  } catch {
    throw new Error(`Invalid observer endpoint URL: ${value}`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Observer endpoint must use http or https: ${value}`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('Observer endpoint must not contain credentials')
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Observer endpoint must not contain a query string or fragment')
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/'
  return parsed.toString().replace(/\/$/, parsed.pathname === '/' ? '/' : '')
}

export function isLoopbackAddress(value) {
  let address = String(value || '').trim().toLowerCase()
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
  address = address.split('%', 1)[0]
  if (address === '::1' || address === '0:0:0:0:0:0:0:1' || address === 'localhost') return true
  if (address.startsWith('::ffff:')) address = address.slice('::ffff:'.length)
  const octets = address.split('.').map(Number)
  return octets.length === 4 && octets.every(Number.isInteger) && octets[0] === 127
}

function normalizeProcess(value) {
  return {
    pid: finiteInteger(value?.pid ?? value?.processId),
    parentPid: finiteInteger(value?.parentPid ?? value?.parentProcessId),
    name: value?.name === undefined ? null : String(value.name),
  }
}

function normalizeConnection(value) {
  return {
    owningPid: finiteInteger(value?.owningPid ?? value?.pid),
    localAddress: String(value?.localAddress || ''),
    localPort: finiteInteger(value?.localPort),
    remoteAddress: String(value?.remoteAddress || ''),
    remotePort: finiteInteger(value?.remotePort),
    state: value?.state === undefined ? null : String(value.state),
    provider: value?.provider === undefined ? null : String(value.provider),
  }
}

function connectionKey(connection) {
  return [
    connection.owningPid,
    connection.localAddress,
    connection.localPort,
    connection.remoteAddress,
    connection.remotePort,
    connection.state,
    connection.provider,
  ].join('|')
}

function targetsLocalPort(connection, port) {
  return connection.remotePort === port && isLoopbackAddress(connection.remoteAddress)
}

export function assessRoutingFidelity({
  requestedEndpoint,
  rootPid,
  events = [],
  requiredPort = REQUIRED_OBSERVER_PORT,
  forbiddenPort = FORBIDDEN_LOCAL_PORT,
  dryRun = false,
} = {}) {
  const normalizedEndpoint = normalizeObserverEndpoint(requestedEndpoint || DEFAULT_OBSERVER_ENDPOINT)
  if (dryRun) {
    return {
      schemaVersion: 1,
      status: 'NOT_RUN_DRY_RUN',
      validForRoutedExperiment: false,
      invalidReason: 'The child process was not launched, so TCP routing evidence does not exist.',
      requestedEndpoint: normalizedEndpoint,
      requiredLocalPort: requiredPort,
      forbiddenLocalPort: forbiddenPort,
      rootPid: rootPid ?? null,
      evidence: {
        availability: 'not-collected',
        artifact: '01-live-stream/network-connections.jsonl',
        successfulSamples: 0,
        processTree: [],
        connections: [],
      },
    }
  }

  const samples = events.filter(event => event?.type === 'tcp-sample')
  const blockingEvents = events.filter(event =>
    ['monitor-unavailable', 'monitor-error', 'monitor-readiness-timeout', 'tcp-sample-error'].includes(event?.type) ||
    (event?.type === 'monitor-exit' && event.expected !== true),
  )
  const completed = events.some(event => event?.type === 'monitor-stop' && event.completed === true)
  const processByPid = new Map()
  const connectionByKey = new Map()
  let rootObserved = false

  for (const sample of samples) {
    for (const rawProcess of asArray(sample.processes)) {
      const process = normalizeProcess(rawProcess)
      if (process.pid === null) continue
      if (process.pid === Number(rootPid)) rootObserved = true
      if (!processByPid.has(process.pid)) processByPid.set(process.pid, process)
    }
    for (const rawConnection of asArray(sample.connections)) {
      const connection = normalizeConnection(rawConnection)
      if (connection.owningPid === null) continue
      const key = connectionKey(connection)
      const existing = connectionByKey.get(key)
      if (existing) {
        existing.observations += 1
        existing.lastObservedAt = sample.timestamp || existing.lastObservedAt
      } else {
        connectionByKey.set(key, {
          ...connection,
          observations: 1,
          firstObservedAt: sample.timestamp || null,
          lastObservedAt: sample.timestamp || null,
        })
      }
    }
  }

  const processTree = [...processByPid.values()].sort((a, b) => a.pid - b.pid)
  const connections = [...connectionByKey.values()].sort((a, b) => connectionKey(a).localeCompare(connectionKey(b)))
  const requiredConnections = connections.filter(connection => targetsLocalPort(connection, requiredPort))
  const forbiddenConnections = connections.filter(connection => targetsLocalPort(connection, forbiddenPort))
  const samplesComplete = samples.length > 0 && samples.every(
    sample => sample.processTreeComplete === true && sample.tcpTableComplete === true,
  )
  const processTreePids = new Set(processByPid.keys())
  const connectionOwnershipComplete = connections.every(connection => processTreePids.has(connection.owningPid))
  const evidenceAvailable =
    completed &&
    rootObserved &&
    samplesComplete &&
    connectionOwnershipComplete &&
    blockingEvents.length === 0

  let status
  let invalidReason = null
  if (forbiddenConnections.length > 0) {
    status = ROUTING_FIDELITY_FAILED
    invalidReason = `Observed the Claude Code process tree connecting to forbidden local port ${forbiddenPort}.`
  } else if (!evidenceAvailable) {
    status = ROUTING_EVIDENCE_UNAVAILABLE
    invalidReason = 'Complete process-tree TCP evidence was unavailable; routing fidelity cannot be claimed.'
  } else if (requiredConnections.length === 0) {
    status = ROUTING_FIDELITY_FAILED
    invalidReason = `No Claude Code process-tree connection to required local port ${requiredPort} was observed.`
  } else {
    status = ROUTING_FIDELITY_VERIFIED
  }

  return {
    schemaVersion: 1,
    status,
    validForRoutedExperiment: status === ROUTING_FIDELITY_VERIFIED,
    invalidReason,
    requestedEndpoint: normalizedEndpoint,
    requiredLocalPort: requiredPort,
    forbiddenLocalPort: forbiddenPort,
    rootPid: finiteInteger(rootPid),
    evidence: {
      availability: evidenceAvailable ? 'available' : 'unavailable',
      artifact: '01-live-stream/network-connections.jsonl',
      successfulSamples: samples.length,
      monitorCompleted: completed,
      rootProcessObserved: rootObserved,
      connectionOwnershipComplete,
      blockingEvents: blockingEvents.map(event => ({
        type: event.type,
        timestamp: event.timestamp || null,
        reason: event.reason || event.error || null,
      })),
      processTree,
      connections,
      requiredConnections,
      forbiddenConnections,
    },
  }
}

function powershellMonitorScript(rootPid, pollIntervalMs) {
  return String.raw`
$ErrorActionPreference = 'Stop'
$RootPid = ${Number(rootPid)}
$PollIntervalMs = ${Number(pollIntervalMs)}
$Sequence = 0

function Write-Evidence($Value) {
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}

function Split-NetstatEndpoint([string]$Value) {
  $Text = $Value.Trim()
  $Separator = $Text.LastIndexOf(':')
  if ($Separator -lt 0) {
    return [pscustomobject]@{ address = $Text; port = $null }
  }
  $Address = $Text.Substring(0, $Separator).TrimStart('[').TrimEnd(']')
  $PortText = $Text.Substring($Separator + 1)
  $Port = 0
  if (-not [int]::TryParse($PortText, [ref]$Port)) { $Port = $null }
  return [pscustomobject]@{ address = $Address; port = $Port }
}

while ($true) {
  $Sequence += 1
  $Timestamp = [DateTime]::UtcNow.ToString('o')
  try {
    $TreeProvider = 'Get-CimInstance Win32_Process'
    try {
      $AllProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId, Name)
    } catch {
      $TreeProvider = 'Get-Process parent-id lookup'
      $AllProcesses = @(
        Get-Process -ErrorAction Stop | ForEach-Object {
          $ParentProcessId = 0
          try {
            $ParentProcessId = [int]$_.Parent.Id
          } catch {
            try { $ParentProcessId = [int]$_.ParentProcessId } catch {}
          }
          [pscustomobject]@{
            ProcessId = [int]$_.Id
            ParentProcessId = $ParentProcessId
            Name = [string]$_.ProcessName
          }
        }
      )
    }

    $TreeIds = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$TreeIds.Add([int]$RootPid)
    $Changed = $true
    while ($Changed) {
      $Changed = $false
      foreach ($Process in $AllProcesses) {
        if ($TreeIds.Contains([int]$Process.ParentProcessId) -and $TreeIds.Add([int]$Process.ProcessId)) {
          $Changed = $true
        }
      }
    }

    $Processes = @(
      foreach ($Process in $AllProcesses) {
        if ($TreeIds.Contains([int]$Process.ProcessId)) {
          [pscustomobject]@{
            pid = [int]$Process.ProcessId
            parentPid = [int]$Process.ParentProcessId
            name = [string]$Process.Name
          }
        }
      }
    )

    $TcpProvider = 'Get-NetTCPConnection'
    $TcpFallbackReason = $null
    $Connections = @()
    try {
      $Connections = @(
        Get-NetTCPConnection -ErrorAction Stop |
          Where-Object { $TreeIds.Contains([int]$_.OwningProcess) } |
          ForEach-Object {
            [pscustomobject]@{
              owningPid = [int]$_.OwningProcess
              localAddress = [string]$_.LocalAddress
              localPort = [int]$_.LocalPort
              remoteAddress = [string]$_.RemoteAddress
              remotePort = [int]$_.RemotePort
              state = [string]$_.State
              provider = $TcpProvider
            }
          }
      )
    } catch {
      $TcpFallbackReason = $_.Exception.Message
      $TcpProvider = 'netstat.exe -ano -p tcp'
      $NetstatPath = Join-Path $env:SystemRoot 'System32\netstat.exe'
      $NetstatLines = @(& $NetstatPath -ano -p tcp 2>&1)
      if ($LASTEXITCODE -ne 0) { throw "netstat exited with code $LASTEXITCODE" }
      $Connections = @(
        foreach ($Line in $NetstatLines) {
          $Parts = @($Line.Trim() -split '\s+')
          if ($Parts.Count -lt 5 -or $Parts[0] -ne 'TCP') { continue }
          $OwningPid = 0
          if (-not [int]::TryParse($Parts[$Parts.Count - 1], [ref]$OwningPid)) { continue }
          if (-not $TreeIds.Contains($OwningPid)) { continue }
          $Local = Split-NetstatEndpoint $Parts[1]
          $Remote = Split-NetstatEndpoint $Parts[2]
          [pscustomobject]@{
            owningPid = $OwningPid
            localAddress = $Local.address
            localPort = $Local.port
            remoteAddress = $Remote.address
            remotePort = $Remote.port
            state = $Parts[3]
            provider = $TcpProvider
          }
        }
      )
    }

    Write-Evidence ([pscustomobject]@{
      type = 'tcp-sample'
      timestamp = $Timestamp
      sequence = $Sequence
      processTreeComplete = $true
      tcpTableComplete = $true
      processTreeProvider = $TreeProvider
      tcpProvider = $TcpProvider
      tcpFallbackReason = $TcpFallbackReason
      processes = @($Processes)
      connections = @($Connections)
    })
  } catch {
    Write-Evidence ([pscustomobject]@{
      type = 'tcp-sample-error'
      timestamp = $Timestamp
      sequence = $Sequence
      error = $_.Exception.ToString()
      processTreeComplete = $false
      tcpTableComplete = $false
    })
  }
  Start-Sleep -Milliseconds $PollIntervalMs
}
`
}

export function createProcessTreeTcpMonitor({
  rootPid,
  onObservation,
  pollIntervalMs = 250,
  platform = process.platform,
  spawnProcess = spawn,
} = {}) {
  if (typeof onObservation !== 'function') throw new Error('onObservation callback is required')
  const emit = event => onObservation({ timestamp: new Date().toISOString(), ...event })

  if (platform !== 'win32') {
    emit({
      type: 'monitor-unavailable',
      reason: `Windows process-tree TCP monitoring is unavailable on platform ${platform}.`,
    })
    return {
      ready: Promise.resolve(),
      async stop() {},
    }
  }

  const encodedScript = Buffer.from(
    powershellMonitorScript(rootPid, Math.max(50, Number(pollIntervalMs) || 250)),
    'utf16le',
  ).toString('base64')
  const monitor = spawnProcess(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedScript],
    { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stopping = false
  let closed = false
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let readySettled = false
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const settleReady = (error = null) => {
    if (readySettled) return
    readySettled = true
    if (error) rejectReady(error)
    else resolveReady()
  }
  let resolveClosed
  const closedPromise = new Promise(resolve => { resolveClosed = resolve })

  monitor.stdout.setEncoding('utf8')
  monitor.stdout.on('data', chunk => {
    stdoutBuffer += chunk
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        emit(event)
        if (event.type === 'tcp-sample' || event.type === 'tcp-sample-error') settleReady()
      } catch (error) {
        emit({ type: 'tcp-sample-error', error: `Invalid monitor JSON: ${error}`, raw: line })
        settleReady()
      }
    }
  })
  monitor.stderr.setEncoding('utf8')
  monitor.stderr.on('data', chunk => { stderrBuffer += chunk })
  monitor.once('error', error => {
    emit({ type: 'monitor-error', error: String(error) })
    settleReady(error)
  })
  monitor.once('close', (code, signal) => {
    closed = true
    if (stdoutBuffer.trim()) {
      try {
        emit(JSON.parse(stdoutBuffer))
      } catch (error) {
        emit({ type: 'tcp-sample-error', error: `Invalid trailing monitor JSON: ${error}`, raw: stdoutBuffer })
      }
    }
    emit({
      type: 'monitor-exit',
      expected: stopping,
      code,
      signal,
      stderr: stderrBuffer.trim() || null,
    })
    if (!stopping) settleReady(new Error(`TCP monitor exited before stop (code=${code}, signal=${signal})`))
    else settleReady()
    resolveClosed({ code, signal })
  })

  return {
    ready,
    async stop() {
      if (closed) return
      stopping = true
      monitor.kill()
      const result = await Promise.race([
        closedPromise.then(() => 'closed'),
        new Promise(resolve => setTimeout(() => resolve('timeout'), 3000)),
      ])
      if (result === 'timeout' && monitor.pid) {
        emit({ type: 'monitor-error', error: 'TCP monitor did not stop within 3000 ms.' })
        const killer = spawnProcess('taskkill.exe', ['/PID', String(monitor.pid), '/T', '/F'], {
          windowsHide: true,
          shell: false,
          stdio: 'ignore',
        })
        await new Promise(resolve => killer.once('close', resolve))
        await Promise.race([
          closedPromise,
          new Promise(resolve => setTimeout(resolve, 1000)),
        ])
      }
    },
  }
}
