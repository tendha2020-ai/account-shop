"""What LagBuster knows about common apps and games.

* ``KNOWN_APPS``: popular background apps, how to deal with them and whether
  they may be force-closed (only apps that never hold unsaved work).
* ``PROTECTED``: system, driver and anti-cheat processes LagBuster never touches.
* ``KNOWN_GAMES`` and ``GAME_PATH_HINTS``: used to guess which app is your game.

Names are compared with :func:`normalize` (lower case, no ``.exe``) so the
same entries work on Windows and Linux.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass


def normalize(name: str) -> str:
    name = (name or "").strip().lower()
    if name.endswith(".exe"):
        name = name[:-4]
    return name


@dataclass(frozen=True)
class KnownApp:
    friendly: str
    kind: str
    action: str = "lower"  # suggested fix: "close", "lower" (priority) or "leave"
    force_ok: bool = False  # may be force-closed if it ignores a normal close request
    note: str = ""


_BROWSER = "Save anything you're typing first. You can reopen your tabs later with Ctrl+Shift+T."
_CHAT = "You won't get messages until you open it again."
_SYNC = "Files stop syncing until you open it again (or restart your PC)."
_LAUNCHER = "Keep it open if your game was started from it."
_RGB = "Closing it can reset your RGB lighting or mouse settings, so lowering its priority is the safer choice."
_WORK = "Save your work first. LagBuster only asks it to close; it will not force it."
_TORRENT = "Downloads pause until you open it again. Heavy downloads also cause lag spikes online."


def _apps(names: tuple[str, ...], app: KnownApp) -> dict[str, KnownApp]:
    return {name: app for name in names}


KNOWN_APPS: dict[str, KnownApp] = {
    # Web browsers
    **_apps(("chrome",), KnownApp("Google Chrome", "browser", "close", True, _BROWSER)),
    **_apps(("msedge",), KnownApp("Microsoft Edge", "browser", "close", True, _BROWSER)),
    **_apps(("firefox",), KnownApp("Firefox", "browser", "close", True, _BROWSER)),
    **_apps(("opera",), KnownApp("Opera", "browser", "close", True, _BROWSER)),
    **_apps(("brave",), KnownApp("Brave", "browser", "close", True, _BROWSER)),
    **_apps(("vivaldi",), KnownApp("Vivaldi", "browser", "close", True, _BROWSER)),
    **_apps(("arc",), KnownApp("Arc", "browser", "close", True, _BROWSER)),
    # Chat and calls
    **_apps(
        ("discord", "discordptb", "discordcanary"),
        KnownApp(
            "Discord",
            "chat",
            "lower",
            True,
            "In a voice call? Keep it open - lowering its priority is enough. "
            "Turning off Hardware Acceleration in Discord's settings also helps.",
        ),
    ),
    **_apps(("teams", "ms-teams"), KnownApp("Microsoft Teams", "chat", "close", True, _CHAT)),
    **_apps(("slack",), KnownApp("Slack", "chat", "close", True, _CHAT)),
    **_apps(("zoom",), KnownApp("Zoom", "chat", "close", True, "Don't close it if you're in a meeting.")),
    **_apps(("skype",), KnownApp("Skype", "chat", "close", True, _CHAT)),
    **_apps(("whatsapp",), KnownApp("WhatsApp", "chat", "close", True, _CHAT)),
    **_apps(("telegram",), KnownApp("Telegram", "chat", "close", True, _CHAT)),
    **_apps(("signal",), KnownApp("Signal", "chat", "close", True, _CHAT)),
    **_apps(("messenger",), KnownApp("Messenger", "chat", "close", True, _CHAT)),
    # Music and video
    **_apps(
        ("spotify",),
        KnownApp("Spotify", "music", "lower", True, "Listening while you play? Lowering its priority keeps the music going."),
    ),
    **_apps(("vlc",), KnownApp("VLC media player", "media", "close", True)),
    **_apps(("itunes", "applemusic"), KnownApp("Apple Music / iTunes", "music", "lower", True)),
    # Cloud storage sync
    **_apps(("onedrive",), KnownApp("OneDrive", "sync", "close", True, _SYNC)),
    **_apps(("dropbox",), KnownApp("Dropbox", "sync", "close", True, _SYNC)),
    **_apps(("googledrivefs",), KnownApp("Google Drive", "sync", "close", True, _SYNC)),
    **_apps(("icloudservices", "iclouddrive"), KnownApp("iCloud", "sync", "close", True, _SYNC)),
    **_apps(("megasync",), KnownApp("MEGA", "sync", "close", True, _SYNC)),
    # Game launchers and stores
    **_apps(("epicgameslauncher",), KnownApp("Epic Games Launcher", "launcher", "close", True, _LAUNCHER)),
    **_apps(("eadesktop", "origin"), KnownApp("EA app", "launcher", "close", True, _LAUNCHER)),
    **_apps(("battle.net",), KnownApp("Battle.net", "launcher", "close", True, _LAUNCHER)),
    **_apps(("upc", "ubisoftconnect"), KnownApp("Ubisoft Connect", "launcher", "close", True, _LAUNCHER)),
    **_apps(("galaxyclient",), KnownApp("GOG Galaxy", "launcher", "close", True, _LAUNCHER)),
    **_apps(("xboxpcapp",), KnownApp("Xbox app", "launcher", "close", True, _LAUNCHER)),
    **_apps(("steam",), KnownApp("Steam", "launcher", "lower", False, "Don't close Steam if your game is from Steam.")),
    **_apps(
        ("steamwebhelper",),
        KnownApp("Steam (web helper)", "launcher", "lower", False, "Part of Steam - lowering its priority is safe."),
    ),
    **_apps(
        ("riotclientservices", "riotclientux"),
        KnownApp("Riot Client", "launcher", "lower", False, "Valorant and League of Legends need it."),
    ),
    # Recording, streaming and overlays
    **_apps(
        ("obs64", "obs32", "obs", "streamlabs obs"),
        KnownApp("OBS Studio", "streaming", "leave", False, "Keep it if you're streaming or recording."),
    ),
    **_apps(
        ("medal",),
        KnownApp("Medal.tv", "recording", "close", True, "Medal records clips in the background, which costs FPS."),
    ),
    **_apps(
        ("overwolf",),
        KnownApp("Overwolf", "overlay", "close", True, "Overlays and clip recorders cost some FPS."),
    ),
    **_apps(("gamebar",), KnownApp("Xbox Game Bar", "overlay", "close", True)),
    # RGB, mouse and keyboard software
    **_apps(("icue",), KnownApp("Corsair iCUE", "rgb", "lower", False, _RGB)),
    **_apps(("lghub", "lghub_agent"), KnownApp("Logitech G HUB", "rgb", "lower", False, _RGB)),
    **_apps(("armourycrate",), KnownApp("Armoury Crate", "rgb", "lower", False, _RGB)),
    **_apps(
        ("razer synapse 3", "razer synapse service", "razercentral"),
        KnownApp("Razer Synapse", "rgb", "lower", False, _RGB),
    ),
    **_apps(("signalrgb",), KnownApp("SignalRGB", "rgb", "lower", False, _RGB)),
    **_apps(("nzxt cam",), KnownApp("NZXT CAM", "rgb", "close", True)),
    # Wallpapers and desktop widgets
    **_apps(
        ("wallpaper32", "wallpaper64"),
        KnownApp(
            "Wallpaper Engine",
            "wallpaper",
            "close",
            True,
            "Your normal wallpaper comes back. Closing it frees graphics card memory.",
        ),
    ),
    **_apps(("lively",), KnownApp("Lively Wallpaper", "wallpaper", "close", True)),
    **_apps(("rainmeter",), KnownApp("Rainmeter", "widget", "close", True)),
    # Work and creative apps - never force-closed (unsaved work)
    **_apps(("photoshop",), KnownApp("Adobe Photoshop", "creative", "close", False, _WORK)),
    **_apps(("afterfx",), KnownApp("Adobe After Effects", "creative", "close", False, _WORK)),
    **_apps(("adobe premiere pro",), KnownApp("Adobe Premiere Pro", "creative", "close", False, _WORK)),
    **_apps(("illustrator",), KnownApp("Adobe Illustrator", "creative", "close", False, _WORK)),
    **_apps(("blender",), KnownApp("Blender", "creative", "close", False, _WORK)),
    **_apps(("unity",), KnownApp("Unity Editor", "creative", "close", False, _WORK)),
    **_apps(("unityhub",), KnownApp("Unity Hub", "utility", "close", True)),
    **_apps(("code",), KnownApp("Visual Studio Code", "work", "close", False, _WORK)),
    **_apps(("devenv",), KnownApp("Visual Studio", "work", "close", False, _WORK)),
    **_apps(("winword",), KnownApp("Microsoft Word", "work", "close", False, _WORK)),
    **_apps(("excel",), KnownApp("Microsoft Excel", "work", "close", False, _WORK)),
    **_apps(("powerpnt",), KnownApp("Microsoft PowerPoint", "work", "close", False, _WORK)),
    **_apps(("outlook", "olk"), KnownApp("Outlook", "work", "close", False, _WORK)),
    # Adobe and other background helpers
    **_apps(
        ("creative cloud", "ccxprocess", "adobeipcbroker", "coresync", "acrotray", "adobe desktop service"),
        KnownApp("Adobe Creative Cloud (background)", "utility", "close", True),
    ),
    # Torrents and download managers
    **_apps(("qbittorrent",), KnownApp("qBittorrent", "torrent", "close", True, _TORRENT)),
    **_apps(("utorrent", "bittorrent"), KnownApp("uTorrent / BitTorrent", "torrent", "close", True, _TORRENT)),
    **_apps(("transmission-qt", "transmission-gtk"), KnownApp("Transmission", "torrent", "close", True, _TORRENT)),
    **_apps(("deluge",), KnownApp("Deluge", "torrent", "close", True, _TORRENT)),
    **_apps(("idman",), KnownApp("Internet Download Manager", "download", "close", True, _TORRENT)),
    # Windows extras
    **_apps(("phoneexperiencehost", "yourphone"), KnownApp("Phone Link", "utility", "close", True)),
    **_apps(("widgets",), KnownApp("Windows Widgets", "utility", "close", True)),
    **_apps(("cortana",), KnownApp("Cortana", "utility", "close", True)),
}

# Apps that keep running in the background and download or upload a lot.
NETWORK_HEAVY_KINDS = {"torrent", "download", "sync", "launcher"}

PROTECTED: frozenset[str] = frozenset(
    {
        # Windows itself
        "system", "system idle process", "idle", "registry", "memory compression", "secure system",
        "smss", "csrss", "wininit", "winlogon", "services", "lsass", "lsaiso", "svchost",
        "fontdrvhost", "dwm", "explorer", "sihost", "taskhostw", "ctfmon", "runtimebroker",
        "shellexperiencehost", "startmenuexperiencehost", "shellhost", "searchhost", "searchapp",
        "searchindexer", "searchprotocolhost", "searchfilterhost", "textinputhost",
        "applicationframehost", "systemsettings", "lockapp", "logonui", "userinit", "dllhost",
        "conhost", "openconsole", "windowsterminal", "cmd", "powershell", "pwsh", "wmiprvse",
        "spoolsv", "audiodg", "dashost", "wudfhost", "taskmgr", "mmc", "backgroundtaskhost",
        "smartscreen", "securityhealthservice", "securityhealthsystray", "sgrmbroker",
        "msmpeng", "nissrv", "mpdefendercoreservice", "mpcmdrun", "tiworker", "trustedinstaller",
        "mousocoreworker", "usocoreworker", "wuauclt", "musnotifyicon", "gamebarpresencewriter",
        "gameinputsvc", "useroobebroker", "msedgewebview2", "crossdeviceservice", "unsecapp",
        "wlanext", "atbroker", "sppsvc", "compattelrunner", "werfault", "wermgr",
        # Graphics and audio drivers
        "nvcontainer", "nvdisplay.container", "nvidia web helper", "nvsphelper64", "nvidia overlay",
        "nvidia share", "nvidia app", "amdrsserv", "amdrssrcext", "radeonsoftware", "atiesrxx",
        "atieclxx", "amdow", "amdfendrsr", "cncmd", "igfxem", "igfxcuiservice", "igfxhk",
        "igfxtray", "intelcphdcpsvc", "rtkauduservice64", "rtkaudioservice64", "ravbg64",
        "nahimicservice", "nahimicsvc64", "dolbydax2api",
        # Anti-cheat (touching these can get games closed or flagged)
        "easyanticheat", "easyanticheat_eos", "easyanticheat_eos_setup", "beservice",
        "beservice_x64", "vgc", "vgtray", "faceit", "faceitservice", "faceitclient",
        "esportal", "gameguard", "xigncode", "mhyprot",
        # LagBuster itself and the Python that runs it
        "lagbuster", "python", "pythonw", "py", "pyw",
        # Linux desktop
        "systemd", "init", "xorg", "xwayland", "gnome-shell", "kwin_x11", "kwin_wayland",
        "plasmashell", "pipewire", "pipewire-pulse", "wireplumber", "pulseaudio", "dbus-daemon",
        "dbus-broker", "networkmanager", "sshd", "login", "gdm", "sddm", "lightdm", "bash", "zsh",
        "sh", "fish", "tmux", "screen", "xdg-desktop-portal", "gvfsd", "at-spi-bus-launcher",
        "ibus-daemon", "fcitx5", "polkitd", "udisksd", "upowerd", "thermald",
        "power-profiles-daemon", "gamemoded",
    }
)

# Readable names for Windows' own processes (shown on the dashboard).
SYSTEM_NAMES: dict[str, str] = {
    "msmpeng": "Windows Security (virus scan)",
    "mpdefendercoreservice": "Windows Security (virus scan)",
    "dwm": "Desktop Window Manager",
    "explorer": "Windows Explorer",
    "svchost": "Windows services",
    "system": "System",
    "memory compression": "Memory compression",
    "audiodg": "Windows audio",
    "searchindexer": "Windows Search indexing",
    "tiworker": "Windows Update (installing)",
    "trustedinstaller": "Windows Update (installing)",
    "mousocoreworker": "Windows Update",
    "csrss": "Windows core process",
    "lsass": "Windows sign-in service",
    "runtimebroker": "Windows app permissions",
    "searchhost": "Windows Search",
    "startmenuexperiencehost": "Start menu",
    "textinputhost": "Windows keyboard input",
    "ctfmon": "Windows keyboard input",
    "sihost": "Windows shell",
    "taskhostw": "Windows background tasks",
    "wmiprvse": "Windows management (WMI)",
    "spoolsv": "Printing",
    "nvcontainer": "NVIDIA driver helper",
    "nvdisplay.container": "NVIDIA driver helper",
}

# Processes that tell us Windows is busy with maintenance (used for tips only).
DEFENDER_PROCESSES = {"msmpeng", "mpdefendercoreservice", "mpcmdrun", "nissrv"}
UPDATE_PROCESSES = {"tiworker", "trustedinstaller", "mousocoreworker", "usocoreworker", "wuauclt", "setuphost"}
INDEXER_PROCESSES = {"searchindexer", "searchprotocolhost", "searchfilterhost"}

KNOWN_GAMES: dict[str, str] = {
    "fortniteclient-win64-shipping": "Fortnite",
    "valorant-win64-shipping": "VALORANT",
    "league of legends": "League of Legends",
    "cs2": "Counter-Strike 2",
    "csgo": "Counter-Strike: Global Offensive",
    "dota2": "Dota 2",
    "gta5": "Grand Theft Auto V",
    "gta5_enhanced": "Grand Theft Auto V Enhanced",
    "rdr2": "Red Dead Redemption 2",
    "r5apex": "Apex Legends",
    "r5apex_dx12": "Apex Legends",
    "robloxplayerbeta": "Roblox",
    "minecraft.windows": "Minecraft",
    "overwatch": "Overwatch 2",
    "rocketleague": "Rocket League",
    "tslgame": "PUBG: Battlegrounds",
    "escapefromtarkov": "Escape from Tarkov",
    "eldenring": "Elden Ring",
    "cyberpunk2077": "Cyberpunk 2077",
    "destiny2": "Destiny 2",
    "genshinimpact": "Genshin Impact",
    "starrail": "Honkai: Star Rail",
    "zenlesszonezero": "Zenless Zone Zero",
    "warframe.x64": "Warframe",
    "rainbowsix": "Rainbow Six Siege",
    "rainbowsix_vulkan": "Rainbow Six Siege",
    "bf2042": "Battlefield 2042",
    "bf6": "Battlefield 6",
    "cod": "Call of Duty",
    "modernwarfare": "Call of Duty: Modern Warfare",
    "blackopscoldwar": "Call of Duty: Black Ops Cold War",
    "fc24": "EA SPORTS FC 24",
    "fc25": "EA SPORTS FC 25",
    "fc26": "EA SPORTS FC 26",
    "palworld-win64-shipping": "Palworld",
    "hogwartslegacy": "Hogwarts Legacy",
    "helldivers2": "Helldivers 2",
    "marvel-win64-shipping": "Marvel Rivals",
    "deltaforceclient-win64-shipping": "Delta Force",
    "deadbydaylight-win64-shipping": "Dead by Daylight",
    "wow": "World of Warcraft",
    "diablo iv": "Diablo IV",
    "pathofexile": "Path of Exile",
    "pathofexile_x64": "Path of Exile",
    "bg3": "Baldur's Gate 3",
    "bg3_dx11": "Baldur's Gate 3",
    "starfield": "Starfield",
    "forzahorizon5": "Forza Horizon 5",
    "sotgame": "Sea of Thieves",
    "rustclient": "Rust",
    "terraria": "Terraria",
    "stardew valley": "Stardew Valley",
    "among us": "Among Us",
    "fallguys_client_game": "Fall Guys",
    "dayz_x64": "DayZ",
    "arma3_x64": "Arma 3",
    "eurotrucks2": "Euro Truck Simulator 2",
    "witcher3": "The Witcher 3",
    "osu!": "osu!",
}

# Folders games are usually installed in (lower case, forward slashes).
GAME_PATH_HINTS = (
    "/steamapps/common/",
    "/epic games/",
    "/riot games/",
    "/xboxgames/",
    "/ea games/",
    "/origin games/",
    "/ubisoft game launcher/games/",
    "/gog galaxy/games/",
    "/gog games/",
    "/rockstar games/",
    "/roblox/versions/",
    "/.minecraft/",
    "/minecraft launcher/",
    "/games/",
    "/lutris/",
    "/heroic/",
)

# Folders whose next path part is the game's name, e.g. .../steamapps/common/Apex Legends/...
_TITLE_FOLDERS = ("/steamapps/common/", "/epic games/", "/riot games/", "/xboxgames/", "/ea games/", "/gog galaxy/games/")

# Helper programs that live next to games but aren't the game.
_NOT_GAME_WORDS = (
    "launcher", "crash", "report", "updater", "update", "helper", "setup", "install", "redist",
    "anticheat", "battleye", "bootstrap", "service", "overlay", "unins", "prereq", "vcredist",
    "handler", "uploader", "server", "cef", "browser",
)


def is_protected(key: str, extra: set[str] | frozenset[str] = frozenset()) -> bool:
    return key in PROTECTED or key in extra


def game_score(key: str, exe: str, gpu: float, my_games: set[str] | frozenset[str] = frozenset()) -> int:
    """How likely an app is the game being played (0 = not a game)."""
    if key in my_games:
        return 200
    if key in PROTECTED or key in KNOWN_APPS:
        return 0
    path = exe.replace("\\", "/").lower()
    known = key in KNOWN_GAMES
    minecraft_java = key in ("javaw", "java") and "minecraft" in path
    if not known and not minecraft_java and any(word in key for word in _NOT_GAME_WORDS):
        return 0
    score = 0
    if known:
        score += 90
    if minecraft_java:
        score += 80
    if key.endswith(("-win64-shipping", "-wingdk-shipping", "-win64-test")):
        score += 60  # Unreal Engine games
    if any(hint in path for hint in GAME_PATH_HINTS):
        score += 45
    if gpu >= 25:
        score += 40
    elif gpu >= 8:
        score += 20
    return score


def game_title(key: str, exe: str, fallback: str) -> str:
    """A readable name for a game."""
    if key in KNOWN_GAMES:
        return KNOWN_GAMES[key]
    if key in ("javaw", "java") and "minecraft" in exe.lower():
        return "Minecraft (Java Edition)"
    path = exe.replace("\\", "/")
    lowered = path.lower()
    for folder in _TITLE_FOLDERS:
        index = lowered.find(folder)
        if index >= 0:
            rest = path[index + len(folder):]
            title = rest.split("/", 1)[0].strip()
            if title:
                return title
    stripped = re.sub(r"-(win64|wingdk)-(shipping|test)$", "", key, flags=re.IGNORECASE)
    if stripped != key:
        return stripped.replace("_", " ").title()
    return fallback


def pretty_exe_name(name: str) -> str:
    """"SomeApp.exe" -> "SomeApp"."""
    base = os.path.basename(name or "")
    if base.lower().endswith(".exe"):
        base = base[:-4]
    return base or name
