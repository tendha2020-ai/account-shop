# make_samples.py: runs the worker pipeline once, end to end, outside the Space.
# Used by the samples test workflow: python make_samples.py <source> <clips> <out_dir>
#   source = "commons:<search words>" (a free-licensed Wikimedia Commons video), "surprise", or a link.

import json
import os
import shutil
import sys
import time

import requests

import worker

UA = {'User-Agent': 'AnimalAnticsSamples/1.0 (https://github.com/tendha2020-ai/account-shop)'}


def commons_video(words):
    """A short free-licensed animal video from Wikimedia Commons, with its credit line."""
    res = requests.get('https://commons.wikimedia.org/w/api.php', headers=UA, timeout=30, params={
        'action': 'query', 'format': 'json', 'generator': 'search', 'gsrnamespace': 6, 'gsrlimit': 20,
        'gsrsearch': f'{words} filetype:video', 'prop': 'imageinfo',
        'iiprop': 'url|size|mime|extmetadata', 'iiextmetadatafilter': 'LicenseShortName|Artist'})
    res.raise_for_status()
    pages = sorted(res.json()['query']['pages'].values(), key=lambda p: p.get('index', 0))
    for page in pages:
        info = page['imageinfo'][0]
        if info['mime'].startswith('video/') and info['size'] < 60_000_000:
            meta = info.get('extmetadata', {})
            credit = f"{page['title']} by {meta.get('Artist', {}).get('value', 'unknown')} " \
                     f"({meta.get('LicenseShortName', {}).get('value', 'see Commons')})"
            return info['url'], credit
    raise RuntimeError(f'No Commons video found for {words}')


def main():
    source, clips, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    os.makedirs(out, exist_ok=True)
    job = {'id': f'sample-{int(time.time())}', 'created': time.time(), 'status': 'working', 'wanted': clips,
           'made': 0, 'captions': True, 'seconds': 5, 'animal': '', 'label': ''}
    credit = ''
    if source == 'surprise':
        job['kind'] = 'surprise'
    elif source.startswith('commons:'):
        url, credit = commons_video(source.split(':', 1)[1])
        job.update(kind='link', url=url)
    else:
        job.update(kind='link', url=source)
    worker.jobs[job['id']] = job
    try:
        worker.process(job)
    except Exception as e:
        job.update(status='failed', error=f'{type(e).__name__}: {e}')
    folder = worker.job_dir(job['id'])
    for name in ['final.mp4', 'thumb.jpg'] + job.get('inputs', []):
        if (folder / name).exists():
            shutil.copy(folder / name, os.path.join(out, name))
    job['credit'] = credit
    with open(os.path.join(out, 'job.json'), 'w') as f:
        json.dump(job, f, indent=1, default=str)
    print(json.dumps({k: job.get(k) for k in ['status', 'label', 'animal', 'made', 'stage', 'error', 'credit']}, indent=1))


if __name__ == '__main__':
    main()
