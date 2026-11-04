# setup-pc.ps1: installs the antics PC helper, so your antics videos are made on this PC's
# NVIDIA graphics card for free and without limits.
#
# Run it from PowerShell with the line shown on the antics "Use my PC" page. It is safe to run
# again: it skips what is already done and continues downloads where they stopped.
# Everything goes into one "antics" folder; delete that folder to remove it all.

function Write-Step([string]$text) {
    Write-Host ''
    Write-Host "== $text" -ForegroundColor Yellow
}

function Invoke-Native([string]$exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { throw "This step failed: $([IO.Path]::GetFileName($exe)) $($arguments -join ' ')" }
}

# Downloads a GitHub zip and returns the single folder inside it, moved to $target.
function Get-ZipFolder([string]$url, [string]$target, [string]$work) {
    $zip = Join-Path $work 'download.zip'
    $unpack = Join-Path $work 'unpack'
    Remove-Item $unpack -Recurse -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $unpack -Force
    $inner = Get-ChildItem -Path $unpack -Directory | Select-Object -First 1
    Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -Path $inner.FullName -Destination $target
    Remove-Item $zip, $unpack -Recurse -Force -ErrorAction SilentlyContinue
}

function Install-AnticsHelper {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is very slow with its progress bar
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $base = 'https://raw.githubusercontent.com/tendha2020-ai/account-shop/main/animals/pc'
    if ($antics) { $base = $antics.TrimEnd('/') }
    $comfyVersion = '0.41.0'
    $ggufCommit = '6ea2651e7df66d7585f6ffee804b20e92fb38b8a'
    $uvVersion = '0.13.0'
    $torchIndex = 'https://download.pytorch.org/whl/cu130'
    $hf = 'https://huggingface.co'
    # Wan 2.2 14B image-to-video squeezed for 8 GB cards, its 4-step Lightning LoRAs, text encoder and VAE.
    $models = @(
        @{ Folder = 'unet'; Name = 'Wan2.2-I2V-A14B-HighNoise-Q3_K_M.gguf'; Size = 7176106496
           Url = "$hf/QuantStack/Wan2.2-I2V-A14B-GGUF/resolve/main/HighNoise/Wan2.2-I2V-A14B-HighNoise-Q3_K_M.gguf" },
        @{ Folder = 'unet'; Name = 'Wan2.2-I2V-A14B-LowNoise-Q3_K_M.gguf'; Size = 7176106496
           Url = "$hf/QuantStack/Wan2.2-I2V-A14B-GGUF/resolve/main/LowNoise/Wan2.2-I2V-A14B-LowNoise-Q3_K_M.gguf" },
        @{ Folder = 'text_encoders'; Name = 'umt5-xxl-encoder-Q4_K_M.gguf'; Size = 3655145312
           Url = "$hf/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q4_K_M.gguf" },
        @{ Folder = 'loras'; Name = 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors'; Size = 1226977424
           Url = "$hf/Comfy-Org/Wan-2.2/resolve/main/split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors" },
        @{ Folder = 'loras'; Name = 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors'; Size = 1226977424
           Url = "$hf/Comfy-Org/Wan-2.2/resolve/main/split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors" },
        @{ Folder = 'vae'; Name = 'wan_2.1_vae.safetensors'; Size = 253815318
           Url = "$hf/Comfy-Org/Wan-2.2/resolve/main/split_files/vae/wan_2.1_vae.safetensors" }
    )

    Write-Host ''
    Write-Host 'antics PC setup' -ForegroundColor Cyan
    Write-Host 'This downloads about 25 GB and takes 30-60 minutes. You can use your PC meanwhile.'

    Write-Step 'Checking your graphics card'
    $gpu = $null
    try { $gpu = & nvidia-smi --query-gpu=name,memory.total --format=csv,noheader } catch { }
    if (-not $gpu) { throw 'No NVIDIA graphics card (or its driver) was found. antics needs an NVIDIA card.' }
    Write-Host "   $gpu"

    Write-Step 'Choosing a folder'
    $root = Join-Path $env:USERPROFILE 'antics'
    $need = 32GB
    if (-not (Test-Path $root)) {
        $drive = Get-PSDrive -Name $root.Substring(0, 1)
        if ($drive.Free -lt $need) {
            $other = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -gt $need } | Select-Object -First 1
            if (-not $other) { throw 'antics needs about 32 GB of free disk space. Free some space and run this again.' }
            $root = Join-Path $other.Root 'antics'
        }
    }
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Write-Host "   $root"

    Write-Step 'Getting Python'
    $tools = Join-Path $root 'tools'
    $uv = Join-Path $tools 'uv.exe'
    if (-not (Test-Path $uv)) {
        New-Item -ItemType Directory -Force -Path $tools | Out-Null
        $zip = Join-Path $root 'uv.zip'
        Invoke-WebRequest -Uri "https://github.com/astral-sh/uv/releases/download/$uvVersion/uv-x86_64-pc-windows-msvc.zip" -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath $tools -Force
        Remove-Item $zip
    }
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $root 'python'
    $env:UV_CACHE_DIR = Join-Path $root 'cache'
    $env:UV_LINK_MODE = 'copy'
    $venv = Join-Path $root 'venv'
    $py = Join-Path $venv 'Scripts\python.exe'
    if (-not (Test-Path $py)) {
        Invoke-Native $uv @('python', 'install', '3.12')
        Invoke-Native $uv @('venv', '--python', '3.12', $venv)
    }

    Write-Step 'Getting ComfyUI'
    $comfy = Join-Path $root 'ComfyUI'
    if (-not (Test-Path (Join-Path $comfy 'main.py'))) {
        Get-ZipFolder "https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v$comfyVersion.zip" $comfy $root
    }
    $gguf = Join-Path $comfy 'custom_nodes\ComfyUI-GGUF'
    if (-not (Test-Path (Join-Path $gguf 'nodes.py'))) {
        Get-ZipFolder "https://github.com/city96/ComfyUI-GGUF/archive/$ggufCommit.zip" $gguf $root
    }

    Write-Step 'Installing the AI software for your graphics card (about 4 GB)'
    Invoke-Native $uv @('pip', 'install', '--python', $py, 'torch', 'torchvision', '--index-url', $torchIndex)
    Invoke-Native $uv @('pip', 'install', '--python', $py, '-r', (Join-Path $comfy 'requirements.txt'),
                        '-r', (Join-Path $gguf 'requirements.txt'))
    # Single quotes only: Windows PowerShell mangles double quotes passed to other programs.
    Invoke-Native $py @('-c', 'import torch; assert torch.cuda.is_available(), ''no CUDA''; print(''   graphics card ready:'', torch.cuda.get_device_name(0))')

    Write-Step 'Downloading the video model (about 21 GB, the slow part)'
    foreach ($m in $models) {
        $dir = Join-Path $comfy "models\$($m.Folder)"
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $file = Join-Path $dir $m.Name
        if ((Test-Path $file) -and (Get-Item $file).Length -eq $m.Size) {
            Write-Host "   $($m.Name): already downloaded"
            continue
        }
        if ((Test-Path $file) -and (Get-Item $file).Length -gt $m.Size) { Remove-Item $file }
        Write-Host "   $($m.Name) ($([math]::Round($m.Size / 1GB, 1)) GB)"
        & curl.exe -L --fail --retry 10 --retry-delay 5 -C - -o $file $m.Url
        if (-not (Test-Path $file) -or (Get-Item $file).Length -ne $m.Size) {
            throw "The download of $($m.Name) did not finish. Run the same line again; it continues where it stopped."
        }
    }

    Write-Step 'Adding the antics PC helper'
    Invoke-WebRequest -Uri "$base/antics_helper.py" -OutFile (Join-Path $root 'antics_helper.py') -UseBasicParsing
    $cmd = Join-Path $root 'antics PC helper.cmd'
    Set-Content -Path $cmd -Encoding ASCII -Value @(
        '@echo off',
        'title antics PC helper',
        'cd /d "%~dp0"',
        '"%~dp0venv\Scripts\python.exe" "%~dp0antics_helper.py"',
        'pause'
    )
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path $desktop 'antics PC helper.lnk'))
    $link.TargetPath = $cmd
    $link.WorkingDirectory = $root
    $link.Save()
    try { & $uv cache clean | Out-Null } catch { }  # frees the ~4 GB download cache

    Write-Step 'Connecting this PC to your antics worker'
    Invoke-Native $py @((Join-Path $root 'antics_helper.py'), '--pair')

    Write-Host ''
    Write-Host 'All done!' -ForegroundColor Green
    Write-Host 'Double-click "antics PC helper" on your Desktop whenever you want this PC to make your videos.'
    $answer = Read-Host 'Start it now? (Y/n)'
    if ($answer -notmatch '^[nN]') { Start-Process -FilePath $cmd -WorkingDirectory $root }
}

try {
    Install-AnticsHelper
} catch {
    Write-Host ''
    Write-Host "Setup stopped: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Fix that and run the same line again. It continues where it stopped.'
}
