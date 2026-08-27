param(
    [Parameter(Mandatory=$false)]
    [string]$Action = "now_playing",

    [Parameter(Mandatory=$false)]
    [string]$TargetApp = ""
)

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
} catch {
    $errObj = @{
        ok = $false
        error = "Windows GSMTC is unsupported or unavailable on this platform."
    }
    ConvertTo-Json -InputObject $errObj
    exit 0
}

$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { 
    $_.Name -eq 'AsTask' -and 
    $_.GetParameters().Count -eq 1 -and 
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' 
} | Select-Object -First 1

function Invoke-AsyncOp($asyncOp, $type, $timeoutMs = 3000) {
    if (-not $asyncOp) { return $null }
    try {
        $method = $asTaskGeneric.MakeGenericMethod($type)
        $task = $method.Invoke($null, @($asyncOp))
        $task.Wait($timeoutMs) | Out-Null
        return $task.Result
    } catch {
        return $null
    }
}

function Get-MediaManager() {
    try {
        $asyncOp = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
        return Invoke-AsyncOp $asyncOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) 3000
    } catch {
        return $null
    }
}

function Find-MediaSession($manager, $appFilter) {
    if (-not $manager) { return $null }
    try {
        $sessions = $manager.GetSessions()
        if (-not $sessions -or $sessions.Count -eq 0) { return $null }

        if ($appFilter -and $appFilter.Trim() -ne "") {
            $filter = $appFilter.Trim().ToLower()
            foreach ($s in $sessions) {
                $id = ($s.SourceAppUserModelId + "").ToLower()
                if ($id.Contains($filter)) {
                    return $s
                }
            }
            return $null
        }

        $curr = $manager.GetCurrentSession()
        if ($curr) { return $curr }

        # Find one that is currently playing
        foreach ($s in $sessions) {
            $pb = $s.GetPlaybackInfo()
            if ($pb -and $pb.PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing) {
                return $s
            }
        }

        return $sessions[0]
    } catch {
        return $null
    }
}

function Format-App-DisplayName($appId) {
    if (-not $appId) { return "Unknown" }
    $id = $appId.ToLower()
    if ($id.Contains("spotify")) { return "Spotify" }
    if ($id.Contains("chrome")) { return "Google Chrome" }
    if ($id.Contains("msedge") -or $id.Contains("edge")) { return "Microsoft Edge" }
    if ($id.Contains("firefox")) { return "Firefox" }
    if ($id.Contains("vlc")) { return "VLC Media Player" }
    if ($id.Contains("brave")) { return "Brave Browser" }
    if ($id.Contains("itunes") -or $id.Contains("apple")) { return "Apple Music" }
    return $appId.Split("!")[0]
}

function Test-SpotifyProcessRunning() {
    $p = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Select-Object -First 1
    return ($null -ne $p)
}

function Start-Spotify-App() {
    try {
        Start-Process "spotify:" -ErrorAction SilentlyContinue
    } catch {
        try {
            Start-Process "shell:AppsFolder\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" -ErrorAction SilentlyContinue
        } catch {
            Start-Process "Spotify.exe" -ErrorAction SilentlyContinue
        }
    }
}

function Send-FastMediaKey([string]$keyAction = "play") {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $fastKeysPath = Join-Path (Split-Path -Parent $scriptDir) "bin\FastKeys.exe"
    if (Test-Path $fastKeysPath) {
        try {
            & $fastKeysPath $keyAction "1" | Out-Null
            return $true
        } catch {}
    }
    try {
        $wshell = New-Object -ComObject WScript.Shell
        $wshell.SendKeys([char]179)
        return $true
    } catch {}
    return $false
}

$manager = Get-MediaManager
if (-not $manager) {
    $res = @{
        ok = $false
        error = "Failed to initialize Windows GSMTC Session Manager."
    }
    ConvertTo-Json -InputObject $res
    exit 0
}

$act = $Action.ToLower().Trim()

if ($act -eq "get_sessions" -or $act -eq "sessions" -or $act -eq "list") {
    $sessions = $manager.GetSessions()
    $list = @()
    if ($sessions) {
        foreach ($s in $sessions) {
            $appId = $s.SourceAppUserModelId
            $props = $null
            try {
                $pOp = $s.TryGetMediaPropertiesAsync()
                $props = Invoke-AsyncOp $pOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) 1500
            } catch {}
            $pb = $s.GetPlaybackInfo()
            $list += @{
                appId = $appId
                source = Format-App-DisplayName $appId
                title = if ($props) { $props.Title } else { "" }
                artist = if ($props) { $props.Artist } else { "" }
                album = if ($props) { $props.AlbumTitle } else { "" }
                status = if ($pb) { $pb.PlaybackStatus.ToString() } else { "Unknown" }
            }
        }
    }
    $curr = $manager.GetCurrentSession()
    $currApp = if ($curr) { $curr.SourceAppUserModelId } else { $null }
    ConvertTo-Json -Depth 3 -InputObject @{
        ok = $true
        current = $currApp
        sessions = $list
    }
    exit 0
}

$session = Find-MediaSession $manager $TargetApp

# If Play / Resume was requested and no session exists, or if Spotify was specifically requested
$isPlayAction = ($act -in "play", "resume", "start", "toggle", "play_pause", "toggle_play_pause")
$targetIsSpotify = ($TargetApp -and $TargetApp.ToLower().Contains("spotify")) -or (-not $TargetApp -and -not $session)

if ($isPlayAction -and (-not $session -or ($targetIsSpotify -and -not (Format-App-DisplayName $session.SourceAppUserModelId).ToLower().Contains("spotify")))) {
    # If Spotify process isn't running, launch it
    if (-not (Test-SpotifyProcessRunning)) {
        Start-Spotify-App
        Start-Sleep -Milliseconds 800
    }

    # Warm-up polling loop: wait for Spotify to register its GSMTC session (up to ~5.5s)
    $maxAttempts = 16
    for ($i = 0; $i -lt $maxAttempts; $i++) {
        Start-Sleep -Milliseconds 350
        $manager = Get-MediaManager
        if ($manager) {
            $session = Find-MediaSession $manager "Spotify"
            if ($session) {
                # Found Spotify session!
                break
            }
        }
    }

    # If session appeared, attempt to start playback
    if ($session) {
        try {
            $op = $session.TryPlayAsync()
            $success = Invoke-AsyncOp $op ([System.Boolean]) 1500
        } catch {}
        
        Start-Sleep -Milliseconds 400
        $props = $null
        try {
            $pOp = $session.TryGetMediaPropertiesAsync()
            $props = Invoke-AsyncOp $pOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) 1500
        } catch {}

        # If GSMTC didn't have active metadata yet, send hardware Media Play key to kickstart Spotify
        if (-not $props -or -not $props.Title) {
            Send-FastMediaKey "play"
            Start-Sleep -Milliseconds 500
            try {
                $pOp = $session.TryGetMediaPropertiesAsync()
                $props = Invoke-AsyncOp $pOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) 1500
            } catch {}
        }

        $pb = $session.GetPlaybackInfo()
        ConvertTo-Json -Depth 3 -InputObject @{
            ok = $true
            action = "Play"
            source = "Spotify"
            appId = $session.SourceAppUserModelId
            title = if ($props) { $props.Title } else { "" }
            artist = if ($props) { $props.Artist } else { "" }
            album = if ($props) { $props.AlbumTitle } else { "" }
            playback_state = if ($pb) { $pb.PlaybackStatus.ToString() } else { "Playing" }
        }
        exit 0
    } else {
        # Spotify is running but GSMTC hasn't attached yet; send global media key
        if (Test-SpotifyProcessRunning) {
            Send-FastMediaKey "play"
            ConvertTo-Json -Depth 3 -InputObject @{
                ok = $true
                action = "Play"
                source = "Spotify"
                appId = "Spotify"
                title = ""
                artist = ""
                album = ""
                playback_state = "Playing"
                detail = "Spotify launched and playback initiated."
            }
            exit 0
        }
    }
}

# If now_playing / status was requested and session is not ready yet, check if Spotify is warming up
$isQueryAction = ($act -in "now_playing", "get_now_playing", "status", "get_status", "track")
if ($isQueryAction -and -not $session -and ($targetIsSpotify -or (Test-SpotifyProcessRunning))) {
    # Give Spotify up to 3 seconds to register session
    for ($i = 0; $i -lt 8; $i++) {
        Start-Sleep -Milliseconds 350
        $manager = Get-MediaManager
        if ($manager) {
            $session = Find-MediaSession $manager "Spotify"
            if ($session) { break }
        }
    }
}

if (-not $session) {
    if ((Test-SpotifyProcessRunning) -and ($targetIsSpotify -or $act -eq "now_playing" -or $act -eq "status")) {
        # Spotify is running in ready/idle state
        ConvertTo-Json -InputObject @{
            ok = $true
            source = "Spotify"
            appId = "Spotify"
            title = ""
            artist = ""
            album = ""
            playback_state = "Ready"
            is_ready = $true
        }
        exit 0
    }

    $errMsg = if ($TargetApp -and $TargetApp.Trim() -ne "") {
        "$TargetApp is not running or has no active media session."
    } else {
        "No active Windows media session found."
    }
    ConvertTo-Json -InputObject @{
        ok = $false
        error = $errMsg
        source = $TargetApp
    }
    exit 0
}

$appId = $session.SourceAppUserModelId
$sourceName = Format-App-DisplayName $appId

if ($act -eq "now_playing" -or $act -eq "get_now_playing" -or $act -eq "status" -or $act -eq "get_status" -or $act -eq "track") {
    $props = $null
    try {
        $pOp = $session.TryGetMediaPropertiesAsync()
        $props = Invoke-AsyncOp $pOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) 1500
    } catch {}
    
    $pb = $session.GetPlaybackInfo()
    $tl = $session.GetTimelineProperties()
    
    $statusStr = if ($pb) { $pb.PlaybackStatus.ToString() } else { "Unknown" }
    $posMs = if ($tl) { [math]::Round($tl.Position.TotalMilliseconds) } else { 0 }
    $durMs = if ($tl) { [math]::Round($tl.EndTime.TotalMilliseconds) } else { 0 }
    
    $ctrls = if ($pb) { $pb.Controls } else { $null }
    
    $res = @{
        ok = $true
        appId = $appId
        source = $sourceName
        title = if ($props) { $props.Title } else { "" }
        artist = if ($props) { $props.Artist } else { "" }
        album = if ($props) { $props.AlbumTitle } else { "" }
        genres = if ($props -and $props.Genres) { $props.Genres -join ", " } else { "" }
        playback_state = $statusStr
        position_ms = $posMs
        duration_ms = $durMs
        can_play = if ($ctrls) { [bool]$ctrls.IsPlayEnabled } else { $true }
        can_pause = if ($ctrls) { [bool]$ctrls.IsPauseEnabled } else { $true }
        can_next = if ($ctrls) { [bool]$ctrls.IsNextEnabled } else { $true }
        can_previous = if ($ctrls) { [bool]$ctrls.IsPreviousEnabled } else { $true }
        can_toggle = if ($ctrls) { [bool]$ctrls.IsPlayPauseToggleEnabled } else { $true }
    }
    ConvertTo-Json -Depth 3 -InputObject $res
    exit 0
}

# Control commands
$success = $false
$opName = ""

switch ($act) {
    { $_ -in "play", "resume", "start" } {
        $opName = "Play"
        $op = $session.TryPlayAsync()
        $success = Invoke-AsyncOp $op ([System.Boolean]) 1500
        if (-not $success) {
            # Fallback to media key
            Send-FastMediaKey "play" | Out-Null
            $success = $true
        }
    }
    { $_ -in "pause", "stop" } {
        $opName = "Pause"
        $op = $session.TryPauseAsync()
        $success = Invoke-AsyncOp $op ([System.Boolean]) 1500
        if (-not $success) {
            Send-FastMediaKey "play" | Out-Null
            $success = $true
        }
    }
    { $_ -in "toggle", "play_pause", "toggle_play_pause" } {
        $opName = "TogglePlayPause"
        $op = $session.TryTogglePlayPauseAsync()
        $success = Invoke-AsyncOp $op ([System.Boolean]) 1500
        if (-not $success) {
            Send-FastMediaKey "play" | Out-Null
            $success = $true
        }
    }
    { $_ -in "next", "skip", "next_track", "skip_track" } {
        $opName = "SkipNext"
        $op = $session.TrySkipNextAsync()
        $success = Invoke-AsyncOp $op ([System.Boolean]) 1500
        if (-not $success) {
            Send-FastMediaKey "forward10" | Out-Null
        }
    }
    { $_ -in "previous", "prev", "back", "previous_track" } {
        $opName = "SkipPrevious"
        $op = $session.TrySkipPreviousAsync()
        $success = Invoke-AsyncOp $op ([System.Boolean]) 1500
        if (-not $success) {
            Send-FastMediaKey "rewind10" | Out-Null
        }
    }
    default {
        ConvertTo-Json -InputObject @{
            ok = $false
            error = "Unsupported media action: '$Action'"
        }
        exit 0
    }
}

# Fetch updated track info after action
Start-Sleep -Milliseconds 250
$props = $null
try {
    $pOp = $session.TryGetMediaPropertiesAsync()
    $props = Invoke-AsyncOp $pOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) 1500
} catch {}
$pb = $session.GetPlaybackInfo()

ConvertTo-Json -Depth 3 -InputObject @{
    ok = [bool]$success
    action = $opName
    source = $sourceName
    appId = $appId
    title = if ($props) { $props.Title } else { "" }
    artist = if ($props) { $props.Artist } else { "" }
    album = if ($props) { $props.AlbumTitle } else { "" }
    playback_state = if ($pb) { $pb.PlaybackStatus.ToString() } else { "Unknown" }
}
