# webpush.py: "your video is ready" notifications for antics, with nothing but `cryptography` + `requests`.
#
# Web Push = the browser gives the page a subscription (an https endpoint on Google/Apple/Mozilla/Microsoft
# push servers + two keys). The worker encrypts a small JSON message for that browser (RFC 8291, aes128gcm),
# signs a VAPID token with its own key (RFC 8292) and POSTs it to the endpoint. The push server wakes the
# phone, the page's service worker decrypts it and shows the notification. Free on every platform.

import base64
import json
import os
import struct
import time
from urllib.parse import urlsplit

import requests
from cryptography.hazmat.primitives import hashes, hmac, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

RECORD_SIZE = 4096  # one record; push services accept at most 4096 bytes of body anyway
MAX_PAYLOAD = 3000  # stay well under the 4 KB limit of FCM / APNs / autopush


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def new_vapid_key() -> str:
    """A fresh VAPID private key (base64url of the 32-byte secret). Keep it private, keep it forever."""
    key = ec.generate_private_key(ec.SECP256R1())
    return b64u(key.private_numbers().private_value.to_bytes(32, 'big'))


def _key(private_b64: str):
    return ec.derive_private_key(int.from_bytes(unb64u(private_b64), 'big'), ec.SECP256R1())


def _point(public) -> bytes:
    return public.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def public_key(private_b64: str) -> str:
    """The applicationServerKey the page passes to pushManager.subscribe() (65-byte point, base64url)."""
    return b64u(_point(_key(private_b64).public_key()))


def check_keys(p256dh: str, auth: str):
    """The browser's two subscription keys, or ValueError: a P-256 point (65 bytes) and a 16-byte secret."""
    ua_public, auth_secret = unb64u(p256dh), unb64u(auth)
    if len(ua_public) != 65 or len(auth_secret) != 16:
        raise ValueError('bad subscription keys')
    return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public), ua_public, auth_secret


def _hmac(key: bytes, data: bytes) -> bytes:
    h = hmac.HMAC(key, hashes.SHA256())
    h.update(data)
    return h.finalize()


def encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    """RFC 8291 message encryption: one aes128gcm record (RFC 8188) keyed for this browser."""
    ua_key, ua_public, auth_secret = check_keys(p256dh, auth)
    if len(payload) > MAX_PAYLOAD:
        raise ValueError('notification too big')
    as_key = ec.generate_private_key(ec.SECP256R1())  # a new key for every message
    as_public = _point(as_key.public_key())
    shared = as_key.exchange(ec.ECDH(), ua_key)
    # HKDF-SHA256 written out: extract with the auth secret, then with a random salt.
    ikm = _hmac(_hmac(auth_secret, shared), b'WebPush: info\x00' + ua_public + as_public + b'\x01')
    salt = os.urandom(16)
    prk = _hmac(salt, ikm)
    cek = _hmac(prk, b'Content-Encoding: aes128gcm\x00\x01')[:16]
    nonce = _hmac(prk, b'Content-Encoding: nonce\x00\x01')[:12]
    sealed = AESGCM(cek).encrypt(nonce, payload + b'\x02', None)  # 0x02 = last (only) record
    return salt + struct.pack('!IB', RECORD_SIZE, len(as_public)) + as_public + sealed


_tokens = {}  # (key, push service, subject) -> (header, made). Apple asks not to renew a token more than hourly.


def vapid_header(endpoint: str, private_b64: str, subject: str, now=None) -> str:
    """Authorization header proving the message comes from this worker (RFC 8292, ES256 JWT).
    A token is valid 12 h and reused for 6 h per push service."""
    url = urlsplit(endpoint)
    aud = f'{url.scheme}://{url.netloc}'
    now = int(now or time.time())
    cached = _tokens.get((private_b64, aud, subject))
    if cached and 0 <= now - cached[1] < 6 * 3600:
        return cached[0]
    claims = {'aud': aud, 'exp': now + 12 * 3600, 'sub': subject}
    part = lambda obj: b64u(json.dumps(obj, separators=(',', ':')).encode())  # noqa: E731
    signing_input = f"{part({'typ': 'JWT', 'alg': 'ES256'})}.{part(claims)}"
    r, s = decode_dss_signature(_key(private_b64).sign(signing_input.encode(), ec.ECDSA(hashes.SHA256())))
    token = f'{signing_input}.{b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))}'
    header = f'vapid t={token}, k={public_key(private_b64)}'
    _tokens[(private_b64, aud, subject)] = (header, now)
    return header


def send(subscription: dict, message: dict, private_b64: str, subject: str, ttl=86400, topic='', timeout=10):
    """POST one notification. 201 = the push service took it; 404/410 = the subscription is gone."""
    body = encrypt(json.dumps(message, separators=(',', ':')).encode(),
                   subscription['keys']['p256dh'], subscription['keys']['auth'])
    headers = {
        'Authorization': vapid_header(subscription['endpoint'], private_b64, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': str(ttl),  # keep it this long if the phone is off
        'Urgency': 'high',
    }
    if topic:  # a newer message with the same topic replaces one that wasn't delivered yet
        headers['Topic'] = topic[:32]
    # (never follow a redirect: the worker only POSTs to the push service it checked)
    return requests.post(subscription['endpoint'], data=body, headers=headers, timeout=timeout, allow_redirects=False)
