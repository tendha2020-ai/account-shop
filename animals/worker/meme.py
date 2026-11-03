# meme.py: meme edits for the Animal Antics worker. A quick punch-in zoom with a cartoon sound effect at the
# video's funny moments (a fall, a bump, a stare at the camera), and small zoom pulses on the song's bar
# downbeats. Rules, not an AI model, so it's free and instant. The zoom runs inside join_clips' ffmpeg graph,
# on the whole joined video and under the captions and the name tag, so the text never moves.
#
# A video is one continuous shot (each part carries on from the part before), so everything is planned on the
# video's own timeline: a punch may run across a join. Only the plain cuts of videos from before v10 stop it.

import re
import subprocess

import numpy as np

import beats

# What happens at each kind of funny moment: zoom, shake (px) and the sounds, as (seconds from the moment,
# name). A kind that comes back in the same video uses its next sound set, so three falls don't sound alike.
KINDS = {
    'fail': {'zoom': 0.20, 'shake': 12, 'sfx': [[(-0.78, 'slide_down'), (0.0, 'boom')], [(0.0, 'boing')],
                                                 [(0.0, 'boom')]]},
    'bump': {'zoom': 0.18, 'shake': 10, 'sfx': [[(0.0, 'boing')], [(0.0, 'boom')]]},
    'freeze': {'zoom': 0.18, 'shake': 0, 'sfx': [[(0.0, 'scratch')]]},
    'stare': {'zoom': 0.16, 'shake': 0, 'sfx': [[(0.0, 'boom')], [(0.0, 'scratch')]]},
    'hit': {'zoom': 0.15, 'shake': 6, 'sfx': [[(0.0, 'boom')], [(0.0, 'ding')]]},
    'spin': {'zoom': 0.10, 'shake': 0, 'sfx': [[(-0.2, 'whoosh')]]},
    'exit': {'zoom': 0.08, 'shake': 0, 'sfx': [[(-0.2, 'whoosh')]]},
    'land': {'zoom': 0.12, 'shake': 0, 'sfx': [[(0.0, 'ding')]]},
    'idea': {'zoom': 0.12, 'shake': 0, 'sfx': [[(0.0, 'ding')]]},
}

# A twist (ideas.TWISTS / ideas.FAIL_TWISTS, only ever on a video's last part) is the punchline: (pattern,
# kind, where in the clip as a fraction of its full length). "At the end ..." twists happen at 70-90% of a Wan
# clip (two real clips: falls at 72% and 91%).
TWIST_RULES = [
    (r'\b(falls?|trips?|tumbles?|slips?|crash(es)?|loses its balance)\b', 'fail', 0.78),
    (r'\bbumps? into\b', 'bump', 0.8),
    (r'notices the camera|freezes', 'freeze', 0.55),
    (r'looks? straight into the camera', 'stare', 0.5),
    (r'another animal', 'hit', 0.72),
    (r'walks away|runs away', 'exit', 0.72),
]
# Moves whose own action has a funny moment (ideas.ACTIONS titles): [(kind, fraction of the clip)].
MOVE_RULES = {
    'Slip and fall': [('fail', 0.6)],
    'Gasps and runs': [('freeze', 0.25), ('exit', 0.6)],
    'Backflip': [('spin', 0.35), ('land', 0.72)],
    'Thinker': [('idea', 0.7)],
    'Dab': [('hit', 0.35)],
    'Runway model': [('hit', 0.6)],
    'Karate master': [('spin', 0.65)],
    'Moonwalk': [('spin', 0.7)],
    'Ballet spin': [('spin', 0.4)],
    'Shrug and leave': [('exit', 0.6)],
}
# The reaction moves (the 'Moment of honesty' style, also the ending custom_ideas adds after a story): the
# stare lands with a boom, and on the video's last part the camera then slowly pushes in on the face.
REACTIONS = {'Honest stare', 'Caught red-handed', 'Yeah, I did it', 'Side-eye', 'Half-closed eyes',
             'Telling a secret', 'Judging you'}
# The user's own words (custom ideas): words for each kind; earlier words happen earlier in the clip.
WORD_RULES = [
    (r'\b(falls?|fell|trips?|tumbles?|slips?|crash(es)?|faceplants?)\b', 'fail'),
    (r'\b(bumps?|runs? into|hits? (its|his|her) head)\b', 'bump'),
    (r'\b(stares?|side-?eyes?|looks? (at|into) the camera|judg\w*)\b', 'stare'),
    (r'\b(freezes|gasps?|shocked|surprised)\b', 'freeze'),
    (r'\b(spins?|backflips?|flips?|twirls?|kicks?|jumps?)\b', 'spin'),
    (r'\b(runs? away|walks? away|leaves)\b', 'exit'),
    (r'\b(idea|realis\w*|realiz\w*)\b', 'idea'),
]

# A punch: t0 (start, video seconds), a (attack), h (hold), r (release, 0 = drops back at the end of the
# hold), z (extra zoom, 0.2 = 20 % closer), s (shake in pixels, 0 = none), end (optional: stops at this
# time, a plain cut).
FUNNY_PUNCH = {'a': 0.10, 'h': 0.55, 'r': 0.30}
BEAT_PUNCH = {'z': 0.07, 'a': 0.06, 'h': 0.08, 'r': 0.25, 's': 0}
DROP_PUNCH = {'z': 0.12, 'a': 0.06, 'h': 0.15, 'r': 0.30, 's': 6}
PUSH_IN = {'h': 5.0, 'r': 0.0, 'z': 0.10, 's': 0}  # the slow push-in after a reaction stare
LEAD = 0.03  # the zoom starts a frame before the sound, so both land together
SHAKE = 0.4  # seconds a shake lasts


def _at(where, part):
    """Seconds into the shown part for a moment at `where`, a fraction of its clip's full length. A part that
    carries on from the one before skips its clip's first frame (the same picture again), and a part the next
    one carries on from ends a few frames early; the moment is kept clear of the part's very start and end."""
    shown = part['shown']
    return float(min(max(where * part['full'] - part['skip'], 0.25 * shown, 0.3), shown - 0.35))


def moments(idea, part):
    """The funny moments in one part: [(seconds into the part, kind)], at most two, the twist (punchline)
    first. part: as in plan()."""
    if part['shown'] < 1.0:  # too short for a moment to land
        return []
    found = []  # (time, kind, priority)
    twist = idea.get('twist') or ''
    for pattern, kind, where in TWIST_RULES:
        if re.search(pattern, twist, re.I):
            found.append((_at(where, part), kind, 0))
            break
    title = idea.get('title', '')
    if title in REACTIONS:
        found.append((_at(0.3, part), 'stare', 1))
    for kind, where in MOVE_RULES.get(title, []):
        found.append((_at(where, part), kind, 2))
    if idea.get('custom') and not found:
        text = idea.get('action', '')
        for pattern, kind in WORD_RULES:
            m = re.search(pattern, text, re.I)
            if m:  # words later in the description happen later in the clip
                found.append((_at(0.4 + 0.4 * m.start() / max(1, len(text)), part), kind, 3))
                break
    keep = []
    for t, kind, _ in sorted(found, key=lambda f: f[2]):
        if len(keep) < 2 and all(abs(t - k[0]) >= 0.9 for k in keep):  # two moments need room between them
            keep.append((t, kind))
    return sorted(keep)


def motion_peak(clip, lo, hi):
    """Optional: the moment of most movement between lo and hi seconds of a clip file, if it stands out from
    the rest of the clip (a fall or a bump is a burst of movement). ~0.2 s per clip. None if unclear."""
    try:
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(clip), '-vf', 'fps=16,scale=72:128,format=gray',
                              '-f', 'rawvideo', '-'], capture_output=True, check=True, timeout=60).stdout
    except (subprocess.SubprocessError, OSError):
        return None
    f = np.frombuffer(raw, np.uint8)[:len(raw) // (72 * 128) * 72 * 128].reshape(-1, 128, 72).astype(np.float32)
    if len(f) < 8:
        return None
    m = np.convolve(np.abs(np.diff(f, axis=0)).mean(axis=(1, 2)), np.ones(3) / 3, mode='same')
    t = (np.arange(len(m)) + 1) / 16
    inside = (t >= lo) & (t <= hi)
    if not inside.any():
        return None
    k = int(np.argmax(np.where(inside, m, -1)))
    return float(t[k]) - 0.2 if m[k] >= 1.4 * np.median(m) else None  # the peak trails the impact a little


def beat_hits(info, start, total, cuts=(), avoid=()):
    """Bar downbeats inside the video (video seconds), about 2 s apart, plus whether it's the song's drop.
    Skips the first moments, plain cuts and the funny moments."""
    if not info or len(info.get('beats', [])) < 8:
        return []
    grid = np.asarray(info['beats'], dtype=float)
    rms = np.asarray(info['rms'])
    fps = beats.FPS

    def level(a, b):
        i, j = int(max(0, a) * fps), int(max(0, b) * fps)
        return float(rms[i:j].mean()) if j > i and i < len(rms) else 0.0

    accent = np.array([level(b, b + 0.12) for b in grid])
    phase = max(range(4), key=lambda p: accent[p::4].mean())  # the strongest of the 4 beats = the downbeat
    downs = [float(b) - start for b in grid[phase::4]]
    jumps = {t: level(t + start, t + start + 1.0) / max(1e-6, level(t + start - 1.0, t + start)) for t in downs}
    inside = [t for t in downs if 0.3 <= t <= total - 0.6]
    drop = max(inside, key=lambda t: jumps[t], default=None)
    if drop is not None and jumps[drop] < 1.35:
        drop = None
    out = []
    for t in inside:
        if any(abs(t - c) < 0.3 for c in cuts) or any(-0.9 < t - a < 1.0 for a in avoid):
            continue
        if out and t - out[-1][0] < 1.9 and t != drop:
            continue
        out.append((t, t == drop))
    return out


def plan(parts, info=None, start=0.0, use_beats=True, speed=1.0, motion=False):
    """Everything the meme edit adds to one video, on the video's own timeline (seconds).
    parts: one dict per part, in video order: idea (its entry in job['ideas']), clip (its file), at (where it
    starts in the video), shown (seconds it plays), skip (seconds of its clip's start that are not shown),
    full (its clip's whole length), all at the video's speed, and cut (True when a plain cut leads into it:
    parts from before v10; the parts of one shot join seamlessly). info/start: beats.analyse of the song and
    where it starts; use_beats: small punches on the bar downbeats; motion: move falls and bumps onto the
    biggest burst of movement near them (motion_peak). Returns (zooms, sounds): zooms = the punches, for
    zoom_filter; sounds = [(video seconds, sound name)], for sfx.sfx_track."""
    total = parts[-1]['at'] + parts[-1]['shown'] if parts else 0.0
    cuts = [p['at'] for p in parts if p['cut']]
    zooms, sounds, funny, used = [], [], [], {}

    def cut_after(n):  # the next plain cut after part n starts: zooms stop there (a seamless join: they don't)
        return next((p['at'] for p in parts[n + 1:] if p['cut']), None)

    def add(n, punch):
        stop = cut_after(n)
        if stop is not None:
            if punch['t0'] >= stop - 0.05:
                return
            if punch['t0'] + max(punch['a'] + punch['h'] + punch['r'], SHAKE) > stop:
                punch['end'] = stop
        zooms.append(punch)

    for n, part in enumerate(parts):
        idea, at, shown = part['idea'], part['at'], part['shown']
        for t, kind in moments(idea, part):
            if motion and kind in ('fail', 'bump'):  # (the clip file's own seconds: before speed, from frame 0)
                peak = motion_peak(part['clip'], (t - 0.9 + part['skip']) * speed, (t + 0.7 + part['skip']) * speed)
                if peak is not None:
                    t = float(min(max(peak / speed - part['skip'], 0.3), shown - 0.35))
            k = KINDS[kind]
            add(n, {'t0': max(0.0, at + t - LEAD), 'z': k['zoom'], 's': k['shake'], **FUNNY_PUNCH})
            if kind == 'stare' and idea.get('title') in REACTIONS and (n == len(parts) - 1 or cut_after(n)):
                # A reaction that ends the video (or its shot): the camera slowly pushes in on the face. In the
                # middle of one shot it would have to jump back, so there it gets just the punch.
                add(n, {'t0': at + t, 'a': max(0.5, shown - t), **PUSH_IN})
            variant = k['sfx'][used.get(kind, 0) % len(k['sfx'])]
            used[kind] = used.get(kind, 0) + 1
            floor = at if part['cut'] else 0.0  # a lead-in sound may start before a seamless join, not a cut
            for offset, name in variant:
                if at + t + offset >= floor:
                    sounds.append((round(at + t + offset, 4), name))
            funny.append(at + t)
    if use_beats:
        for t, is_drop in beat_hits(info, start, total, cuts=cuts, avoid=funny):
            n = max(k for k, p in enumerate(parts) if p['at'] <= t + 1e-9)
            add(n, {'t0': max(0.0, t - LEAD), **(DROP_PUNCH if is_drop else BEAT_PUNCH)})
    zooms.sort(key=lambda p: p['t0'])
    return zooms, sorted(sounds)


# ---------- the zoom, as ffmpeg filters ----------

def _f(x):
    return f'{x:.3f}'.rstrip('0').rstrip('.') or '0'


def _window(t0, t1):
    """1 from t0 up to (not including) t1, else 0; also 0 when t is NaN while a filter starts."""
    return f'gte(t,{_f(t0)})*lt(t,{_f(t1)})'


def _bump(p):
    """0..1 envelope of one punch at frame time t: fast ease-out in, hold, smooth ease back."""
    t0, t1 = p['t0'], p['t0'] + p['a']
    t2, t3 = t1 + p['h'], t1 + p['h'] + p['r']
    fall = f"0.5+0.5*cos(PI*(t-{_f(t2)})/{_f(p['r'])})" if p['r'] > 0 else '0'
    return (f"if({_window(t0, min(t3, p.get('end', t3)))},if(lt(t,{_f(t1)}),1-pow(1-(t-{_f(t0)})/{_f(p['a'])},3),"
            f"if(lt(t,{_f(t2)}),1,{fall})),0)")


def _shake(punches, axis):
    freq, phase = (23, 0) if axis == 'x' else (17, 1.3)
    terms = [f"if({_window(p['t0'], min(p['t0'] + SHAKE, p.get('end', p['t0'] + SHAKE)))},"
             f"{_f(p['s'])}*exp(-(t-{_f(p['t0'])})/0.12)*sin(2*PI*{freq}*(t-{_f(p['t0'])})+{phase}),0)"
             for p in punches if p.get('s')]
    return '+'.join(terms) or '0'


def zoom_filter(punches, width, height):
    """'scale=...,crop=...' that zooms a width x height video by the punches (t = the video's own time), or ''
    with none. The picture is scaled up by the zoom (at 1x scale passes frames through untouched) and cropped
    back around the centre, plus a decaying shake. Overlapping punches take the bigger zoom, they don't add
    up. The frames and their times stay exactly the same."""
    if not punches:
        return ''
    zoom = f"{_f(punches[0]['z'])}*{_bump(punches[0])}"
    for p in punches[1:]:
        zoom = f"max({zoom},{_f(p['z'])}*{_bump(p)})"
    w, h = f'2*trunc({width // 2}*(1+{zoom}))', f'2*trunc({height // 2}*(1+{zoom}))'
    return (f"scale=w='{w}':h='{h}':eval=frame:flags=bicubic,"
            f"crop={width}:{height}:x='({w}-{width})/2+{_shake(punches, 'x')}':"
            f"y='({h}-{height})/2+{_shake(punches, 'y')}':exact=1")
