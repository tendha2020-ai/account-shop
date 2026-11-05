# update.py: (Setup, v16) easier setup for the Animal Antics worker.
#
# One-tap update: POST /update (owner only) makes the worker update itself, so "Update my worker" on the page needs no
# Hugging Face key. The worker reads the new worker files from antics' own site (SITE: fixed here, never taken from
# the request), checks that the site already has the version the page asked for (worker.py's VERSION line), and
# sends every file to its own Space in ONE commit with the key the Space already holds (HF_TOKEN). Hugging Face then
# builds the new version by itself; the old one keeps answering until it's ready. Nothing is sent unless every file
# was read, and a commit is all or nothing, so an update is never half done.
#
# Reconnect instead of rebuild: owner.json in the private dataset holds this worker's connection key, Space and web
# address, so the page can connect the owner's new phone or computer to it with the owner's own Hugging Face key
# (the dataset is private), instead of making the worker again with a new key. worker.py writes it at the start.
#
# The worker decides which files make up a version: FILES below (the page's WORKER_FILES, the same names), as the NEW
# update.py on the site lists them. The page's list must be that list, or nothing is sent. The site is read in a fixed
# order: worker.py first (the wrong version: 409 at once), then update.py (its FILES), then the rest, then worker.py
# again: if it changed meanwhile (the site was being deployed), nothing is sent. So the files are all of one version.
#
# POST /update body: {files: [names], version: '16', force: false}. Answers {ok: true, commit, version, files}, or
# {ok: true, already: true, commit: '', version, files: []} when the worker already is that version (nothing sent), or
# {detail: <plain message for the page>, reason} with status 400 (reason 'bad'), 409 ('busy': a video is being made,
# send force: true to update anyway; 'not_on_site': the site doesn't have that version yet; 'files': the page and
# the site don't list the same files; 'site_changed': the site changed while it was read; 'updating': an update is
# already on its way), 502 ('site': a file couldn't be read from the site; 'hub': Hugging Face didn't take the
# commit) or 503 ('unavailable': this worker can't update itself, e.g. it isn't running on a Space).
# POST /update/restart (no body): the factory restart the page asks for once when Hugging Face hasn't started building
# the new version after 3 minutes (the page has no key to ask Hugging Face itself). Only while a version this worker
# sent (POST /update) isn't running yet. {ok: true}, or 409 ('nothing_sent'), 429 ('too_soon': at most once every 2
# minutes), 502 ('hub'), 503 ('unavailable'). Both are listed as the 'selfupdate' feature.

import ast
import json
import os
import re
import secrets

import requests

SITE = 'https://tendha2020-ai.github.io/account-shop/animals/worker/'
# Tests only: ANTICS_TEST_SITE can point the update at a copy of the site on this machine (http://127.0.0.1 or
# localhost, nothing else); any other value is ignored and SITE is used.
# (every pattern here is used with fullmatch: a trailing newline doesn't pass)
TEST_SITE = re.compile(r'http://(127\.0\.0\.1|localhost):[0-9]{1,5}/([A-Za-z0-9_-][A-Za-z0-9_.-]*/)*')
NAME = re.compile(r'[A-Za-z0-9_.-]{1,40}')  # a worker file: no folders
VERSION = re.compile(r'[0-9]{1,4}(\.[0-9]{1,4})?')
SPACE = re.compile(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+')  # a Space id: owner/name
HOST = re.compile(r'[A-Za-z0-9.-]+(:[0-9]{1,5})?')  # a web address's host (SPACE_HOST)
MAX_FILES = 40
MAX_FILE_BYTES = 2_000_000  # each file (worker.py is about 0.2 MB)
MAX_TOTAL_BYTES = 16_000_000
FETCH_TIMEOUT = 20  # seconds for each file
MAIN = 'worker.py'  # the file that says which version the site has
MANIFEST = 'update.py'  # the file whose FILES says which files make up that version
# The worker files of this version: the page's WORKER_FILES (app.js), the same names. A new version that adds or drops
# a worker file changes both lists; the one-tap update reads this list from the new update.py on the site (never
# running it) and sends exactly those files.
FILES = ('Dockerfile', 'README.md', 'requirements.txt', 'worker.py', 'ideas.py', 'beats.py', 'meme.py', 'sfx.py',
         'voice.py', 'webpush.py', 'chorus.py', 'posting.py', 'gpu.py', 'together.py', 'library.json', 'sing.py',
         'sing_audio.py', 'update.py')

NOT_ON_SITE = "The new version isn't on the site yet. Try again in a few minutes."
FILES_DIFFER = ("This page and the antics site don't list the same worker files. Nothing was changed. Reload the page "
                'and try again.')
SITE_CHANGED = ('The antics site changed while your worker was reading it. Nothing was changed. Try again in a '
                'minute.')
BUSY = ('A video is being made right now. Update when it is done, or tap Update my worker again to update anyway '
        '(it starts that video again).')


class UpdateError(Exception):
    """Why an update didn't happen: the HTTP status, a plain message for the page, and a short reason."""

    def __init__(self, status, message, reason):
        super().__init__(message)
        self.status, self.message, self.reason = status, message, reason

    def body(self):
        return {'detail': self.message, 'reason': self.reason}


def site():
    """Where the files come from: SITE (or, in tests, a local copy of the site given by ANTICS_TEST_SITE)."""
    test = os.environ.get('ANTICS_TEST_SITE', '')
    return test if test and TEST_SITE.fullmatch(test) else SITE


def check_request(body):
    """(names, version, force) from the request body, or UpdateError 400."""
    if not isinstance(body, dict):
        raise UpdateError(400, 'Send the worker files and the version.', 'bad')
    names, version, force = body.get('files'), body.get('version'), body.get('force', False)
    if not isinstance(names, list) or not names or not all(isinstance(n, str) for n in names):
        raise UpdateError(400, 'Send the names of the worker files.', 'bad')
    if len(names) > MAX_FILES:
        raise UpdateError(400, f'At most {MAX_FILES} worker files.', 'bad')
    bad = [n for n in names if not NAME.fullmatch(n) or n.startswith('.')]  # (no folders, no hidden files, no . or ..)
    if bad:
        raise UpdateError(400, f'Not a worker file name: {bad[0][:60]}', 'bad')
    if len(set(names)) != len(names):
        raise UpdateError(400, 'A worker file is named twice.', 'bad')
    if MAIN not in names:
        raise UpdateError(400, f'The files must include {MAIN}.', 'bad')
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise UpdateError(400, 'Send the version to update to (like 16).', 'bad')
    if not isinstance(force, bool):
        raise UpdateError(400, 'force is true or false.', 'bad')
    return names, version, force


def fetch(name, base, get=None):
    """One file from the site, as bytes (at most MAX_FILE_BYTES). UpdateError 502 when it can't be read."""
    get = get or requests.get
    url = f'{base}{name}?fresh={secrets.token_hex(6)}'  # (past the site's cache: every file of the same moment)
    try:
        res = get(url, timeout=FETCH_TIMEOUT, stream=True, allow_redirects=False,
                  headers={'Cache-Control': 'no-cache', 'User-Agent': 'antics-worker'})
    except requests.RequestException as e:
        raise UpdateError(502, f"Couldn't reach the antics site ({type(e).__name__}). Nothing was changed. "
                               'Try again in a few minutes.', 'site')
    try:
        if res.status_code != 200:
            raise UpdateError(502, f"Couldn't read {name} from the antics site ({res.status_code}). Nothing was "
                                   'changed. Try again in a few minutes.', 'site')
        data = bytearray()
        try:
            for chunk in res.iter_content(65536):
                data += chunk
                if len(data) > MAX_FILE_BYTES:
                    raise UpdateError(502, f'{name} on the antics site is too big. Nothing was changed.', 'site')
        except requests.RequestException as e:
            raise UpdateError(502, f"Couldn't read {name} from the antics site ({type(e).__name__}). Nothing was "
                                   'changed. Try again in a few minutes.', 'site')
        return bytes(data)
    finally:
        res.close()


def has_version(text, version):
    """worker.py says it is that version (its VERSION = '16' line)."""
    return re.search(r"^VERSION = '" + re.escape(version) + r"'", text, re.M) is not None


def files_of(text):
    """The FILES of an update.py (its text, as read from the site), read without running it; None when it has none."""
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return None
    for node in tree.body:
        if (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id == 'FILES'):
            try:
                value = ast.literal_eval(node.value)
            except (ValueError, TypeError, SyntaxError, RecursionError, MemoryError):
                return None
            if isinstance(value, (tuple, list)) and value and all(isinstance(n, str) for n in value):
                return tuple(value)
            return None
    return None


def fetch_all(names, version, base=None, get=None):
    """Every file of that version, read before anything is sent: {name: bytes}, in the order asked. worker.py comes
    first (another version: 409 'not_on_site' at once, nothing else read), then update.py, whose FILES must be the
    names asked for (else 409 'files'), then the others, then worker.py once more: changed (a deploy of the site
    landed meanwhile): 409 'site_changed'. 502 'site' when a file can't be read or they're too big together."""
    base = base or site()
    first = fetch(MAIN, base, get)
    if not has_version(first.decode('utf-8', 'replace'), version):
        raise UpdateError(409, NOT_ON_SITE, 'not_on_site')
    files, total = {MAIN: first}, len(first)

    def add(name):
        nonlocal total
        files[name] = fetch(name, base, get)
        total += len(files[name])
        if total > MAX_TOTAL_BYTES:
            raise UpdateError(502, 'The worker files on the antics site are too big. Nothing was changed.', 'site')

    if MANIFEST in names:
        add(MANIFEST)
    listed = files_of(files[MANIFEST].decode('utf-8', 'replace')) if MANIFEST in files else None
    if not listed or len(set(listed)) != len(listed) or set(listed) != set(names):
        raise UpdateError(409, FILES_DIFFER, 'files')
    for name in names:
        if name not in files:
            add(name)
    if fetch(MAIN, base, get) != first:
        raise UpdateError(409, SITE_CHANGED, 'site_changed')
    return {name: files[name] for name in names}


def commit(space, token, files, version, api=None):
    """All the files to the Space in one commit (all or nothing). Its commit id; UpdateError 502 when it fails."""
    from huggingface_hub import CommitOperationAdd, HfApi
    try:
        api = api or HfApi(token=token)
        ops = [CommitOperationAdd(path_in_repo=name, path_or_fileobj=data) for name, data in files.items()]
        info = api.create_commit(repo_id=space, repo_type='space', operations=ops,
                                 commit_message=f'Update the Animal Antics worker to version {version}')
    except Exception as e:
        raise UpdateError(502, f"Hugging Face didn't take the new version ({str(e)[:160] or type(e).__name__}). "
                               'Nothing was changed. Try again in a few minutes.', 'hub')
    return str(getattr(info, 'oid', None) or getattr(info, 'commit_url', None) or '')


def restart(space, token, api=None):
    """Asks Hugging Face to build the Space again from its files (a factory restart): for when the new version was
    sent but Hugging Face hasn't started building it after a few minutes. UpdateError 502 when it fails."""
    from huggingface_hub import HfApi
    try:
        api = api or HfApi(token=token)
        api.restart_space(space, factory_reboot=True)
    except Exception as e:
        raise UpdateError(502, f"Hugging Face didn't restart your worker ({str(e)[:160] or type(e).__name__}). "
                               'Try again in a minute.', 'hub')


def can_update(space, token):
    """This worker can update itself: it runs on a Space and holds a key."""
    return bool(space and token and SPACE.fullmatch(space))


# ---------- owner.json ----------
OWNER_FILE = 'owner.json'


def owner_record(key, space, host):
    """What owner.json holds, or None when one of them is empty (it is never saved with empty values)."""
    key, space, host = (str(x or '').strip() for x in (key, space, host))
    if not key or not can_update(space, 'x') or not HOST.fullmatch(host):
        return None
    return {'v': 1, 'key': key, 'space': space, 'url': 'https://' + host}


def owner_differs(text, record):
    """owner.json (its text in the dataset, None when it isn't there) isn't the record."""
    if text is None:
        return True
    try:
        return json.loads(text) != record
    except (ValueError, TypeError):
        return True
