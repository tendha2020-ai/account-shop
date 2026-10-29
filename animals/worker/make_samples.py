# make_samples.py: runs the worker pipeline once, end to end, outside the Space.
# Used by the samples test workflow: python make_samples.py <source> <clips> <out_dir>
#   source = "commons:<animal>" (a free-licensed Wikimedia Commons video), "surprise", or a link.

import json
import os
import random
import re
import shutil
import sys
import time

import requests

import worker

API = 'https://commons.wikimedia.org/w/api.php'
UA = {'User-Agent': 'AnimalAnticsSamples/1.0 (https://github.com/tendha2020-ai/account-shop)'}


def commons_files(params):
    res = requests.get(API, headers=UA, timeout=30, params={
        'action': 'query', 'format': 'json', 'prop': 'imageinfo',
        'iiprop': 'url|size|mime|extmetadata', 'iiextmetadatafilter': 'LicenseShortName|Artist', **params})
    res.raise_for_status()
    pages = res.json().get('query', {}).get('pages', {}).values()
    return [p for p in pages if p.get('imageinfo') and p['imageinfo'][0]['mime'].startswith('video/')
            and 500_000 < p['imageinfo'][0]['size'] < 40_000_000
            and not re.search(r'cgi|animat|cartoon|render', p['title'], re.I)]


def commons_video(animal, folder):
    """Downloads a random short free-licensed video of the animal. Returns (path, credit, artist)."""
    files = commons_files({'generator': 'categorymembers', 'gcmtitle': f'Category:Videos of {animal}s',
                           'gcmtype': 'file', 'gcmlimit': 200})
    if not files:
        files = commons_files({'generator': 'search', 'gsrnamespace': 6, 'gsrlimit': 50,
                               'gsrsearch': f'{animal} filetype:video'})
    page = random.choice(files)
    info = page['imageinfo'][0]
    meta = info.get('extmetadata', {})
    artist = re.sub(r'<[^>]+>', '', meta.get('Artist', {}).get('value', 'unknown')).strip()
    credit = f"{page['title']} by {artist} ({meta.get('LicenseShortName', {}).get('value', 'see Commons')})"
    path = folder / ('source' + os.path.splitext(info['url'].split('?')[0])[1])
    with requests.get(info['url'], headers=UA, timeout=120, stream=True) as res:
        res.raise_for_status()
        with open(path, 'wb') as f:
            for chunk in res.iter_content(1 << 20):
                f.write(chunk)
    return path, credit, artist


def main():
    source, clips, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    os.makedirs(out, exist_ok=True)
    job = {'id': f'sample-{int(time.time())}', 'created': time.time(), 'status': 'working', 'wanted': clips,
           'made': 0, 'captions': True, 'seconds': 5, 'animal': '', 'label': ''}
    worker.jobs[job['id']] = job
    folder = worker.job_dir(job['id'])
    credit = ''
    try:
        if source == 'surprise':
            job['kind'] = 'surprise'
        elif source.startswith('commons:'):
            animal = source.split(':', 1)[1]
            path, credit, artist = commons_video(animal, folder)
            job.update(kind='images', inputs=worker.pick_frames(path, clips, folder), animal=animal,
                       label=f'Wikimedia Commons · {artist}'[:80])
        else:
            job.update(kind='link', url=source)
        worker.process(job)
    except Exception as e:
        job.update(status='failed', error=f'{type(e).__name__}: {e}')
    for name in ['final.mp4', 'thumb.jpg'] + job.get('inputs', []):
        if (folder / name).exists():
            shutil.copy(folder / name, os.path.join(out, name))
    job['credit'] = credit
    with open(os.path.join(out, 'job.json'), 'w') as f:
        json.dump(job, f, indent=1, default=str)
    print(json.dumps({k: job.get(k) for k in ['status', 'label', 'animal', 'made', 'stage', 'error', 'credit']}, indent=1))


if __name__ == '__main__':
    main()
