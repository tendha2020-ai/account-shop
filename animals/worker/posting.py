# posting.py: the Posting plan. The owner puts finished videos in a queue, and the worker reminds them (a
# notification) at 1-3 times a day in their own time zone, with the caption ready: the video's first caption, up
# to 5 hashtags (#tendha2 always, the others taking turns) and the music credit a CC BY song needs. The owner
# posts by hand (Share to TikTok + Copy caption on the page): TikTok's posting API isn't open to personal tools,
# and robots that post for you break its rules and put the account at risk.
# Only the parts without FastAPI are here; worker.py keeps the state in posting.json with the videos:
# {v, plan, queue: [item], history: [item], fired: ['YYYY-MM-DD HH:MM'], missed: [{at, why}], posted_count,
# empty_ping_day}.

import re
import secrets
import time
import unicodedata
from datetime import datetime, time as dtime, timedelta, timezone
from zoneinfo import ZoneInfo

import ideas

now = time.time  # the clock (tests put a fake one here)

CAPTION_MAX = 2200  # TikTok's caption limit, counted in UTF-16 units (an emoji is 2)
GRACE = 3 * 3600  # a time missed while the worker slept still reminds when it came at most this long ago
MAX_PER_DAY = 3
MAX_TAGS = 15  # hashtags in the list
TAG_CHARS = 50  # the longest hashtag, its '#' included
MAX_FIXED = 5
MAX_PER_POST = 5
MAX_QUEUE = 100
KEEP_HISTORY = 50
FIRED_DAYS = 3  # fired times are kept this many days back (the scheduler looks at today and yesterday)
MISSED_SECONDS = 7 * 86400  # missed times are kept (and shown) for a week
DEFAULT_TIMES = ['12:30', '18:30', '21:00']
DEFAULT_TAGS = ['#tendha2', '#funnyanimals', '#animalsoftiktok', '#aivideo', '#petsoftiktok', '#funnyvideos', '#fyp']
# Each animal's own TikTok community tag (the animals of ideas.ANIMAL_WORDS), on every post of that animal.
ANIMAL_TAGS = {
    'dog': '#dogsoftiktok', 'cat': '#catsoftiktok', 'parrot': '#parrotsoftiktok', 'bird': '#birdsoftiktok',
    'monkey': '#monkeysoftiktok', 'duck': '#ducksoftiktok', 'goose': '#goose', 'chicken': '#chickensoftiktok',
    'goat': '#goatsoftiktok', 'sheep': '#sheepoftiktok', 'cow': '#cowsoftiktok', 'horse': '#horsesoftiktok',
    'donkey': '#donkeysoftiktok', 'pig': '#pigsoftiktok', 'rabbit': '#bunniesoftiktok',
    'hamster': '#hamstersoftiktok', 'guinea pig': '#guineapigsoftiktok', 'bear': '#bear', 'panda': '#panda',
    'capybara': '#capybara', 'raccoon': '#raccoonsoftiktok', 'fox': '#fox', 'squirrel': '#squirrelsoftiktok',
    'hippo': '#hippo', 'elephant': '#elephant', 'penguin': '#penguin', 'otter': '#otter', 'seal': '#seal',
    'kangaroo': '#kangaroo', 'llama': '#llama', 'sloth': '#sloth', 'crocodile': '#crocodile',
}
AI_TAG = '#aivideo'  # (only on videos that AI made any of: TikTok asks for AI content to be labelled)
CAT, DOG, BOTH_TAG = ANIMAL_TAGS['cat'], ANIMAL_TAGS['dog'], '#catsanddogs'  # (a Together video with both)
TIME = re.compile(r'([01]\d|2[0-3]):[0-5]\d')
KEY = re.compile(r'\d{4}-\d\d-\d\d \d\d:\d\d')  # a fired time: its local day and time
ITEM_ID = re.compile(r'p_[0-9a-f]{8}')
AUDIO = ('no_song', 'as_made')  # no_song: the TikTok cut (the video without the song, TikTok's sound is added)


def default_plan():
    return {'on': False, 'per_day': 2, 'times': list(DEFAULT_TIMES), 'tz': 'UTC', 'tags': list(DEFAULT_TAGS),
            'fixed': 1, 'per_post': 5}


def fresh():
    """An empty posting.json."""
    return {'v': 1, 'plan': default_plan(), 'queue': [], 'history': [], 'fired': [], 'missed': [],
            'posted_count': 0, 'empty_ping_day': None}


# ---------- Settings ----------

def whole(value, lo, hi, what):
    """A whole number from lo to hi (the page sends numbers; a numeric string is fine too)."""
    if isinstance(value, str) and re.fullmatch(r'\s*\d{1,6}\s*', value):
        value = int(value)
    number = (isinstance(value, int) and not isinstance(value, bool)) or (isinstance(value, float) and value.is_integer())
    if not number or not lo <= value <= hi:  # (true/false, 2.5, NaN and infinity are not)
        raise ValueError(f'{what} must be a number from {lo} to {hi}')
    return int(value)


def tz_ok(name):
    """True when this worker can read the time zone (zoneinfo with its data)."""
    try:
        ZoneInfo(name)
        return True
    except Exception:  # (unknown name, odd path, or no time zone data here at all)
        return False


def clean_tz(name):
    if not isinstance(name, str) or len(name) > 64 or not re.fullmatch(r'[A-Za-z0-9_+\-/]+', name) or not tz_ok(name):
        raise ValueError(f"{str(name)[:64]!r} isn't a time zone this worker knows (like Europe/Berlin)")
    return name


def zone(name):
    """The plan's time zone, or UTC when it can't be read here (GET /plan's tz_ok says so)."""
    try:
        return ZoneInfo(name)
    except Exception:
        return timezone.utc


def arrange(times, per_day):
    """Each time once, enough of them for per_day (the usual ones fill in), and the ones in use (the first
    per_day) in order of the day. The others keep their places after them, so a time the page shows never
    swaps with one it doesn't."""
    times = list(dict.fromkeys(times))
    for t in DEFAULT_TIMES:
        if len(times) >= per_day:
            break
        if t not in times:
            times.append(t)
    return sorted(times[:per_day]) + times[per_day:]


def clean_times(times):
    if not isinstance(times, list) or not 1 <= len(times) <= MAX_PER_DAY:
        raise ValueError(f'Send 1 to {MAX_PER_DAY} times, like 18:30')
    out = []
    for t in times:
        if not isinstance(t, str) or not TIME.fullmatch(t.strip()):
            raise ValueError(f'{str(t)[:20]!r} is not a time like 18:30')
        out.append(t.strip())
    return out


def tag_ok(body):
    """A hashtag's letters: letters and numbers of any language, _, and their accents."""
    return bool(body) and all(ch.isalnum() or ch == '_' or unicodedata.category(ch).startswith('M') for ch in body)


def clean_tags(tags):
    """Hashtags, normalized: '#' added, spaces trimmed, ones that can't be a hashtag (a space, a sign, too long)
    dropped, each once (ignoring capitals; the first spelling stays), at most MAX_TAGS."""
    out, seen = [], set()
    for t in tags if isinstance(tags, list) else []:
        if not isinstance(t, (str, int)) or isinstance(t, bool):
            continue
        body = str(t).strip().lstrip('#')
        tag = '#' + body
        if tag_ok(body) and len(tag) <= TAG_CHARS and tag.casefold() not in seen:
            seen.add(tag.casefold())
            out.append(tag)
    return out[:MAX_TAGS]


def settings(plan, body):
    """The plan with the page's changes (any of on, per_day, times, tz, tags, fixed, per_post; others are
    ignored), and whether its reminder times moved (turned on, or times, per_day or tz changed). ValueError
    with a plain message for a wrong value; nothing changes then."""
    if not isinstance(body, dict):
        raise ValueError('Send the settings as a JSON object')
    new = dict(plan)
    if 'on' in body:
        if not isinstance(body['on'], bool):
            raise ValueError('on must be true or false')
        new['on'] = body['on']
    if 'per_day' in body:
        new['per_day'] = whole(body['per_day'], 1, MAX_PER_DAY, 'Posts a day')
    if 'times' in body:
        new['times'] = clean_times(body['times'])
    if 'tz' in body:
        new['tz'] = clean_tz(body['tz'])
    if 'tags' in body:
        if not isinstance(body['tags'], list):
            raise ValueError('tags must be a list of hashtags')
        new['tags'] = clean_tags(body['tags'])
    if 'fixed' in body:
        new['fixed'] = whole(body['fixed'], 0, MAX_FIXED, 'Hashtags always used')
    if 'per_post' in body:
        new['per_post'] = whole(body['per_post'], 0, MAX_PER_POST, 'Hashtags per video')
    new['times'] = arrange(new['times'], new['per_day'])
    moved = (new['on'] and not plan.get('on')) or any(new[k] != plan.get(k) for k in ('times', 'per_day', 'tz'))
    return new, moved


# ---------- Hashtags and the caption ----------

def utf16_len(text):
    return len(text.encode('utf-16-le')) // 2


def animal_tag(animal):
    """The animal's own community tag, or None (an unknown animal)."""
    name = (animal or '').strip().lower()
    return ANIMAL_TAGS.get(name if name in ANIMAL_TAGS else ideas.guess_animal(name))


def pick_tags(plan, job, posted_count, animals=None, ai=True):
    """A video's hashtags: the plan's first `fixed` always, then the animal's own (from the job's animal), then
    the others taking turns, one step on with every post (so two posts in a row don't carry the same ones), each
    once, at most per_post (5). A Together video: animals = each of its animals (their own tags, and #catsanddogs
    when it has both); ai=False (nothing in it made by AI): no #aivideo."""
    own = clean_tags(plan.get('tags'))
    if not ai:
        own = [t for t in own if t.casefold() != AI_TAG]
    want = max(0, min(MAX_PER_POST, int(plan.get('per_post') or 0)))
    fixed = own[:max(0, int(plan.get('fixed') or 0))]
    extras = [animal_tag(a) for a in (animals if animals is not None else [(job or {}).get('animal')])]
    if {CAT, DOG} <= set(extras):
        extras.append(BOTH_TAG)
    first = clean_tags(fixed + [e for e in extras if e])
    seen = {t.casefold() for t in first}
    rest = [t for t in own[len(fixed):] if t.casefold() not in seen]
    k = int(posted_count or 0) % len(rest) if rest else 0
    return (first + rest[k:] + rest[:k])[:want]


def shorten(text, room):
    """text cut on a word, with '…', to at most `room` UTF-16 units ('' when nothing fits). One long word is
    cut where it must."""
    if utf16_len(text) <= room:
        return text
    head = text[:max(0, room)]
    while head and utf16_len(head) > room - 1:  # (room for the '…')
        head = head[:-1]
    if head and not text[len(head)].isspace() and re.search(r'\s', head):
        head = re.sub(r'\s+\S*$', '', head)  # back to the end of the last whole word
    head = head.rstrip().rstrip('\u200d\ufe0f')  # (no half of an emoji left at the cut)
    return head + '…' if head else ''


def compose(text, tags, credit='', limit=CAPTION_MAX):
    """The caption: the text and the hashtags on one line, then the credit on a line of its own. Over the limit,
    hashtags go from the end first, then the text is shortened on a word with '…'; the credit is never cut."""
    text = re.sub(r'\s+', ' ', text or '').strip()
    tags = list(tags)

    def build(t, g):
        line = ' '.join(([t] if t else []) + g)
        return '\n'.join(part for part in (line, credit) if part)

    while tags and utf16_len(build(text, tags)) > limit:
        tags.pop()
    if utf16_len(build(text, tags)) > limit:
        room = limit - (utf16_len(build('x', tags)) - 1)  # what the hashtags and the credit leave for the text
        text = shorten(text, room)
    return build(text, tags)


def custom(text):
    """The owner's own caption as typed (lines kept), within the limit; '' means: automatic again."""
    text = (text or '').strip()
    return shorten(text, CAPTION_MAX)


def with_credit(text, credit):
    """The owner's own caption with the credit a CC BY song needs, on a line of its own, when it isn't in it
    already. The credit is never cut: the text is shortened instead."""
    if not credit or credit.casefold() in text.casefold():
        return text
    room = CAPTION_MAX - utf16_len(credit) - 1  # (the line break)
    return '\n'.join(part for part in (shorten(text, room), credit) if part)


def tags_in(text):
    return clean_tags(re.findall(r'#\w+', text or ''))  # (the hashtags of the owner's own caption)


# ---------- When the reminders go ----------

def today(plan, t):
    return datetime.fromtimestamp(t, zone(plan['tz'])).date()


def slots_on(plan, day, tz=None):
    """[(key, unix time)] of the plan's times on one local day, in order. zoneinfo picks the offset: a time
    that doesn't exist that day (clocks go forward) comes that much later, and a time that comes twice
    (clocks go back) is the first one."""
    tz = tz or zone(plan['tz'])
    out = []
    for hhmm in sorted(plan['times'][:plan['per_day']]):
        local = datetime.combine(day, dtime(int(hhmm[:2]), int(hhmm[3:])), tzinfo=tz)  # (fold=0: the first)
        out.append((f'{day.isoformat()} {hhmm}', local.timestamp()))
    return out


def tidy(state, t):
    """Forget fired times older than FIRED_DAYS, missed ones older than a week, history past KEEP_HISTORY."""
    oldest = (today(state['plan'], t) - timedelta(days=FIRED_DAYS)).isoformat()
    state['fired'] = [k for k in dict.fromkeys(state['fired']) if k[:10] >= oldest]
    state['missed'] = [m for m in state['missed'] if m['at'] >= t - MISSED_SECONDS]
    del state['history'][:-KEEP_HISTORY]


def mark_past(state, t):
    """After the plan is turned on or its times change: every time before now counts as done, so nothing old
    reminds. The fired list is made again for the new times (an old key could match a new time to come)."""
    plan = state['plan']
    tz, day = zone(plan['tz']), today(plan, t)
    state['fired'] = [key for back in range(FIRED_DAYS, -1, -1)
                      for key, at in slots_on(plan, day - timedelta(days=back), tz) if at <= t]


def tick(state, t):
    """The scheduler at time t: each of yesterday's and today's times that came and hasn't fired is marked
    fired; one at most GRACE late is to remind about now, an older one goes to missed (the worker was asleep).
    Returns (the times to remind about, oldest first; whether the state changed). Nothing when the plan is off."""
    plan = state['plan']
    if not plan['on']:
        return [], False
    tz, day = zone(plan['tz']), today(plan, t)
    fired, fire, changed = set(state['fired']), [], False
    for d in (day - timedelta(days=1), day):
        for key, at in slots_on(plan, d, tz):
            if at > t or key in fired:
                continue
            fired.add(key)
            state['fired'].append(key)
            changed = True
            if t - at <= GRACE:
                fire.append(at)
            else:
                state['missed'].append({'at': at, 'why': 'asleep'})
    if changed:
        tidy(state, t)
    return fire, changed


def remind(state, due, t, known=lambda job_id: True):
    """Who a scheduler round reminds about, when `due` times came in it (one push for the round): the next `due`
    waiting videos (now 'reminded'); with none waiting, the one ready to post the longest is reminded again (it
    wasn't posted: "Remind me later"); with none at all, that the plan is empty (once a local day). known(job id):
    the video is there. Returns ('new' | 'again' | 'empty' | '', [the items])."""
    if due <= 0:
        return '', []
    queue = [item for item in state['queue'] if known(item['job'])]
    waiting = [item for item in queue if item['status'] == 'waiting'][:due]
    for item in waiting:
        item.update(status='reminded', reminded_at=t)
    if waiting:
        return 'new', waiting
    ready = [item for item in queue if item['status'] == 'reminded']
    if ready:
        item = min(ready, key=lambda i: i['reminded_at'] or 0)  # (the first in the queue when they tie)
        item['reminded_at'] = t
        return 'again', [item]
    day = today(state['plan'], t).isoformat()
    if state.get('empty_ping_day') == day:
        return '', []
    state['empty_ping_day'] = day
    return 'empty', []


def upcoming(state, t, count):
    """The next `count` reminder times, in order: a time that came less than GRACE ago and hasn't fired yet
    (the scheduler sends it within a minute) counts too. [] when the plan is off."""
    plan = state['plan']
    if not plan['on'] or count <= 0:
        return []
    tz, fired, out = zone(plan['tz']), set(state['fired']), []
    day = today(plan, t) - timedelta(days=1)
    for _ in range(count + 3):  # (every day has at least one time)
        out += [at for key, at in slots_on(plan, day, tz) if at > t - GRACE and key not in fired]
        if len(out) >= count:
            break
        day += timedelta(days=1)
    return out[:count]


# ---------- The queue ----------

def new_item(job_id, audio, by, t):
    return {'id': 'p_' + secrets.token_hex(4), 'job': job_id, 'added': t, 'status': 'waiting', 'caption': None,
            'audio': audio, 'reminded_at': None, 'done_at': None, 'by': by, 'cut_rev': None}


def find(state, pid):
    return next((item for item in state['queue'] if item['id'] == pid), None)


def reorder(state, ids, hidden=()):
    """The queue in the page's new order: exactly the ids in it now, each once (ValueError otherwise). The page
    doesn't see `hidden` ones (their video is missing for now, e.g. it didn't load after a restart): it may leave
    them out, and they keep their places."""
    have, hidden = [item['id'] for item in state['queue']], set(hidden)
    shown = {i for i in have if i not in hidden}
    if (not isinstance(ids, list) or not all(isinstance(i, str) for i in ids) or len(set(ids)) != len(ids)
            or set(ids) not in (set(have), shown)):
        raise ValueError('The order must list every video in the plan once. Refresh and try again.')
    by_id, sent, moved = {item['id']: item for item in state['queue']}, set(ids), iter(ids)
    state['queue'] = [by_id[next(moved)] if i in sent else by_id[i] for i in have]  # (the places of the ones sent)


def finish(state, pid, result, label, t):
    """Posted or skipped: the item goes to the history (with its label, in case the video is deleted later).
    A post moves the hashtags on."""
    item = find(state, pid)
    state['queue'].remove(item)
    item.update(status=result, done_at=t)
    state['history'].append(dict(item, label=label))
    del state['history'][:-KEEP_HISTORY]
    if result == 'posted':
        state['posted_count'] += 1
    return item


# ---------- posting.json ----------

def _item(raw, done=False):
    """One queue (or history) item as kept, or None when it isn't one."""
    if not isinstance(raw, dict) or not ITEM_ID.fullmatch(str(raw.get('id'))) or not isinstance(raw.get('job'), str):
        return None
    statuses = ('posted', 'skipped') if done else ('waiting', 'reminded')
    item = {'id': raw['id'], 'job': raw['job'], 'added': _num(raw.get('added')) or 0.0,
            'status': raw.get('status') if raw.get('status') in statuses else statuses[0],
            'caption': raw['caption'] if isinstance(raw.get('caption'), str) and raw['caption'] else None,
            'audio': raw.get('audio') if raw.get('audio') in AUDIO else 'as_made',
            'reminded_at': _num(raw.get('reminded_at')), 'done_at': _num(raw.get('done_at')),
            'by': raw['by'] if isinstance(raw.get('by'), str) else None,
            'cut_rev': raw['cut_rev'] if isinstance(raw.get('cut_rev'), int) else None}
    if done:
        item['label'] = str(raw.get('label') or 'A video')[:80]
    return item


def _num(value):
    ok = isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and abs(value) < 1e12
    return float(value) if ok else None


def load(got):
    """posting.json as kept, made safe: what is missing or broken gets its default (never raises)."""
    state = fresh()
    if not isinstance(got, dict):
        return state
    plan = got.get('plan') if isinstance(got.get('plan'), dict) else {}
    for key in ('per_day', 'times', 'tz', 'tags', 'fixed', 'per_post', 'on'):  # (one at a time: a bad one is skipped)
        if key in plan:
            try:
                state['plan'] = settings(state['plan'], {key: plan[key]})[0]
            except ValueError:
                pass
    for name, done in (('queue', False), ('history', True)):
        kept = got.get(name) if isinstance(got.get(name), list) else []
        items = [_item(raw, done) for raw in kept]
        seen = set()
        for item in items:
            if item and item['id'] not in seen and not (name == 'queue' and len(state['queue']) >= MAX_QUEUE):
                seen.add(item['id'])
                state[name].append(item)
    del state['history'][:-KEEP_HISTORY]
    fired = got.get('fired') if isinstance(got.get('fired'), list) else []
    state['fired'] = list(dict.fromkeys(k for k in fired if isinstance(k, str) and KEY.fullmatch(k)))
    missed = got.get('missed') if isinstance(got.get('missed'), list) else []
    state['missed'] = [{'at': float(m['at']), 'why': str(m.get('why') or 'asleep')[:20]}
                       for m in missed if isinstance(m, dict) and _num(m.get('at')) is not None]
    count = got.get('posted_count')
    state['posted_count'] = count if isinstance(count, int) and not isinstance(count, bool) and count >= 0 else 0
    day = got.get('empty_ping_day')
    state['empty_ping_day'] = day if isinstance(day, str) and re.fullmatch(r'\d{4}-\d\d-\d\d', day) else None
    return state
