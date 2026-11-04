"""check_library.py: checks the free clip library (library.json) before it ships.

A maintainer tool, not one of the worker's files (the worker never runs it). It needs only Python 3.

Offline (always):
  - every clip has the fields the page and the worker read, with the right types, and nothing unexpected;
  - ids are unique and look like "goat-02"; no clip is listed twice;
  - the licence is on the allowed list (CC0, public domain, CC BY 2.0-4.0, CC BY-SA 2.0-4.0; never NC, ND or
    GFDL-only) AND the worker's own together.licence_ok() accepts it (a clip the worker skips would show on the
    page but fail when the video is made);
  - the credit line is exactly '"<title>" by <author>, <license>, via Wikimedia Commons';
  - the animal word is one the worker knows (it survives worker.clean_animal() unchanged and is in
    ideas.ANIMAL_WORDS), and the group is one the page has a filter chip for;
  - url / mov / poster / page are Wikimedia Commons addresses of the same file (the folder letters Commons
    derives from the file name are checked too), and start / seconds make sense.

Online (--online), slowly and politely (one request at a time, Retry-After honoured):
  - Commons still has each file with the same licence, no restrictions, a long enough video, and the url and mov
    renditions in its list of ready transcodes;
  - every url, mov and poster answers with the right content type (video/webm, video/quicktime, image/jpeg).
  Wikimedia refuses media downloads from many datacenter networks ("robot policy"); such answers are reported as
  "not checked from this network", not as broken links. Check those from a home connection.

Usage:
  python3 check_library.py [--online] [path/to/library.json]
Exit code: 0 when everything checked is fine (warnings allowed), 1 when something is wrong.
"""
import ast
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
UA = 'AnimalAntics/13 (https://github.com/tendha2020-ai/account-shop) check_library.py'
API = 'https://commons.wikimedia.org/w/api.php'
COMMONS = 'https://upload.wikimedia.org/wikipedia/commons/'
THUMB_HOSTS = ('https://thumb.wikimedia.org/wikipedia/commons/thumb/', COMMONS + 'thumb/')
FIELDS = {'id': str, 'animal': str, 'group': str, 'label': str, 'url': str, 'page': str, 'poster': str,
          'start': (int, float), 'seconds': (int, float), 'license': str, 'author': str, 'credit': str}
OPTIONAL = {'mov': str}  # the H.264 copy for browsers that can't play WebM (older iPhones)
GROUPS = ('dogs', 'cats', 'farm', 'wild', 'birds')  # the page's filter chips (together.js GROUPS)
ALLOWED = re.compile(r'(CC0( 1\.0)?|Public domain|PDM|CC BY(-SA)? (2\.0|2\.5|3\.0|4\.0))', re.I)
THUMB_SIZES = (120, 250, 330, 500, 960)  # Commons' standard thumbnail widths (others may be refused)
URL_KEYS = ('480p.vp9.webm', '720p.vp9.webm', '1080p.vp9.webm', '360p.vp9.webm')


# ---------- The worker's own rules, read from its files (so this check can never drift from them) ----------

def worker_function(file, name):
    """One function from a worker file, without importing the file (worker.py needs the web server's packages)."""
    tree = ast.parse((HERE / file).read_text())
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
    space = {'re': re}
    exec(compile(ast.Module(body=[node], type_ignores=[]), file, 'exec'), space)
    return space[name]


def worker_constant(file, name):
    tree = ast.parse((HERE / file).read_text())
    node = next(n for n in tree.body if isinstance(n, ast.Assign) and any(
        isinstance(t, ast.Name) and t.id == name for t in n.targets))
    return ast.literal_eval(node.value)


def worker_rules():
    """clean_animal (worker.py), licence_ok (together.py) and the animal words (ideas.py)."""
    return (worker_function('worker.py', 'clean_animal'), worker_function('together.py', 'licence_ok'),
            worker_constant('ideas.py', 'ANIMAL_WORDS'))


# ---------- Offline checks ----------

class Report:
    def __init__(self):
        self.errors, self.warnings, self.unchecked = [], [], []

    def bad(self, who, text):
        self.errors.append(f'{who}: {text}')

    def warn(self, who, text):
        self.warnings.append(f'{who}: {text}')


def file_name(page):
    """'Cat_Play_02.webm' from 'https://commons.wikimedia.org/wiki/File:Cat_Play_02.webm' (or None)."""
    m = re.fullmatch(r'https://commons\.wikimedia\.org/wiki/File:([^/?#]+)', page or '')
    return urllib.parse.unquote(m[1]).replace(' ', '_') if m else None


def folder(name):
    """Commons keeps a file under two folders made from the md5 of its name: 6/6f/Kitten....webm."""
    h = hashlib.md5(name.encode()).hexdigest()
    return f'{h[0]}/{h[:2]}/'


def quoted(name):
    """A file name in an upload.wikimedia.org address: every character but letters, digits and _.-~ is %-coded."""
    return urllib.parse.quote(name, safe='')


def credit_for(c, name):
    title = re.sub(r'\.[a-z0-9]+$', '', name, flags=re.I).replace('_', ' ')
    return f'"{title}" by {c.get("author")}, {c.get("license")}, via Wikimedia Commons'


def check_fields(c, who, r):
    for key, kind in FIELDS.items():
        if key not in c:
            r.bad(who, f'missing "{key}"')
        elif not isinstance(c[key], kind) or isinstance(c[key], bool) or c[key] in ('', None):
            r.bad(who, f'"{key}" should be a {"number" if kind != str else "text"}')
    for key in c:
        if key not in FIELDS and key not in OPTIONAL:
            r.warn(who, f'unexpected field "{key}" (the page and the worker ignore it)')
    if 'mov' in c and not isinstance(c['mov'], str):
        r.bad(who, '"mov" should be text')
    return all(isinstance(c.get(k), v) for k, v in FIELDS.items())


def check_words(c, who, r, rules):
    clean_animal, licence_ok, animal_words = rules
    if not re.fullmatch(r'[a-z]+(-[a-z]+)*-\d{2}', c['id']):
        r.bad(who, 'id should look like "goat-02"')
    elif not c['id'].startswith(c['animal'].replace(' ', '-') + '-'):
        r.warn(who, f'id does not start with its animal ("{c["animal"]}")')
    if clean_animal(c['animal']) != c['animal']:
        r.bad(who, f'animal "{c["animal"]}" changes in worker.clean_animal() ("{clean_animal(c["animal"])}")')
    if c['animal'] not in animal_words:
        r.bad(who, f'animal "{c["animal"]}" is not one of the words the worker knows (ideas.ANIMAL_WORDS)')
    if c['group'] not in GROUPS:
        r.warn(who, f'group "{c["group"]}" has no filter chip on the page ({", ".join(GROUPS)})')
    if {'dog': 'dogs', 'cat': 'cats'}.get(c['animal'], c['group']) != c['group']:
        r.bad(who, f'a {c["animal"]} belongs in group "{c["animal"]}s"')
    if not ALLOWED.fullmatch(c['license'].strip()):
        r.bad(who, f'licence "{c["license"]}" is not allowed (CC0, public domain, CC BY, CC BY-SA only)')
    elif not licence_ok(c['license']):
        r.bad(who, f'licence "{c["license"]}" is refused by the worker (together.licence_ok): the page would '
                   'show this clip but making the video would fail')
    if len(c['label']) > 40 or not re.fullmatch(r"[A-Z][A-Za-z0-9 ,.'!?&-]*", c['label']):
        r.bad(who, 'label should be short plain words starting with a capital (no emoji), at most 40 characters')
    if len(c['author']) > 60 or re.search(r'[<>\n]', c['author']):
        r.bad(who, 'author should be a short plain name')


def check_addresses(c, who, r):
    name = file_name(c['page'])
    if not name:
        r.bad(who, 'page should be https://commons.wikimedia.org/wiki/File:<name>')
        return
    base, q = folder(name), quoted(name)
    if c['credit'] != credit_for(c, name):
        r.bad(who, f'credit should be: {credit_for(c, name)}')
    keys = '|'.join(re.escape(k) for k in URL_KEYS)
    transcoded = re.escape(f'{COMMONS}transcoded/{base}{q}/{q}.')
    if not (re.fullmatch(transcoded + f'({keys})', c['url']) or c['url'] == f'{COMMONS}{base}{q}'):
        r.bad(who, f'url should be a VP9 WebM rendition of {name} ({COMMONS}transcoded/{base}{q}/{q}.480p.vp9.webm)')
    if 'mov' in c and c['mov'] != f'{COMMONS}transcoded/{base}{q}/{q}.360p.mpeg4.mov':
        r.bad(who, f'mov should be {COMMONS}transcoded/{base}{q}/{q}.360p.mpeg4.mov')
    elif 'mov' not in c and c['url'].endswith('.webm'):
        r.warn(who, 'no "mov": phones that cannot play WebM (iPhones before iOS 17.4) cannot use this clip '
                    '(add the 360p .mov copy when Commons has one)')
    m = re.fullmatch(r'(\d+)px-(?:seek=[\d.]+)?-' + re.escape(q) + r'\.jpg', c['poster'].split(base + q + '/')[-1])
    if not c['poster'].startswith(tuple(h + base + q + '/' for h in THUMB_HOSTS)) or not m:
        r.bad(who, f'poster should be a Commons thumbnail of {name} (…/thumb/{base}{q}/330px--{q}.jpg)')
    elif int(m[1]) not in THUMB_SIZES:
        r.warn(who, f'poster width {m[1]} px is not one of Commons\' standard sizes {THUMB_SIZES}')


def check_times(c, who, r):
    if c['start'] < 0:
        r.bad(who, 'start should be 0 or more')
    if not 1 <= c['seconds'] <= 90:
        r.bad(who, 'seconds (the good part, from start) should be 1-90')
    elif c['seconds'] < 4:
        r.warn(who, 'the good part is shorter than 4 s (the free looks keep 6 s around the picked moment)')


def check_offline(data, r, rules):
    clips = data.get('clips') if isinstance(data, dict) else None
    if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(clips, list):
        r.bad('library.json', 'should be {"version": 1, "clips": [...]}')
        return []
    seen = {}
    for i, c in enumerate(clips):
        who = c.get('id') if isinstance(c, dict) and isinstance(c.get('id'), str) else f'clip {i + 1}'
        if not isinstance(c, dict):
            r.bad(who, 'should be {"id": ..., "animal": ..., ...}')
            continue
        for key in ('id', 'url', 'page'):
            if isinstance(c.get(key), str) and c[key] in seen:
                r.bad(who, f'same {key} as {seen[c[key]]}')
            seen.setdefault(c.get(key), who)
        if not check_fields(c, who, r):
            continue
        check_words(c, who, r, rules)
        check_addresses(c, who, r)
        check_times(c, who, r)
    return [c for c in clips if isinstance(c, dict) and file_name(c.get('page'))]


# ---------- Online checks ----------

def request(url, method='GET', tries=4, gap=[0.0]):
    """One polite request: at least 1.5 s after the previous one, Retry-After honoured (at most 2 minutes).
    Returns (status, headers, body); a network failure is status 0."""
    for attempt in range(tries):
        time.sleep(max(0.0, gap[0] + 1.5 - time.time()))
        req = urllib.request.Request(url, method=method, headers={'User-Agent': UA, 'Range': 'bytes=0-1023'}
                                     if method == 'GET' and 'api.php' not in url else {'User-Agent': UA})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                status, headers, body = res.status, res.headers, res.read(2_000_000)
        except urllib.error.HTTPError as e:
            status, headers, body = e.code, e.headers, e.read(4000)
        except (urllib.error.URLError, OSError) as e:
            status, headers, body = 0, {}, str(e).encode()
        gap[0] = time.time() + (5 if time.time() - t0 > 1 else 0)  # a slow answer: wait longer next time
        if status not in (429, 503) or b'robot policy' in body:
            return status, headers, body
        wait = (headers.get('Retry-After') or '10').strip()
        time.sleep(min(120, max(5, float(wait) if wait.replace('.', '', 1).isdigit() else 10)) + 5 * attempt)
    return status, headers, body


def commons_pages(names):
    """Commons' answer for each file name (50 per request)."""
    out = {}
    for i in range(0, len(names), 50):
        params = {'action': 'query', 'format': 'json', 'formatversion': '2', 'prop': 'videoinfo',
                  'titles': '|'.join('File:' + n for n in names[i:i + 50]),
                  'viprop': 'size|mediatype|extmetadata|derivatives',
                  'viextmetadatafilter': 'LicenseShortName|Restrictions'}
        status, _, body = request(f'{API}?{urllib.parse.urlencode(params)}')
        if status != 200:
            raise RuntimeError(f'Commons API answered {status}')
        data = json.loads(body)
        names_back = {n['to']: n['from'] for n in data.get('query', {}).get('normalized', [])}
        for p in data.get('query', {}).get('pages', []):
            out[names_back.get(p['title'], p['title'])[5:].replace(' ', '_')] = p
    return out


def check_commons(c, page, r):
    who = c['id']
    vi = (page.get('videoinfo') or [None])[0]
    if page.get('missing') or not vi:
        r.bad(who, 'Commons no longer has this file (deleted or renamed)')
        return
    meta = {k: (v or {}).get('value', '') for k, v in (vi.get('extmetadata') or {}).items()}
    if re.sub(r'<[^>]+>', '', meta.get('LicenseShortName', '')).strip().lower() != c['license'].lower():
        r.bad(who, f'Commons now says the licence is "{meta.get("LicenseShortName")}"')
    if re.sub(r'<[^>]+>', '', meta.get('Restrictions', '')).strip():
        r.bad(who, f'Commons lists restrictions: {meta["Restrictions"][:60]}')
    if c['start'] + c['seconds'] > (vi.get('duration') or 0) + 0.5:
        r.bad(who, f'start + seconds is past the end of the video ({vi.get("duration", 0):.1f} s)')
    ready = {d.get('src') for d in vi.get('derivatives') or []}
    for key in ('url', 'mov'):
        if key in c and c[key] not in ready and c[key] != vi.get('url'):
            r.bad(who, f'Commons has no ready {key} rendition at {c[key]}')


def check_answers(c, r, refused=set()):
    """Each address answers with the right kind of content. A robot-policy refusal is noted, not failed, and that
    host is not asked again in this run."""
    want = {'url': 'video/webm', 'mov': 'video/quicktime', 'poster': 'image/jpeg'}
    for key, kind in want.items():
        if key not in c:
            continue
        host = urllib.parse.urlsplit(c[key]).netloc
        if host in refused:
            r.unchecked.append(f'{c["id"]} {key}: not asked ({host} refused this network earlier in the run)')
            continue
        status, headers, body = request(c[key])
        got = (headers.get('Content-Type') or '').split(';')[0].strip() if headers else ''
        if b'robot policy' in body:
            refused.add(host)
            r.unchecked.append(f'{c["id"]} {key}: refused by Wikimedia from this network (robot policy)')
        elif status == 429 or status == 0:
            r.unchecked.append(f'{c["id"]} {key}: no answer ({status or body[:60].decode(errors="replace")})')
        elif status not in (200, 206):
            r.bad(c['id'], f'{key} answered {status}')
        elif got != kind and not (key == 'url' and c[key].endswith('.mov') and got == 'video/quicktime'):
            r.bad(c['id'], f'{key} answered {got or "no content type"}, expected {kind}')
        print(f'  {c["id"]:12} {key:6} {status} {got}', flush=True)


def check_online(clips, r):
    names = [file_name(c['page']) for c in clips]
    try:
        pages = commons_pages(names)
    except (RuntimeError, ValueError) as e:
        r.unchecked.append(f'Commons API: {e}')
        pages = {}
    for c, name in zip(clips, names):
        if name in pages:
            check_commons(c, pages[name], r)
        elif pages:
            r.bad(c['id'], 'Commons did not answer for this file')
        check_answers(c, r)


# ---------- Main ----------

def summary(clips):
    groups = {}
    for c in clips:
        groups.setdefault(c.get('group'), []).append(c.get('animal'))
    return '; '.join(f'{g}: {len(a)} ({", ".join(sorted(set(a)))})' for g, a in groups.items())


def main(argv):
    online = '--online' in argv
    paths = [a for a in argv if not a.startswith('--')]
    path = Path(paths[0]) if paths else HERE / 'library.json'
    r = Report()
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        print(f'Cannot read {path}: {e}')
        return 1
    clips = check_offline(data, r, worker_rules())
    if online and not r.errors:
        check_online(clips, r)
    elif online:
        print('Fix the offline problems first; the online check was skipped.')
    print(f'{path}: {len(data.get("clips", []))} clips. {summary(data.get("clips", []))}')
    for title, items in (('PROBLEMS', r.errors), ('Warnings', r.warnings), ('Not checked', r.unchecked)):
        if items:
            print(f'{title} ({len(items)}):\n  ' + '\n  '.join(items))
    print('OK' if not r.errors else 'NOT OK')
    return 1 if r.errors else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
