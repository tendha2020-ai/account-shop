# setup-pc.ps1: installs the antics PC helper, so your antics videos are made on this PC's
# NVIDIA graphics card for free and without limits.
#
# Run it from PowerShell with the line shown on the antics "Use my PC" page. It is safe to run
# again: it skips what is already done and continues downloads where they stopped.
# Everything goes into one "antics" folder; delete that folder to remove it all.
#
# (Sing) With 32 GB of RAM or more it also downloads the singing models (about 22.5 GB more, all free:
# Apache-2.0 and MIT) and adds a second Desktop shortcut, "antics sing tonight", which starts the helper with
# singing switched on until 07:30. Singing only runs while that shortcut's window is open.

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

# ---------- (Sing) checks: graphics card, driver, RAM, PyTorch on this card ----------

# One line of "nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits",
# e.g. "NVIDIA GeForce RTX 5060, 8151, 581.57", as an object (or $null when it can't be read).
function ConvertFrom-GpuQuery([string]$line) {
    if (-not $line) { return $null }
    $parts = @($line.Split(',') | ForEach-Object { $_.Trim() })
    if ($parts.Count -lt 3) { return $null }
    $mib = 0
    if (-not [int]::TryParse($parts[1], [ref]$mib)) { return $null }
    return [pscustomobject]@{ Name = $parts[0]; MemoryMiB = $mib; Driver = $parts[2] }
}

function Get-GpuInfo {
    $out = $null
    try { $out = & nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits } catch { }
    if (-not $out) { return $null }
    return ConvertFrom-GpuQuery (@($out)[0])
}

# CUDA 13 PyTorch (needed for RTX 50 "Blackwell" cards) runs only on NVIDIA drivers from the 580 series on.
function Test-DriverVersion([string]$driver, [int]$minimum = 580) {
    $major = 0
    if (-not $driver -or -not [int]::TryParse(($driver.Split('.')[0]), [ref]$major)) { return $false }
    return $major -ge $minimum
}

function Get-RamGB {
    $bytes = 0
    try { $bytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory } catch { }
    return [math]::Round($bytes / 1GB, 1)
}

# The Wan 2.1 base model singing uses, by RAM (Windows shows 32 GB as about 31.9): 32-47 GB -> Q4_K_M,
# 48 GB or more -> Q5_K_M, under 31 GB -> none (no singing on this PC; online singing still works).
function Select-SingBase([double]$ramGB) {
    if ($ramGB -ge 47) { return @{ Q = 'Q5_K_M'; Size = 12743654784 } }
    if ($ramGB -ge 31) { return @{ Q = 'Q4_K_M'; Size = 11341184384 } }
    return $null
}

# The singing model files (exact sizes from the Hugging Face API, 2026-11-03; the helper checks the same sizes).
function Get-SingModels($base, [string]$hf = 'https://huggingface.co') {
    return @(
        # Wan 2.1 image-to-video 14B 480p (InfiniteTalk is trained on it), GGUF by city96. Apache-2.0
        @{ Folder = 'unet'; Name = "wan2.1-i2v-14b-480p-$($base.Q).gguf"; Size = $base.Size; License = 'Apache-2.0'
           Url = "$hf/city96/Wan2.1-I2V-14B-480P-gguf/resolve/main/wan2.1-i2v-14b-480p-$($base.Q).gguf" },
        # InfiniteTalk (MeiGen-AI) as ComfyUI core model patches: single = one singer, multi = duets. Apache-2.0
        @{ Folder = 'model_patches'; Name = 'wan2.1_infiniteTalk_single_fp16.safetensors'; Size = 5125258232; License = 'Apache-2.0'
           Url = "$hf/Comfy-Org/Wan-2.1/resolve/main/split_files/model_patches/wan2.1_infiniteTalk_single_fp16.safetensors" },
        @{ Folder = 'model_patches'; Name = 'wan2.1_infiniteTalk_multi_fp16.safetensors'; Size = 5124439112; License = 'Apache-2.0'
           Url = "$hf/Comfy-Org/Wan-2.1/resolve/main/split_files/model_patches/wan2.1_infiniteTalk_multi_fp16.safetensors" },
        # lightx2v's own step/CFG distill LoRA for Wan 2.1 I2V 480p: 6 steps at cfg 1 instead of 40 with CFG. Apache-2.0
        @{ Folder = 'loras'; Name = 'Wan21_I2V_14B_lightx2v_cfg_step_distill_lora_rank64.safetensors'; Size = 739472104; License = 'Apache-2.0'
           Url = "$hf/lightx2v/Wan2.1-I2V-14B-480P-StepDistill-CfgDistill-Lightx2v/resolve/main/loras/Wan21_I2V_14B_lightx2v_cfg_step_distill_lora_rank64.safetensors" },
        # chinese-wav2vec2-base (TencentGameMate), the audio encoder InfiniteTalk was trained with, as one file. MIT
        @{ Folder = 'audio_encoders'; Name = 'wav2vec2-chinese-base_fp16.safetensors'; Size = 190115368; License = 'MIT'
           Url = "$hf/Kijai/wav2vec2_safetensors/resolve/main/wav2vec2-chinese-base_fp16.safetensors" }
    )
    # Reused from the normal setup: text_encoders/umt5-xxl-encoder-Q4_K_M.gguf and vae/wan_2.1_vae.safetensors.
    # No new custom nodes: WanInfiniteTalkToVideo and the audio nodes are in ComfyUI v0.41.0 itself.
}

# Bytes still to download for these models (files already complete count 0).
function Get-MissingBytes($models, [string]$comfy) {
    $total = [long]0
    foreach ($m in $models) {
        $file = Join-Path $comfy "models\$($m.Folder)\$($m.Name)"
        $have = [long]0
        if (Test-Path $file) { $have = (Get-Item $file).Length }
        if ($have -ne $m.Size) { $total += [long]$m.Size - [math]::Min($have, [long]$m.Size) }
    }
    return $total
}

# The GPU smoke test (run with the antics Python after PyTorch is installed): the card's compute capability, that
# this PyTorch has code for it (sm_120 for RTX 50 cards) and a 2048x2048 bfloat16 matrix product on the card,
# which fails with "no kernel image" when the code for the card is missing. It prints one line: ANTICS_GPU {json}.
$GpuCheckPy = @'
import json, math
out = {'ok': False}
try:
    import torch
    out['torch'] = torch.__version__
    out['cuda'] = torch.version.cuda
    if not torch.cuda.is_available():
        out['error'] = 'no CUDA'
    else:
        out['name'] = torch.cuda.get_device_name(0)
        major, minor = torch.cuda.get_device_capability(0)
        arch = list(torch.cuda.get_arch_list())
        out['capability'] = '%d.%d' % (major, minor)
        out['arch'] = arch
        def cc(name):  # 'sm_86' -> (8, 6), 'sm_120' -> (12, 0), 'compute_90' -> (9, 0)
            digits = ''.join(ch for ch in name.split('_', 1)[-1] if ch.isdigit())
            return (int(digits[:-1]), int(digits[-1])) if len(digits) >= 2 else None
        sass = [cc(a) for a in arch if a.startswith('sm_')]
        ptx = [cc(a) for a in arch if a.startswith('compute_')]
        # Code for this card: built for its major version with a minor up to the card's (an RTX 40 card, 8.9, runs
        # the sm_86 code; PyTorch ships no sm_89). RTX 50 cards (12.x) need sm_120 itself; older cards may also run
        # PTX of an older version, which the driver compiles for the card.
        out['sm_ok'] = any(c and c[0] == major and c[1] <= minor for c in sass) or (
            major < 12 and any(c and c <= (major, minor) for c in ptx))
        a = torch.randn(2048, 2048, device='cuda', dtype=torch.bfloat16)
        s = (a @ a).float().sum().item()
        torch.cuda.synchronize()
        out['matmul'] = math.isfinite(s)
        out['ok'] = bool(out['matmul'] and out['sm_ok'])
except Exception as e:
    out['error'] = ('%s: %s' % (type(e).__name__, e))[:300]
print('ANTICS_GPU ' + json.dumps(out))
'@

# The ANTICS_GPU line from the smoke test's output, as an object ($null when there is none).
function ConvertFrom-GpuCheck($lines) {
    foreach ($line in @($lines)) {
        $text = [string]$line
        if ($text.StartsWith('ANTICS_GPU ')) { return ($text.Substring(11) | ConvertFrom-Json) }
    }
    return $null
}

# '' when PyTorch can use the card, else what to do (in plain words).
function Get-TorchGpuProblem($check) {
    if (-not $check) { return 'The graphics card test did not run. Run the same line again.' }
    if ($check.ok) { return '' }
    $err = [string]$check.error
    if ($err -eq 'no CUDA') {
        return 'PyTorch cannot see your NVIDIA card. Update your NVIDIA driver (NVIDIA app > Drivers, 580 or newer), restart the PC, then run setup again.'
    }
    if (($err -match 'no kernel image') -or ($check.PSObject.Properties.Name -contains 'sm_ok' -and -not $check.sm_ok)) {
        return "This PyTorch ($($check.torch)) has no code for your $($check.name) (compute $($check.capability)). Run setup again; if it says the same, tell TENDHA2."
    }
    if ($err) { return "The graphics card test failed: $err" }
    return 'The graphics card test gave a wrong result. Restart the PC and run setup again.'
}

# Downloads one model file (resumes a stopped download; an unfinished file never counts as done).
function Get-ModelFile($m, [string]$comfy) {
    $dir = Join-Path $comfy "models\$($m.Folder)"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $file = Join-Path $dir $m.Name
    if ((Test-Path $file) -and (Get-Item $file).Length -eq $m.Size) {
        Write-Host "   $($m.Name): already downloaded"
        return
    }
    if ((Test-Path $file) -and (Get-Item $file).Length -gt $m.Size) { Remove-Item $file }
    $license = ''
    if ($m.License) { $license = ", $($m.License)" }
    Write-Host "   $($m.Name) ($([math]::Round($m.Size / 1GB, 1)) GB$license)"
    & curl.exe -L --fail --retry 10 --retry-delay 5 -C - -o $file $m.Url
    if (-not (Test-Path $file) -or (Get-Item $file).Length -ne $m.Size) {
        throw "The download of $($m.Name) did not finish. Run the same line again; it continues where it stopped."
    }
}

function New-Shortcut([string]$path, [string]$target, [string]$folder) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = $target
    $link.WorkingDirectory = $folder
    $link.Save()
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
    # (Sing) pinned: what an install got on 2026-11-03 (CUDA 13: RTX 50 / sm_120 cards; driver 580 or newer)
    $torchVersion = '2.14.1'
    $torchvisionVersion = '0.29.1'
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
    Write-Host 'This downloads about 25 GB (about 48 GB with singing) and takes 30-90 minutes. You can use your PC meanwhile.'

    Write-Step 'Checking your graphics card'
    $gpu = Get-GpuInfo
    if (-not $gpu) { throw 'No NVIDIA graphics card (or its driver) was found. antics needs an NVIDIA card.' }
    Write-Host "   $($gpu.Name), $([math]::Round($gpu.MemoryMiB / 1024, 1)) GB, driver $($gpu.Driver)"
    if (-not (Test-DriverVersion $gpu.Driver)) {
        throw "Your NVIDIA driver ($($gpu.Driver)) is too old. Update your NVIDIA driver (NVIDIA app > Drivers, 580 or newer), then run setup again."
    }

    Write-Step 'Checking your memory (RAM)'
    $ram = Get-RamGB
    $singBase = Select-SingBase $ram
    if ($singBase) {
        Write-Host "   $ram GB: this PC can sing too (Wan 2.1 $($singBase.Q))."
    } else {
        Write-Host "   Singing on this PC needs 32 GB of RAM; you have $ram GB. Online singing still works." -ForegroundColor Yellow
    }

    Write-Step 'Choosing a folder'
    $root = Join-Path $env:USERPROFILE 'antics'
    $need = 32GB
    if ($singBase) { $need = 55GB }
    if (-not (Test-Path $root)) {
        $drive = Get-PSDrive -Name $root.Substring(0, 1)
        if ($drive.Free -lt $need) {
            $other = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -gt $need } | Select-Object -First 1
            if (-not $other -and $singBase -and $drive.Free -ge 32GB) {
                Write-Host '   Not enough free disk space for singing (55 GB): setting up normal clips only.' -ForegroundColor Yellow
                $singBase = $null
            } elseif (-not $other) {
                throw "antics needs about $([math]::Round($need / 1GB)) GB of free disk space. Free some space and run this again."
            } else {
                $root = Join-Path $other.Root 'antics'
            }
        }
    }
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Write-Host "   $root"
    $comfy = Join-Path $root 'ComfyUI'
    $singModels = @()
    if ($singBase) {
        $singModels = Get-SingModels $singBase $hf
        $missing = Get-MissingBytes $singModels $comfy
        $free = (Get-PSDrive -Name $root.Substring(0, 1)).Free
        if ($missing -gt 0 -and $free -lt $missing + 2GB) {
            Write-Host "   Singing needs $([math]::Ceiling(($missing + 2GB) / 1GB)) GB more free disk space here. Free some and run this again; normal clips work meanwhile." -ForegroundColor Yellow
            $singModels = @()
            $singBase = $null
        }
    }

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
    if (-not (Test-Path (Join-Path $comfy 'main.py'))) {
        Get-ZipFolder "https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v$comfyVersion.zip" $comfy $root
    }
    $gguf = Join-Path $comfy 'custom_nodes\ComfyUI-GGUF'
    if (-not (Test-Path (Join-Path $gguf 'nodes.py'))) {
        Get-ZipFolder "https://github.com/city96/ComfyUI-GGUF/archive/$ggufCommit.zip" $gguf $root
    }

    Write-Step 'Installing the AI software for your graphics card (about 4 GB)'
    Invoke-Native $uv @('pip', 'install', '--python', $py, "torch==$torchVersion", "torchvision==$torchvisionVersion",
                        '--index-url', $torchIndex)
    Invoke-Native $uv @('pip', 'install', '--python', $py, '-r', (Join-Path $comfy 'requirements.txt'),
                        '-r', (Join-Path $gguf 'requirements.txt'))
    # The card test runs from a file: Windows PowerShell mangles quotes passed to other programs.
    $check = Join-Path $tools 'gpu_check.py'
    Set-Content -Path $check -Value $GpuCheckPy -Encoding ASCII
    $result = ConvertFrom-GpuCheck (& $py $check)
    $problem = Get-TorchGpuProblem $result
    if ($problem) { throw $problem }
    Write-Host "   graphics card ready: $($result.name) (compute $($result.capability), PyTorch $($result.torch), CUDA $($result.cuda))"

    Write-Step 'Downloading the video model (about 21 GB, the slow part)'
    foreach ($m in $models) { Get-ModelFile $m $comfy }
    if ($singModels.Count) {
        $sum = 0
        foreach ($m in $singModels) { $sum += $m.Size }
        Write-Step "Downloading the singing models (about $([math]::Round($sum / 1GB, 1)) GB, all free: Apache-2.0 and MIT)"
        foreach ($m in $singModels) { Get-ModelFile $m $comfy }
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
    New-Shortcut (Join-Path $desktop 'antics PC helper.lnk') $cmd $root
    if ($singBase) {
        # (Sing) singing only while this window is open; it stops by itself at 07:30 (or the time set in the app)
        $singCmd = Join-Path $root 'antics sing tonight.cmd'
        Set-Content -Path $singCmd -Encoding ASCII -Value @(
            '@echo off',
            'title antics sing tonight',
            'cd /d "%~dp0"',
            '"%~dp0venv\Scripts\python.exe" "%~dp0antics_helper.py" --sing --until 07:30',
            'pause'
        )
        New-Shortcut (Join-Path $desktop 'antics sing tonight.lnk') $singCmd $root
        & $py (Join-Path $root 'antics_helper.py') --check   # (a report only: it never stops the setup)
    }
    try { & $uv cache clean | Out-Null } catch { }  # frees the ~4 GB download cache

    Write-Step 'Connecting this PC to your antics worker'
    Invoke-Native $py @((Join-Path $root 'antics_helper.py'), '--pair')

    Write-Host ''
    Write-Host 'All done!' -ForegroundColor Green
    Write-Host 'Double-click "antics PC helper" on your Desktop whenever you want this PC to make your videos.'
    if ($singBase) {
        Write-Host 'Double-click "antics sing tonight" before bed: your PC sings your songs until 07:30. Close games first.'
    }
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
