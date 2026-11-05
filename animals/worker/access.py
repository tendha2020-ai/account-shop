# access.py: "Ask for access" (worker v15). antics is TENDHA2's private tool: a stranger who opens the page sees only
# a locked screen with "Ask TENDHA2 for access". They type their name (and an optional short note); the owner gets a
# notification and taps Approve (5, 6 or 10 videos) or Deny in Settings, Friends. Approve makes them a friend exactly
# as POST /guests does (their own key, that many videos, the owner's free AI time only: the GPU guard still checks
# every AI call), and their page unlocks by itself: it asks /access/status with its secret token every 30 s.
#
# The requests are kept in access.json with the videos (the private dataset), so they survive restarts and updates,
# with the same safety as the friends list: a file that is there but couldn't be read is never saved over, and its
# routes answer "still loading" (503) until it is read. What a request keeps: its id, the name and note (control and
# invisible characters taken out), when it was made, its status, the sha256 of its token(s) (the requester's secret,
# never the token itself), hashes of where it came from (HMAC-SHA256 under this worker's own salt and key: never the
# address itself; only while the limits need them: a day, or until a waiting request is dropped), whether the owner
# was told yet, and, once decided, when, how many videos and which friend it made.
#
# Spam limits (one stranger must not lock Ask for access for everyone, or flood the owner's phone):
# - from one place at most PER_CLIENT requests a day. A place is counted twice: by the first X-Forwarded-For address
#   and by the last public one (the one the Space's proxy added: a visitor can write the first themselves, never that
#   one); an IPv6 address by its /48; anything that isn't an address is one shared place
# - at most PER_DAY new requests a day in all, and at most MAX_PENDING waiting; each refusal says so honestly
# - a waiting request nobody answered is dropped after WAIT_DAYS (its page then says "Your request ran out")
# - only antics' own page (PAGE_ORIGINS, or a test page on this computer) may send one from a browser: another
#   website can't make its visitors' browsers ask (its Origin is refused, and the body must be application/json)
# - a small body, a honeypot field that must stay empty, a name with a visible letter that isn't TENDHA2's
# - the owner hears it once per request, and at most one request notification every PING_GAP: requests that come
#   meanwhile go out together at the scheduler's next round after that ("3 people asked for antics")
# - the owner can say no to everyone waiting at once (POST /access/deny-all)
# The same person asking again from the same place with the same name (a cleared browser, another browser, the Home
# Screen app) is the same request: its new token is added (no second row, no second notification), and every one of
# its tokens gets the invite. A request whose name is one of the owner's friends' says so to the owner, who can let
# them in as that friend again (their videos and the ones left) instead of making a new one.
#
# Decided requests are dropped after KEEP_DAYS, except an approved one whose friend is still there (its token keeps
# returning the invite). Removing that friend ends it: the token then answers 'unknown'.
#
# uvicorn's access log never shows a token or a key (the ?token= of the status checks, the page's ?key= media links)
# or a visitor's address: they are written as *** and - (a logging filter on 'uvicorn.access', set when this loads).
#
# Routes (on the worker's app, by app.include_router(router) once attach() bound this module to the worker):
#   POST /access/request {name, note, website}   public  -> {id, token}
#   GET  /access/status?token=                   public  -> {status, at?, uses?, invite?: {url, key, name, host}}
#   GET  /access/requests                        owner   -> {requests: [{id, name, note, at, status, ...}]}
#   POST /access/requests/{id} {approve, uses}   owner   -> {ok, request, friend?}  ({approve: true, friend: <id>}:
#                                                           let them in as that friend again)
#   POST /access/deny-all                        owner   -> {ok, denied}
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import threading
import time
import unicodedata

from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from starlette.concurrency import run_in_threadpool

FILE = 'access.json'
DAY = 24 * 3600
KEEP_DAYS = 14  # decided requests are dropped after this (an approved one stays while its friend does)
WAIT_DAYS = 3  # a request nobody answered is dropped after this
PER_CLIENT = 3  # requests from one place in 24 h
PER_DAY = 10  # new requests in all in 24 h
MAX_PENDING = 20  # requests waiting for the owner, in all
PING_GAP = 10 * 60  # seconds: at most one request notification this often (the others go out together after it)
TOKENS_MAX = 5  # tokens of one request (the same person asking again from the same place)
NAME_MAX, NOTE_MAX = 20, 120
MARKS_MAX = 3  # combining marks on one letter (more is only there to mess up the owner's list)
USES = (5, 6, 10)  # the videos the owner can give with Approve
BODY_MAX = 2048  # bytes of a request's body
HOST = 'TENDHA2'  # whose antics it is (the invite's host when the page doesn't say)
# Where antics' page lives: a browser may send a request only from there (or from a page on this computer: tests)
PAGE_ORIGINS = {o.strip().lower().rstrip('/') for o in
                os.environ.get('ANTICS_PAGE_ORIGINS', 'https://tendha2020-ai.github.io').split(',') if o.strip()}
LOCAL_ORIGIN = re.compile(r'http://(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?')
TOO_MANY = 'Too many requests. Try again tomorrow.'  # (from one place)
BUSY_DAY = f'Lots of people asked {HOST} today. Try again tomorrow.'
BUSY_WAIT = f'{HOST} has a lot of requests waiting. Try again in a few days.'
NOT_HERE = "Ask for access on antics' own page: https://tendha2020-ai.github.io/account-shop/animals/"
STATUSES = ('pending', 'approved', 'denied')
ZWJ = '\u200d'  # (the zero-width joiner inside emoji like a family)
# Characters that show nothing but aren't spaces or control characters (Hangul fillers, the Braille blank, ...)
FILLERS = set('\u115f\u1160\u3164\uffa0\u2800\u034f\u17b4\u17b5\u180e\u1cbb\u1cbc')
# Letters that look like Latin ones (for "is this name TENDHA2's?"), and digits written as letters
# (written as \u escapes: no Cyrillic or Greek letters in this file)
LOOKALIKE = str.maketrans('\u0430\u0435\u043e\u0440\u0441\u0445\u0443\u043a\u043c\u0442\u043d\u0432'
                          '\u0456\u0458\u0455\u04bb\u0501\u0251\u03b1\u03b5\u03bf\u03c1\u03c4\u03b7'
                          '\u03bd\u03ba\u03b9\u03c7013457',
                          'aeopcxykmthbijshdaaeoptnvkixoieast')
SECRETS = re.compile(r'([?&](?:token|key)=)[^&#\s]*', re.I)

W = None  # the worker module (attach)
log = logging.getLogger('antics')
# salt: replaced by the saved one when it loads. pinged: when the owner last got a request notification.
state = {'salt': secrets.token_hex(16), 'requests': {}, 'pinged': 0.0}
dropped = [False]  # requests (or what they no longer need) were dropped since the last save (tick() saves them away)
told_shape = [False]  # (the X-Forwarded-For's shape is logged once)
lock = threading.Lock()  # state
saving = threading.Lock()  # one save at a time, each with the newest list
deciding = threading.Lock()  # one Approve / Deny at a time (no request ever makes two friends)
router = APIRouter()


def attach(worker):
    """Binds this module to the worker (its friends, notifications, owner check and storage)."""
    global W, log
    W, log = worker, worker.log


class QuietLog(logging.Filter):
    """uvicorn's access log without secrets: a ?token= (once approved it returns a friend's key) or ?key= (the page's
    media links carry the owner's key) is written as ***, and the visitor's address as -. Every line, every route."""

    def filter(self, record):
        args = record.args
        if isinstance(args, tuple) and len(args) == 5:  # (client, method, path, http version, status: uvicorn's)
            path = args[2]
            record.args = ('-', args[1], SECRETS.sub(r'\1***', path) if isinstance(path, str) else path) + args[3:]
        return True


quiet = QuietLog()
if quiet not in logging.getLogger('uvicorn.access').filters:  # (set when this loads: before uvicorn serves anything)
    logging.getLogger('uvicorn.access').addFilter(quiet)


def now():
    return (W.time if W else time).time()  # (the worker's clock: the tests move it)


# ---------- what a request holds ----------

def clean(text):
    """One line of plain text: no control, format or invisible filler characters (line breaks and tabs become spaces;
    a zero-width joiner inside an emoji stays, one), at most MARKS_MAX combining marks on a letter, spaces squeezed,
    trimmed."""
    text = re.sub(r'\s+', ' ', str(text))
    text = ''.join(' ' if ch in FILLERS else ch for ch in text
                   if ch == ZWJ or not unicodedata.category(ch).startswith('C'))
    out, marks = [], 0
    for ch in text:
        marks = marks + 1 if unicodedata.category(ch).startswith('M') else 0
        if marks <= MARKS_MAX:
            out.append(ch)
    text = re.sub(r' {2,}', ' ', ''.join(out)).strip()
    text = re.sub(f'(?:^|(?<= )){ZWJ}+|{ZWJ}+(?= |$)', '', text)  # (a joiner only between two characters)
    return re.sub(r' {2,}', ' ', re.sub(f'{ZWJ}+', ZWJ, text)).strip()


def shows(text):
    """Does it show something: a letter, a digit or an emoji (not only marks, spaces or fillers)?"""
    return any(unicodedata.category(ch)[0] in 'LN' or unicodedata.category(ch) == 'So' for ch in text
               if ch not in FILLERS)


def fold(text):
    """A name as it reads: case, width and spaces aside (for 'the same name')."""
    return ''.join(unicodedata.normalize('NFKC', str(text)).casefold().split())


def looks_like_host(name):
    """A name that pretends to be the owner (TENDHA2, T E N D H A 2, Tendha_2, TENDHA2 with a Greek E, T3NDHA2) or
    antics itself."""
    key = ''.join(ch for ch in fold(name).translate(LOOKALIKE) if ch.isalnum())
    host = ''.join(ch for ch in fold(HOST) if ch.isalnum())
    return key == 'antics' or host.rstrip('0123456789') in key or host in key


def token_hash(token):
    return hashlib.sha256(str(token).encode()).hexdigest()


def client_key(address):
    """Where a request comes from: an IPv4 address, an IPv6 one by its /48 (a home, a phone or a free tunnel has a
    whole /64 or more), 'unknown' when there is none, or one shared 'bad' place for anything that isn't an address."""
    ip = parse_ip(address)
    if ip is None:
        return 'unknown' if not str(address or '').strip() else 'bad'
    if ip.version == 6:
        return str(ipaddress.ip_network(f'{ip}/48', strict=False))
    return str(ip)


def parse_ip(address):
    """The address in an X-Forwarded-For entry (a port, [brackets], an IPv4-mapped IPv6 address taken off), or None."""
    a = str(address or '').strip().lower()[:100]
    m = re.fullmatch(r'\[([0-9a-f:.]+)\](?::\d+)?', a)  # [v6]:port
    if m:
        a = m[1]
    elif re.fullmatch(r'[\d.]+:\d+', a):  # v4:port
        a = a.rsplit(':', 1)[0]
    try:
        ip = ipaddress.ip_address(a.split('%')[0])
    except ValueError:
        return None
    return ip.ipv4_mapped if ip.version == 6 and ip.ipv4_mapped else ip


def client_hash(address):
    """The place's hash, never the address itself: HMAC-SHA256 under this worker's salt (kept in access.json) and
    its key (a secret of the Space, not in the dataset)."""
    secret = (state['salt'] + (W.ANTICS_KEY if W else '')).encode()
    return hmac.new(secret, client_key(address).encode(), hashlib.sha256).hexdigest()


def is_public(address):
    ip = parse_ip(address)
    return ip is not None and ip.is_global


def places(request):
    """Where a request comes from, as the limits count it: the first X-Forwarded-For address (the contract's) and the
    last public one: the address the Space's proxy added at the end. A visitor can write any first address themselves
    (a proxy only adds after it), never that one. Private addresses after it are the Space's own hops. No
    X-Forwarded-For: the connection's address. One or two addresses, never stored."""
    got = [a.strip() for v in request.headers.getlist('x-forwarded-for') for a in v.split(',')]
    got = [a for a in got if a]
    if not got:
        return [request.client.host if request.client else '']
    if len(got) > 20:
        got = got[:1] + got[-19:]  # (the first and the ones the proxies added)
    public = [a for a in got if is_public(a)]
    last = public[-1] if public else got[-1]
    if not told_shape[0]:  # (once: how the Space's proxy passes addresses on, without any address)
        told_shape[0] = True
        log.info('access: X-Forwarded-For with %d address(es) (%s)', len(got),
                 ', '.join('public' if a in public else 'other' for a in got))
    return [got[0]] if client_key(last) == client_key(got[0]) else [got[0], last]


def friends():
    """The ids of the friends there are now (None while the friends list is still loading)."""
    if W.is_unread('guests.json'):
        return None
    with W.guests_lock:
        return set(W.guests)


def friends_by_name():
    """The friends there are now by their folded name ({} while the friends list is still loading): the oldest one
    of a name."""
    if W.is_unread('guests.json'):
        return {}
    with W.guests_lock:
        out = {}
        for g in sorted(W.guests.values(), key=lambda g: g.get('created') or 0):
            out.setdefault(fold(g.get('name') or ''), {k: g.get(k) for k in ('id', 'name', 'uses_left', 'used')})
        return out


def prune(t, alive):
    """(inside lock) Drops the requests nobody answered after WAIT_DAYS, and decided ones after KEEP_DAYS except
    approved ones whose friend is still there (all approved ones while the friends list is loading: alive None).
    A decided request older than a day no longer keeps where it came from (only the day's limit needs it; a waiting
    one keeps it until it is dropped, so the same person asking again is the same request)."""
    reqs = state['requests']
    for rid, r in list(reqs.items()):
        age = t - r['at']
        if (r['status'] == 'pending' and age >= WAIT_DAYS * DAY) or (
                r['status'] != 'pending' and age >= KEEP_DAYS * DAY
                and not (r['status'] == 'approved' and (alive is None or r.get('friend') in alive))):
            del reqs[rid]
            dropped[0] = True
        elif r['status'] != 'pending' and age >= DAY and 'clients' in r:
            del r['clients']
            dropped[0] = True


def view(r, alive=None, named=None):
    """A request as the owner sees it (never its token or where it came from). An approved one says which friend it
    made, and whether that friend was removed since (when the friends list is known). A waiting one whose name is a
    friend's says which friend (named: friends_by_name()), so the owner can let them in as that friend again."""
    out = {k: r.get(k) for k in ('id', 'name', 'note', 'at', 'status')}
    if r['status'] != 'pending':
        out.update(decided=r.get('decided'), uses=r.get('uses'), friend=r.get('friend'))
    if r['status'] == 'approved':
        out['removed'] = alive is not None and r.get('friend') not in alive
        if r.get('again'):
            out['again'] = True  # (let in as a friend who was there already)
    if r['status'] == 'pending' and named and fold(r['name']) in named:
        out['known'] = named[fold(r['name'])]
    return out


# ---------- storage ----------

def save():
    """access.json here and in the dataset. Never while the file in the dataset is still unread (it would wipe the
    requests that couldn't be read)."""
    if W.is_unread(FILE):
        return
    with saving:
        with lock:
            data = json.dumps(state)
            dropped[0] = False
        W.DATA.mkdir(parents=True, exist_ok=True)
        path, part = W.DATA / FILE, W.DATA / (FILE + '.part')
        part.write_text(data)
        os.replace(part, path)  # (never half a file)
        if not W.hub:
            return
        try:
            W.hub.upload_file(path_or_fileobj=str(path), path_in_repo=FILE, repo_id=W.DATASET, repo_type='dataset',
                              commit_message='access requests')
        except Exception as e:
            log.warning('saving the access requests to the Hub failed: %s', e)


HASH = re.compile(r'[0-9a-f]{64}')


def valid(rid, r):
    return (isinstance(r, dict) and re.fullmatch(r'[0-9a-f]{8}', str(rid)) is not None and r.get('id') == rid
            and r.get('status') in STATUSES and isinstance(r.get('at'), (int, float))
            and isinstance(r.get('name'), str) and isinstance(r.get('note', ''), str)
            and HASH.fullmatch(str(r.get('token'))) is not None
            and isinstance(r.get('more', []), list) and all(HASH.fullmatch(str(h)) for h in r.get('more', []))
            and isinstance(r.get('clients', []), list) and all(HASH.fullmatch(str(h)) for h in r.get('clients', [])))


def load(text):
    """access.json from the dataset (or the local copy). A broken file loads as no requests."""
    try:
        got = json.loads(text)
        for v in (got.get('requests') or {}).values():  # (a request saved with one place: 'client')
            if isinstance(v, dict) and isinstance(v.get('client'), str) and 'clients' not in v:
                v['clients'] = [v.pop('client')]
        reqs = {k: v for k, v in (got.get('requests') or {}).items() if valid(k, v)}
        salt = str(got.get('salt') or '')
        pinged = got.get('pinged')
        with lock:
            if re.fullmatch(r'[0-9a-f]{32,64}', salt):
                state['salt'] = salt
            state['requests'] = reqs
            if isinstance(pinged, (int, float)) and not isinstance(pinged, bool):
                state['pinged'] = float(pinged)
    except Exception as e:  # (no requests is better than no worker)
        log.warning('could not load the access requests: %s', e)


def tick():
    """Every minute (the worker's scheduler): requests past WAIT_DAYS or KEEP_DAYS (and where old ones came from) are
    dropped from access.json too, not only from what the worker holds; the owner hears about requests that came
    while a request notification was recent (one notification for all of them). Nothing while the file is unread."""
    if W.is_unread(FILE):
        return
    alive = friends()
    with lock:
        prune(now(), alive)
        message = to_tell()
        changed = dropped[0] or message is not None
    if changed:
        save()
    tell(message)


# ---------- the owner's notification ----------

def to_tell():
    """(inside lock) The notification for the waiting requests the owner hasn't heard about, when none went out in
    the last PING_GAP (None otherwise); they count as told from here."""
    t = now()
    if t - state.get('pinged', 0) < PING_GAP and state.get('pinged', 0) <= t:
        return None
    new = sorted((r for r in state['requests'].values() if r['status'] == 'pending' and not r.get('told', True)),
                 key=lambda r: r['at'])
    if not new:
        return None
    for r in new:
        r['told'] = True
    state['pinged'] = t
    if len(new) == 1:
        return {'title': 'Someone asked for antics', 'body': f"{new[0]['name']} wants to make videos",
                'tag': 'antics-access', 'url': 'index.html#access'}
    names = [r['name'] for r in new]
    if len(names) <= 3:
        who = f"{', '.join(names[:-1])} and {names[-1]}"
    else:
        who = f"{', '.join(names[:2])} and {len(names) - 2} more"
    return {'title': f'{len(new)} people asked for antics', 'body': f'{who} want to make videos',
            'tag': 'antics-access', 'url': 'index.html#access'}


def tell(message):
    """The owner's phones hear it (never raises: a notification never costs a request)."""
    if not message:
        return
    try:
        W.ping(W.OWNER['id'], message)
    except Exception as e:
        log.warning('access: no notification (%s)', e)


# ---------- what the routes do ----------

def ask(name, note='', website='', address=''):
    """A stranger asks for access: {id, token}. 400 on bad input (or a filled honeypot), 429 past the limits,
    503 while access.json is still loading. address: where it came from (places(): one or two addresses).
    The same person again (a waiting request from the same place with the same name) gets a new token for that
    request. The owner hears it once (now, or with the others after PING_GAP)."""
    if not isinstance(name, str) or not isinstance(note, (str, type(None))) \
            or not isinstance(website, (str, type(None))):
        raise HTTPException(400, 'Type your name.')
    if (website or '').strip():  # (a field people never see: only a robot fills it)
        raise HTTPException(400, "That didn't work. Try again.")
    name, note = clean(name), clean(note or '')
    if not 1 <= len(name) <= NAME_MAX or not shows(name):
        raise HTTPException(400, f'Type your name (up to {NAME_MAX} letters).')
    if looks_like_host(name):
        raise HTTPException(400, 'Type your own name.')
    if len(note) > NOTE_MAX:
        raise HTTPException(400, f'The note is too long (up to {NOTE_MAX} letters).')
    W.need_read(FILE, 'antics is')
    alive = friends()
    token = secrets.token_hex(16)
    where = address if isinstance(address, (list, tuple)) else [address]
    with lock:
        t = now()
        prune(t, alive)
        reqs = state['requests']
        clients = list(dict.fromkeys(client_hash(a) for a in where))
        same = next((r for r in sorted(reqs.values(), key=lambda r: -r['at']) if r['status'] == 'pending'
                     and set(r.get('clients', [])) & set(clients) and fold(r['name']) == fold(name)), None)
        if same:  # (the same person again: one request, all its tokens get the invite)
            same['more'] = (same.get('more', []) + [token_hash(token)])[-(TOKENS_MAX - 1):]
            if note:
                same['note'] = note
            rid, message = same['id'], None
        else:
            day = [r for r in reqs.values() if t - r['at'] < DAY]
            if any(sum(1 for r in day if c in r.get('clients', [])) >= PER_CLIENT for c in clients):
                raise HTTPException(429, TOO_MANY)
            if sum(1 for r in reqs.values() if r['status'] == 'pending') >= MAX_PENDING:
                raise HTTPException(429, BUSY_WAIT)
            if len(day) >= PER_DAY:
                raise HTTPException(429, BUSY_DAY)
            rid = secrets.token_hex(4)
            while rid in reqs:
                rid = secrets.token_hex(4)
            reqs[rid] = {'id': rid, 'name': name, 'note': note, 'at': t, 'status': 'pending',
                         'token': token_hash(token), 'clients': clients, 'told': False}
            message = to_tell()
    save()
    tell(message)
    return {'id': rid, 'token': token}


def status(token, url):
    """What became of a request, by its token: pending, approved (with the invite: the worker's address and the
    friend's key, name and host), denied, or unknown (no such token, dropped, or its friend was removed)."""
    token = str(token or '').strip().lower()
    if not re.fullmatch(r'[0-9a-f]{32}', token):
        return {'status': 'unknown'}
    W.need_read(FILE, 'antics is')
    alive = friends()
    h = token_hash(token)
    with lock:
        prune(now(), alive)
        r = next((r for r in state['requests'].values()
                  if any(hmac.compare_digest(x, h) for x in [r['token']] + r.get('more', []))), None)
        if not r:
            return {'status': 'unknown'}
        r = dict(r)
    if r['status'] != 'approved':
        return {'status': r['status'], 'at': r['at']}
    W.need_read('guests.json', 'antics is')  # (a friend isn't gone while the friends list loads)
    with W.guests_lock:
        guest = W.guests.get(r.get('friend'))
        guest = dict(guest) if guest else None
    if not guest:
        return {'status': 'unknown'}
    return {'status': 'approved', 'at': r['at'], 'uses': r.get('uses'),
            'invite': {'url': url, 'key': guest['key'], 'name': guest['name'], 'host': guest.get('host') or HOST}}


def listing():
    """The owner's list: waiting ones first, then newest first. Decided ones show for KEEP_DAYS."""
    alive = friends()
    named = friends_by_name()
    with lock:
        t = now()
        prune(t, alive)
        items = [view(r, alive, named) for r in state['requests'].values()
                 if r['status'] == 'pending' or t - r['at'] < KEEP_DAYS * DAY]
    items.sort(key=lambda r: (r['status'] != 'pending', -r['at']))
    return {'requests': items}


def pending_count():
    with lock:
        return sum(1 for r in state['requests'].values() if r['status'] == 'pending')


def decide(rid, approve, uses=None, host='', friend=None):
    """The owner's answer. Approve: a new friend with `uses` videos (5, 6 or 10), made exactly as POST /guests makes
    one, named after the request; or, with friend (a friend's id), that friend again (their videos and the ones they
    have left: the same person on a new phone). The request's tokens then return that friend's invite.
    404: no such request, 409: already decided, 400: bad answer or a friend who isn't there."""
    if not isinstance(approve, bool):
        raise HTTPException(400, 'Say approve: true or false.')
    if friend is not None and (not approve or not isinstance(friend, str) or not re.fullmatch(r'[0-9a-f]{8}', friend)):
        raise HTTPException(400, 'Bad friend.')
    if approve and friend is None and (isinstance(uses, bool) or uses not in USES):
        raise HTTPException(400, f"Choose {', '.join(map(str, USES[:-1]))} or {USES[-1]} videos.")
    uses = int(uses) if approve and friend is None else None
    if not isinstance(host, (str, type(None))):
        raise HTTPException(400, 'Bad host name.')
    with deciding:
        alive = friends()
        with lock:
            prune(now(), alive)
            r = state['requests'].get(str(rid))
            if not r:
                raise HTTPException(404, 'No such request')
            if r['status'] != 'pending':
                raise HTTPException(409, f"That request was already {r['status']}.")
            name = r['name']
        guest = None
        if approve:
            W.need_read('guests.json', 'Your friends list is')
            if friend is not None:
                with W.guests_lock:
                    guest = dict(W.guests[friend]) if friend in W.guests else None
                if not guest:
                    raise HTTPException(400, 'That friend is gone. Choose 5, 6 or 10 videos instead.')
            else:
                guest = W.make_guest(name, uses, (host or '').strip() or HOST)
        with lock:
            r.update(status='approved' if approve else 'denied', decided=now())
            if guest:
                r.update(friend=guest['id'], uses=uses)
                if friend is not None:
                    r['again'] = True
            state['requests'][r['id']] = r  # (still there, even if it was dropped meanwhile)
            out = view(r, {guest['id']} if guest else None)
        save()
    return {'ok': True, 'request': out, **({'friend': W.guest_view(guest)} if guest else {})}


def deny_all():
    """The owner says no to everyone waiting (one tap for a flood of requests): {ok, denied: how many}."""
    with deciding:
        alive = friends()
        with lock:
            t = now()
            prune(t, alive)
            todo = [r for r in state['requests'].values() if r['status'] == 'pending']
            for r in todo:
                r.update(status='denied', decided=t)
        if todo:
            save()
    return {'ok': True, 'denied': len(todo)}


def worker_url(request):
    """This worker's own address for the invite: the Space's (SPACE_HOST, set by Hugging Face), else the one
    the request came to."""
    host = os.environ.get('SPACE_HOST', '').split(',')[0].strip()
    if host:
        return 'https://' + host
    return str(request.base_url).rstrip('/')


def from_page(request):
    """A browser's request must come from antics' own page (another website can't make its visitors ask). No Origin
    (not a browser, or an old one): the limits take care of it."""
    origin = request.headers.get('origin')
    if origin is None:
        return True
    origin = origin.strip().lower().rstrip('/')
    return origin in PAGE_ORIGINS or LOCAL_ORIGIN.fullmatch(origin) is not None


async def read_json(request):
    """A small JSON object from the body (415 when it isn't sent as application/json: a form or text/plain from another
    website needs no CORS check first; 400 when it is too big, broken or not an object)."""
    kind = (request.headers.get('content-type') or '').split(';')[0].strip().lower()
    if kind != 'application/json':
        raise HTTPException(415, "That didn't work. Send it from antics' page.")
    size, chunks = 0, []
    async for chunk in request.stream():
        size += len(chunk)
        if size > BODY_MAX:
            raise HTTPException(400, 'That is too long.')
        chunks.append(chunk)
    try:
        body = json.loads(b''.join(chunks) or b'null')
    except ValueError:
        raise HTTPException(400, "That didn't work. Try again.")
    if not isinstance(body, dict):
        raise HTTPException(400, "That didn't work. Try again.")
    return body


# ---------- routes ----------

@router.post('/access/request')
async def access_request(request: Request):
    """Public: a stranger asks for access. JSON {name: 1-20 letters, note: 0-120, website: ''} -> {id, token}.
    Only from antics' own page when a browser sends it (403 from another website's page)."""
    if not from_page(request):
        raise HTTPException(403, NOT_HERE)
    body = await read_json(request)
    return await run_in_threadpool(ask, body.get('name'), body.get('note', ''), body.get('website', ''),
                                   places(request))


@router.get('/access/status')
def access_status(request: Request, response: Response, token: str = Query('')):
    """Public: a request's status by its token (the requester's page asks every 30 s while it is open). Never kept
    by a cache on the way (it can hold a friend's key), never written in the access log (QuietLog)."""
    response.headers['Cache-Control'] = 'no-store'
    return status(token, worker_url(request))


@router.get('/access/requests')
def access_requests(x_antics_key: str = Header(None)):
    """Owner only: the requests, waiting ones first."""
    W.check(x_antics_key)
    W.need_read(FILE, 'Your requests are')
    return listing()


@router.post('/access/deny-all')
def access_deny_all(x_antics_key: str = Header(None)):
    """Owner only: no to everyone waiting."""
    W.check(x_antics_key)
    W.need_read(FILE, 'Your requests are')
    return deny_all()


@router.post('/access/requests/{rid}')
async def access_decide(rid: str, request: Request, x_antics_key: str = Header(None)):
    """Owner only: JSON {approve: true, uses: 5|6|10} (optional host), {approve: true, friend: <friend id>} or
    {approve: false}."""
    await run_in_threadpool(W.check, x_antics_key)
    await run_in_threadpool(W.need_read, FILE, 'Your requests are')
    body = await read_json(request)
    return await run_in_threadpool(decide, rid, body.get('approve'), body.get('uses'), body.get('host') or '',
                                   body.get('friend'))
