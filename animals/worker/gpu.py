# gpu.py: the free-for-sure GPU guard. antics only ever uses the owner's FREE ZeroGPU time, never money.
#
# Why: a Hugging Face PRO account (2400 s of ZeroGPU a day; Team 2400, Enterprise 3600) goes on past its free time
# with pre-paid credits, by itself and without any refusal ("Once your daily quota is exhausted, any additional GPU
# usage is automatically billed against your credit balance", $1 per 10 min). So the worker never waits for a Space
# to refuse:
#  - One ZeroGPU call at a time in the whole worker (one lock): clips, surprise pictures, everything.
#  - Before a call: the account's real quota (GET /api/spaces/zero-gpu/quota with the owner's own key:
#    {base, current, resetsAt, overquotaUsed}). The call goes only if what is left covers the call's request (what
#    the Space books for THIS input: its @spaces.GPU duration, x2 on 'xlarge'; the worker works it out per picture),
#    plus MARGIN, plus the requests of calls that may still run upstream (see `held`), the paid seconds
#    (overquotaUsed) didn't grow, and the guard isn't stopped. Else QuotaError: the job waits until the quota resets.
#  - Before the call runs, an in-flight note goes to gpu.json in the owner's private dataset (no note, no call). A
#    worker that restarts and finds it (the old one was cut off mid-call: Update my worker, a Space restart) counts
#    that call as still running: its request stays booked for HOLD, and no call at all goes for START_HOLD (the old
#    container may still be running for a moment).
#  - A call never leaves a job behind: wait_job() waits for it, and on a timeout cancels it (a job still queued in the
#    Space is removed) and keeps the lock until it is closed. Upstream can't be confirmed, so its request stays
#    booked for HOLD. The same for any error that doesn't say the Space is done with it (only gradio_client's AppError
#    and ValidationError do): a read timeout on the queue/join POST, a proxy's 502 page, a dropped stream.
#  - After a call: the quota again. If any paid seconds were used (also paid seconds already there at the first
#    reading, with no earlier reading to compare with), every GPU call stops. The stop is kept in gpu.json in the
#    dataset (a restart keeps it), /health says alert 'billed', and only the owner's Resume (POST /gpu/resume) starts
#    AI work again. gpu.json goes to the dataset after every call, so a restart compares with the newest reading.
#  - When the quota can't be read: an account that could be charged (PRO, a Team/Enterprise member, a base seen
#    before that is that big, or not known) makes NO ZeroGPU call at all (QuotaError 'unreadable': the job looks
#    again in BLIND_WAIT), and /health tells the owner (blind 'key': the key can't read it, 'down': Hugging Face
#    didn't answer). Only a free personal account (which can't be charged: the Space refuses past the free time)
#    goes on with a ledger of the calls' requests, corrected by the Spaces' own refusals.
#  - The quota and whoami both refusing the key (401): the key was revoked: KeyRefused, as a refused key always was.
# It never uses another account, another key or an anonymous call to get more time. The PC helper (the owner's own
# GPU) isn't ZeroGPU and doesn't come here. Any NEW ZeroGPU call (a new Space, a new feature) must go through
# gpu_call() with wait_job() too (the worker tests scan every *.py for Space calls outside it).

import json
import logging
import re
import threading
import time
from datetime import datetime

import requests

QUOTA_URL = 'https://huggingface.co/api/spaces/zero-gpu/quota'  # (huggingface_hub HfApi.get_zero_gpu_quota)
WHOAMI_URL = 'https://huggingface.co/api/whoami-v2'  # isPro and the orgs' plans
MARGIN = 30  # seconds of free time always kept on top of a call's request
CACHE = 30  # a quota answer is used again for this long (the page asks /health every few seconds)
PRO_BASE, FREE_BASE = 2400, 300  # PRO 40 min a day, free 5 min
PAID_FROM = 1000  # a real base at least this big (PRO/Team 2400, Enterprise 3600) is an account that can be charged
WINDOW = 24 * 3600  # the quota resets 24 h after its first use
AFTER_RESET = 60  # a waiting job tries again this long after the reset
UNKNOWN_WAIT = 3600  # no reset time known: try again in an hour (as before the guard)
STOPPED_WAIT = 3600  # stopped: jobs look again every hour (Resume wakes them at once)
LOADING_WAIT = 120  # gpu.json is still being read from the dataset, or the in-flight note couldn't be saved
BLIND_WAIT = 600  # the quota can't be read on an account that could be charged: look again in 10 minutes
READ_TRIES, READ_PAUSE = 3, 2.0  # a quota read that failed (not 401/403) is tried again twice, 2 s and 4 s later
CANCEL_WAIT = 30  # seconds a cancelled job gets to close (the lock is kept meanwhile)
HOLD = 1800  # a call that may still run upstream (timed out, or cut off by a restart) stays booked this long
START_HOLD = 300  # a start that finds a call in flight: no call for this long (the old container may still run)
LEARN_CAP = 2.0  # a Space's refusal or a measured spend raises an engine's request at most this much (until reset)
KEEP_SPENDS = 5  # measured spends kept per engine (for the logs and tests)
VERSION = 2  # gpu.json's format

now = time.time  # (tests set a fake clock) the guard's clock: reset times, holds, the ledger
mono = time.monotonic  # (tests too) the age of a cached quota answer: never fooled by the wall clock stepping back
sleep = time.sleep
log = logging.getLogger('antics')


class QuotaError(Exception):
    """No free GPU time for this call. wait_seconds: when to try again (it already includes AFTER_RESET).
    reason: 'quota' (out of free time), 'stopped' (Hugging Face started charging: waits for Resume), 'unreadable'
    (the quota can't be read: no call until it can), 'loading' (gpu.json is being read, or the worker just restarted
    mid-call) or 'saving' (the in-flight note couldn't be saved to the dataset).
    guard: True when the guard said no before any call (so a cheaper engine may still fit)."""

    def __init__(self, message, wait=None, reason='quota', guard=False):
        super().__init__(message)
        if wait is None:  # a Space's own refusal: "Try again in 1:02:03"
            t = try_again(message)
            wait = (t if t is not None else UNKNOWN_WAIT) + AFTER_RESET
        self.wait_seconds = max(0.0, float(wait))
        self.reason = reason
        self.guard = guard


class NoKey(RuntimeError):
    """No owner key: a Space would be called anonymously (on someone else's quota), which antics never does."""


class KeyRefused(RuntimeError):
    """Hugging Face refuses the owner's key (the quota and whoami both answer 401): revoked or deleted."""


KEY_REFUSED = 'The Hugging Face key was refused. Set up the worker again with a new key.'


def try_again(message):
    """Seconds from a ZeroGPU refusal's "Try again in [N day(s), ]H:MM:SS[.ffffff]" (None without one)."""
    m = re.search(r'try again in (?:(\d+) days?, )?(\d+):(\d\d):(\d\d)', message or '', re.I)
    return (int(m[1] or 0) * 86400 + int(m[2]) * 3600 + int(m[3]) * 60 + int(m[4])) if m else None


def requested_left(message):
    """(requested, left) seconds from a refusal's "(146s requested vs. 20s left)", else None."""
    m = re.search(r'\((\d+(?:\.\d+)?)s requested vs\.? (-?\d+(?:\.\d+)?)s left\)', message or '', re.I)
    return (float(m[1]), float(m[2])) if m else None


def is_refusal(message):
    return bool(re.search(r'quota|runs limit|gpu limit|exceeded your', message or '', re.I))


def is_billing(message):
    """ZeroGPU's "You have too many ZeroGPU credits allocated to running tasks": credits are being used."""
    return bool(re.search(r'credits allocated|pending credits', message or '', re.I))


def is_auth(message):
    return bool(re.search(r'\b401\b|unauthori[sz]ed|invalid (user )?token|invalid username or password', message or '',
                          re.I))


# ---------- state ----------

lock = threading.Lock()  # one ZeroGPU call at a time in the whole worker
_state_lock = threading.RLock()
_save_lock = threading.Lock()
_cache_lock = threading.Lock()
_refreshing = threading.Lock()
_local = threading.local()  # the call this thread is making (wait_job marks it submitted / abandoned)


def fresh_state():
    return {'v': VERSION, 'stopped': False, 'alert': None, 'stopped_at': None, 'why': '',
            'over_seen': None,  # the paid seconds (overquotaUsed) the guard saw last (None: never read)
            'rebase': False,  # Resume while the quota couldn't be read: the next reading is the new start
            'base_seen': None,  # the last real base: the account's tier (>= PAID_FROM: it can be charged)
            'window': None,  # the reset time of the last reading (what was learned goes when it changes)
            'ledger': {'base': None, 'used': 0.0, 'start': None, 'ends': None},  # (free accounts, quota unreadable)
            'learned': {},  # engine -> how much more than our request a Space booked (a ratio, until the reset)
            'spent': {},  # engine -> the last measured spends (quota before - after)
            'inflight': None,  # {engine, request, started}: the call running now (in the dataset before it starts)
            'held': []}  # [{engine, request, until}]: calls that may still run upstream: their requests stay booked


state = fresh_state()
_cache = {'at': float('-inf'), 'q': None}  # (at: mono())
_fail = {'code': None}  # the last quota read that failed: its HTTP status, or 'down'
_who = {'kind': None, 'at': float('-inf'), 'status': None}  # whoami: 'paid' / 'free' (kept 6 h), its last status
_start_hold = [0.0]  # no call before this (guard clock): set when a start finds a call in flight
_hooks = {'token': None, 'save': None, 'pending': None, 'on_stop': None}
_dirty = [False]  # the last save to the dataset failed: flush() tries again


def setup(token, save=None, pending=None, on_stop=None):
    """token: the owner's HF key (never another). save(text, to_hub) -> bool keeps gpu.json (to_hub: also in the
    dataset; False when that failed); pending() is True while gpu.json may hold something that isn't read yet (no
    GPU call then); on_stop() tells the owner."""
    _hooks.update(token=token or None, save=save, pending=pending, on_stop=on_stop)


def _num(value, default=None):
    return default if value is None else float(value)


def load(text):
    """gpu.json from the dataset. A file that is there but broken counts as stopped (it may have held a stop).
    A call that was in flight when it was saved (the worker was cut off mid-call) is counted as still running."""
    try:
        got = json.loads(text)
        if not isinstance(got, dict):
            raise ValueError('not an object')
        new = fresh_state()
        new.update({k: got[k] for k in new if k in got and k != 'v'})
        led = got.get('ledger') if isinstance(got.get('ledger'), dict) else {}
        new['ledger'] = {k: _num(led.get(k)) for k in ('base', 'start', 'ends')}
        new['ledger']['used'] = float(led.get('used') or 0)
        new['stopped'] = bool(new['stopped'])
        new['alert'] = 'billed' if new['stopped'] else None
        for k in ('over_seen', 'base_seen', 'window'):
            new[k] = _num(new[k])
        new['rebase'] = bool(new['rebase'])
        learned = new['learned'] if isinstance(new['learned'], dict) and got.get('v') == VERSION else {}
        new['learned'] = {str(k): min(LEARN_CAP, max(1.0, float(v))) for k, v in learned.items()}
        new['spent'] = {str(k): [float(x) for x in v][-KEEP_SPENDS:] for k, v in
                        (new['spent'] if isinstance(new['spent'], dict) else {}).items() if isinstance(v, list)}
        new['held'] = [{'engine': str(h.get('engine') or ''), 'request': float(h['request']), 'until': float(h['until'])}
                       for h in (new['held'] if isinstance(new['held'], list) else []) if isinstance(h, dict)]
        inflight, new['inflight'] = new['inflight'], None
        if isinstance(inflight, dict):
            req = float(inflight.get('request') or 0)
            engine = str(inflight.get('engine') or '')
            log.warning('GPU guard: %s was running when the worker stopped: counted as still running', engine)
            new['held'].append({'engine': engine, 'request': req, 'until': now() + HOLD})
            led = new['ledger']  # (a free account's ledger counts it; a real reading replaces it anyway)
            if led['ends'] is not None and now() >= led['ends']:
                led.update(used=0.0, start=None, ends=None)
            if led['start'] is None:
                led['start'] = now()
                led['ends'] = led['start'] + WINDOW
            led['used'] += req
            _start_hold[0] = max(_start_hold[0], now() + START_HOLD)
    except Exception as e:
        log.error('gpu.json is broken (%s): AI work stays stopped until the owner taps Resume', e)
        new = fresh_state()
        new.update(stopped=True, alert='billed', stopped_at=now(), why='gpu.json could not be read')
    with _state_lock:
        state.clear()
        state.update(new)


def dump():
    with _state_lock:
        return json.dumps(state)


def _persist(to_hub=True):
    """gpu.json here, and in the dataset when to_hub: one save at a time, each with the newest state.
    True when it was saved where it should be."""
    if not _hooks['save']:
        return True
    with _save_lock:
        to_hub = to_hub or _dirty[0]
        try:
            ok = _hooks['save'](dump(), to_hub) is not False
        except Exception as e:
            log.warning('saving the GPU guard failed: %s', e)
            ok = False
        _dirty[0] = to_hub and not ok
        return ok


def flush():
    """Tries a failed save to the dataset again (the scheduler calls this every minute)."""
    if _dirty[0]:
        _persist()


# ---------- reading the quota ----------

def _auth():
    return {'Authorization': f"Bearer {_hooks['token']}"}


def _epoch(value):
    if value in (None, ''):
        return None
    if isinstance(value, (int, float)):
        return float(value) / (1000 if value > 1e11 else 1)
    return datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()


def _clean(data):
    """The quota answer as numbers: {base, current, resets_at (unix or None), over}. None if it isn't one."""
    try:
        q = {'base': float(data['base']), 'current': float(data['current']), 'resets_at': _epoch(data.get('resetsAt')),
             'over': float(data.get('overquotaUsed') or 0)}
    except (KeyError, TypeError, ValueError, AttributeError):
        return None
    return q


def quota(max_age=CACHE):
    """The owner's ZeroGPU quota, or None when it can't be read (no key, 401/403, any other answer, no network).
    Answers (also None) are used again for max_age seconds (measured on a monotonic clock); max_age <= 0 always
    asks Hugging Face."""
    if not _hooks['token']:
        return None
    if max_age > 0:
        with _cache_lock:
            if mono() - _cache['at'] < max_age:
                return _cache['q']
    try:
        res = requests.get(QUOTA_URL, headers=_auth(), timeout=15)
        q = _clean(res.json()) if res.status_code == 200 else None
        if q is None:
            log.info('the ZeroGPU quota could not be read (%s)', res.status_code)
        _fail['code'] = None if q is not None else res.status_code
    except Exception as e:  # (network, not JSON)
        log.info('the ZeroGPU quota could not be read (%s)', e)
        q = None
        _fail['code'] = 'down'
    with _cache_lock:
        _cache.update(at=mono(), q=q)
    return q


def _read():
    """A fresh reading for a decision: a read that failed for a moment (5xx, 429, no network) is tried again twice;
    401/403 (the key can't read it) is not."""
    for n in range(READ_TRIES):
        q = quota(0)
        if q is not None or _fail['code'] in (401, 403) or not _hooks['token']:
            return q
        if n + 1 < READ_TRIES:
            sleep(READ_PAUSE * (n + 1))
    return None


def _refresh_soon():
    """A quota read in the background (so /health never waits for Hugging Face). Paid seconds it sees stop AI
    work too, also with no video being made."""
    if not _refreshing.acquire(blocking=False):
        return

    def run():
        try:
            q = quota(0)
            if q is not None and not (_hooks['pending'] and _hooks['pending']()) and _sync(q):
                stop(f'paid ZeroGPU seconds grew to {q["over"]:.0f} (seen between calls)')
        except Exception as e:
            log.warning('GPU guard: the background check failed: %s', e)
        finally:
            _refreshing.release()
    threading.Thread(target=run, daemon=True).start()


def _paid_org(org):
    """An org whose members can go on with credits (Team/Enterprise); an unknown plan counts as paid."""
    plan = str(org.get('plan') or '').lower()
    return bool(org.get('isEnterprise') or org.get('periodEnd') or (plan and plan not in ('free', 'none', 'no_plan')))


def _whoami():
    """whoami's status (or 'down'); when it answers, the account kind is kept for 6 hours."""
    try:
        res = requests.get(WHOAMI_URL, headers=_auth(), timeout=15)
        _who['status'] = res.status_code
        if res.status_code == 200:
            data = res.json()
            paid = bool(data.get('isPro')) or any(_paid_org(o) for o in (data.get('orgs') or []) if isinstance(o, dict))
            _who.update(kind='paid' if paid else 'free', at=mono())
    except Exception as e:
        log.info('whoami failed (%s)', e)
        _who['status'] = 'down'
    return _who['status']


def account_kind():
    """'paid' (PRO, a Team/Enterprise member, or a real base that big: it CAN be charged), 'free' (a free personal
    account: it can't), or None (not known: treated as 'paid')."""
    with _state_lock:
        base = state['base_seen']
    if base is not None and base >= PAID_FROM:
        return 'paid'
    if _who['kind'] is not None and mono() - _who['at'] < 6 * 3600:
        return _who['kind']
    if not _hooks['token']:
        return None
    return _who['kind'] if _whoami() == 200 else None


def _kind_now():
    """account_kind() without asking Hugging Face (for /health)."""
    with _state_lock:
        base = state['base_seen']
    return 'paid' if base is not None and base >= PAID_FROM else _who['kind']


# ---------- the guard ----------

def _roll(led):
    """A new day for the ledger once its window is over (what was learned about the Spaces goes too)."""
    if led['ends'] is not None and now() >= led['ends']:
        led.update(used=0.0, start=None, ends=None)
        state['learned'] = {}


def _sync(q):
    """A real reading: the ledger follows it, and the paid seconds are compared with the last ones seen.
    True when they grew (Hugging Face billed credits), or when there are paid seconds and nothing was seen before
    (a charge no reading saw: an earlier worker's, a call cut off mid-way)."""
    with _state_lock:
        led = state['ledger']
        led.update(base=q['base'], used=max(0.0, q['base'] - q['current']), ends=q['resets_at'])
        if q['resets_at'] is None:
            led['start'] = None
        else:
            led['start'] = q['resets_at'] - WINDOW
        state['base_seen'] = q['base']
        w = q['resets_at']
        if w is not None:
            if state['window'] is not None and abs(w - state['window']) > 60:
                state['learned'], state['spent'] = {}, {}  # (a new day)
            state['window'] = w
        seen = state['over_seen']
        if state['rebase']:
            grew = False
        elif seen is None:
            grew = q['over'] > 0
        else:
            grew = q['over'] > seen
        state['over_seen'] = q['over']  # (lower after a reset: the new start)
        state['rebase'] = False
        return grew


def stop(why, save=True):
    """Every GPU call stops (kept in the dataset) until the owner taps Resume."""
    with _state_lock:
        first = not state['stopped']
        state.update(stopped=True, alert='billed', stopped_at=state['stopped_at'] if not first else now(), why=why)
    log.error('GPU guard: all AI work stopped (%s)', why)
    if save:
        _persist()
    if first and _hooks['on_stop']:
        try:
            _hooks['on_stop']()
        except Exception as e:
            log.warning('could not tell the owner about the stop: %s', e)


def resume():
    """The owner's Resume: AI work may go on (always within the free time). The paid seconds seen now are the new
    start, so the old charge doesn't stop it again."""
    q = quota(0)
    with _state_lock:
        state.update(stopped=False, alert=None, stopped_at=None, why='')
        if q is not None:
            state['over_seen'] = q['over']
            state['rebase'] = False
        else:
            state['rebase'] = True
    log.info('GPU guard: resumed by the owner')
    _persist()
    return view()


def need(engine, request):
    """What a call to this engine is counted at: our request for it, or more (at most LEARN_CAP times) when a
    Space's refusal or a measured spend said so today."""
    with _state_lock:
        ratio = float(state['learned'].get(engine) or 1.0)
    return float(request) * min(LEARN_CAP, max(1.0, ratio))


def _learn(engine, ratio):
    with _state_lock:
        old = float(state['learned'].get(engine) or 1.0)
        state['learned'][engine] = round(min(LEARN_CAP, max(old, ratio)), 3)


def _held():
    """(seconds, until) of the calls that may still run upstream (the ones whose time is over are dropped)."""
    with _state_lock:
        t = now()
        state['held'] = [h for h in state['held'] if h['until'] > t]
        return sum(h['request'] for h in state['held']), min((h['until'] for h in state['held']), default=None)


def _wait_until(at):
    return max(AFTER_RESET, at - now() + AFTER_RESET) if at is not None else UNKNOWN_WAIT + AFTER_RESET


def _admit(engine, request):
    """Says no (QuotaError) unless this call surely fits in the free time. Returns the quota reading (or None for a
    free account's ledger)."""
    if not _hooks['token']:
        raise NoKey('The worker has no Hugging Face key, so it makes no AI calls. Set it up again in Settings.')
    if _hooks['pending'] and _hooks['pending']():
        raise QuotaError('The GPU guard is still loading', wait=LOADING_WAIT, reason='loading', guard=True)
    with _state_lock:
        if state['stopped']:
            raise QuotaError('AI work is stopped: Hugging Face started charging credits. The owner can Resume.',
                             wait=STOPPED_WAIT, reason='stopped', guard=True)
    t = now()
    if _start_hold[0] > t:
        raise QuotaError('The worker restarted during an AI call: it waits a few minutes so that call can end first',
                         wait=_start_hold[0] - t + 5, reason='loading', guard=True)
    want = need(engine, request)
    held, held_until = _held()
    q = _read()
    if q is not None:
        if _sync(q):
            stop(f'paid ZeroGPU seconds grew to {q["over"]:.0f} before {engine}')
            raise QuotaError('AI work is stopped: Hugging Face started charging credits.', wait=STOPPED_WAIT,
                             reason='stopped', guard=True)
        if q['current'] < want + MARGIN + held:
            wait = _wait_until(q['resets_at'])
            if held and held_until is not None and q['current'] >= want + MARGIN:  # (only those calls are in the way)
                wait = min(wait, max(AFTER_RESET, held_until - now() + 5))
            extra = f' + {held:.0f}s booked by calls that may still run' if held else ''
            raise QuotaError(f'Out of free AI time for {engine}: {want:.0f}s needed + {MARGIN}s kept free{extra}, '
                             f'{q["current"]:.0f}s left', wait=wait, guard=True)
        return q
    if _fail['code'] == 401 and _whoami() == 401:
        raise KeyRefused(KEY_REFUSED)
    if account_kind() != 'free':  # PRO, Team/Enterprise or not known: it could be charged, so no call blind
        why = "the key can't read it" if _fail['code'] in (401, 403) else "Hugging Face didn't answer"
        raise QuotaError(f"The free AI time left can't be checked ({why}), so no AI call is made: this account could "
                         'be charged', wait=BLIND_WAIT, reason='unreadable', guard=True)
    # A free personal account can't be charged (the Space refuses past the free time): the ledger saves useless calls.
    with _state_lock:
        led = state['ledger']
        _roll(led)
        base = float(led['base'] or FREE_BASE)
        if led['used'] + want + held > base:
            ends = led['ends'] if led['ends'] is not None else (led['start'] or now()) + WINDOW
            wait = _wait_until(ends)
            if _fail['code'] not in (401, 403):  # (Hugging Face didn't answer for a moment: a real reading decides)
                wait = min(wait, BLIND_WAIT)
            raise QuotaError(f'Out of free AI time for {engine} (estimated: {led["used"]:.0f}s of {base:.0f}s '
                             'used today)', wait=wait, guard=True)
    return None


def _count(engine, request):
    """The ledger counts a call it couldn't measure at its request."""
    with _state_lock:
        led = state['ledger']
        _roll(led)
        if led['start'] is None:
            led['start'] = now()
            led['ends'] = led['start'] + WINDOW
        led['used'] += need(engine, request)


def _refused(engine, request, message):
    """A Space's refusal: the ledger takes what it says is left and when it resets; how much more than our request
    it booked is learned (until the reset)."""
    asked = requested_left(message)
    wait = try_again(message)
    if asked and float(request) > 0 and asked[0] > float(request):
        _learn(engine, asked[0] / float(request))
    with _state_lock:
        led = state['ledger']
        if asked:
            base = led['base'] or FREE_BASE
            led['used'] = max(0.0, base - asked[1])
        if wait is not None:
            led['ends'] = now() + wait
            led['start'] = led['ends'] - WINDOW


SETTLED = ('AppError', 'ValidationError')  # gradio_client's errors that say the Space is done with the event


def settled(error):
    """True when a Space call's error says the Space is surely done with it: gradio_client's AppError (the Space's
    own error, sent after the event ran: a refusal, no GPU free, a failure) or ValidationError (the input was refused
    before the event was queued). Anything else (httpx's ReadTimeout when the Space answers the queue/join POST late,
    a proxy's 502/504 page that isn't JSON, a dropped stream, "Server stopped") may have left the event queued or
    running in the Space. (By name and module, so a test's stand-in gradio_client can raise them too.)"""
    return any(c.__name__ in SETTLED and c.__module__.split('.')[0] == 'gradio_client' for c in type(error).__mro__)


def _close(job, why):
    """Cancels a job that may still be queued or running upstream (a job still queued in the Space is removed) and
    waits up to CANCEL_WAIT real seconds for it to close; the caller keeps the lock meanwhile."""
    try:
        job.cancel()
    except Exception as e:
        log.warning('GPU guard: cancelling a job that %s failed: %s', why, e)
    end = time.monotonic() + CANCEL_WAIT  # (real seconds)
    while time.monotonic() < end:
        try:
            if job.done():
                return
        except Exception:
            return
        sleep(0.2)


def wait_job(job, timeout):
    """Waits for a gradio_client job submitted inside gpu_call (use it for every Space call). It never leaves the job
    running upstream unbooked: on a timeout, and on any error that doesn't say the Space is done with it (settled()),
    it is cancelled (a job still queued in the Space is removed) and the lock is kept until it is closed; as upstream
    can't be confirmed, its request stays booked for HOLD, so the next engine (or a retry) is admitted only with it
    counted. A timeout raises TimeoutError; any other error is raised again as it was."""
    call = getattr(_local, 'call', None)
    if call is not None:
        call['submitted'] = True
    try:
        return job.result(timeout=timeout)
    except TimeoutError:
        failed = None
    except Exception as e:
        if settled(e):
            raise
        failed = e
    if call is not None:
        call['abandoned'] = True
    name = call['engine'] if call else 'The Space'
    if failed is not None:
        log.warning('GPU guard: %s failed in a way that may leave it running upstream (%s: %s): cancelled, its '
                    'request stays booked', name, type(failed).__name__, str(failed)[:200])
    _close(job, 'took too long' if failed is None else 'failed')
    if failed is not None:
        raise failed
    raise TimeoutError(f'{name} took more than {timeout:.0f} s, so it was cancelled')


def gpu_call(engine, request, fn):
    """Runs fn() (one ZeroGPU call) only inside the free time; see the top of this file.
    engine: its name (what is learned is kept by it); request: the seconds the call books (for its input)."""
    with lock:
        before = _admit(engine, request)
        with _state_lock:
            state['inflight'] = {'engine': engine, 'request': need(engine, request), 'started': now()}
        if not _persist(to_hub=True):  # (no note in the dataset: a restart couldn't know about this call)
            with _state_lock:
                state['inflight'] = None
            raise QuotaError("The GPU guard couldn't save its note to your dataset", wait=LOADING_WAIT,
                             reason='saving', guard=True)
        call = {'engine': engine, 'submitted': False, 'abandoned': False}
        _local.call = call
        started = now()
        failed = None
        try:
            return fn()
        except Exception as e:
            failed = e
            raise
        finally:
            _local.call = None
            try:
                _after(engine, request, before, started, failed, call)
            except Exception:  # (the check after a call must never lose the call)
                log.exception('GPU guard: the check after %s failed', engine)
                with _state_lock:
                    state['inflight'] = None
                    state['held'].append({'engine': engine, 'request': need(engine, request), 'until': now() + HOLD})
                _persist()


def _after(engine, request, before, started, failed, call):
    msg = str(failed or '')
    billing = failed is not None and is_billing(msg)
    refused = failed is not None and is_refusal(msg) and not billing
    took = max(0.0, now() - started)
    with _state_lock:
        state['inflight'] = None
    if refused:
        _refused(engine, request, msg)
    if call['abandoned']:
        with _state_lock:
            state['held'].append({'engine': engine, 'request': need(engine, request), 'until': now() + HOLD})
    held, _ = _held()
    q = _read()
    if q is not None:
        grew = _sync(q)
        if before is not None and not refused and not call['abandoned'] and not held:
            spend = before['current'] - q['current']
            # Ours only if a full GPU (x2) could have spent it in the time the call took and the day didn't reset
            # in between; with a call that may still run upstream it could be that one's (not measured then).
            if 0 <= spend <= 2 * took + 10 and before['resets_at'] in (None, q['resets_at']):
                with _state_lock:
                    state['spent'][engine] = ((state['spent'].get(engine) or []) + [round(spend, 1)])[-KEEP_SPENDS:]
                if float(request) > 0 and spend > need(engine, request) + 5:  # (our request was too low)
                    _learn(engine, spend / float(request))
        if grew:
            stop(f'paid ZeroGPU seconds grew to {q["over"]:.0f} after {engine}', save=False)
    elif call['submitted'] and not refused and not is_auth(msg):  # (a call that never reached the Space used no GPU)
        _count(engine, request)
    if billing:
        stop(f'{engine}: {msg[:200]}', save=False)
    _persist(to_hub=True)  # (always: a restart compares with the newest reading and knows the call is over)


def view():
    """For /health (never waits for Hugging Face): the free time left today and whether AI work is stopped.
    blind: why the quota can't be read ('key': the key can't read it, 'down': Hugging Face didn't answer);
    estimated: a free account goes on with the ledger; key_refused: Hugging Face refuses the key."""
    with _cache_lock:
        q, asked, stale = _cache['q'], _cache['at'] > float('-inf'), mono() - _cache['at'] >= CACHE
    if stale and _hooks['token']:
        _refresh_soon()
    with _state_lock:
        alert, stopped = state['alert'], state['stopped']
    blind = None
    if q is None and asked and _hooks['token']:
        blind = 'key' if _fail['code'] in (401, 403) else 'down'
    return {'readable': q is not None, 'left': round(q['current']) if q else None, 'base': round(q['base']) if q else None,
            'resets_at': q['resets_at'] if q else None, 'alert': alert, 'stopped': stopped, 'blind': blind,
            'estimated': q is None and _kind_now() == 'free', 'key_refused': _fail['code'] == 401 and _who['status'] == 401}
