// Connects to a TikTok LIVE room, normalizes its events, and keeps the
// connection alive: waits for the stream to start and reconnects on drops.

import { EventEmitter } from 'node:events';
import { TikTokLiveConnection, WebcastEvent, ControlEvent, UserOfflineError } from 'tiktok-live-connector';
import * as N from './normalize.js';

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

export class TikTokLink extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.conn = null;
    this.status = 'idle'; // idle | waiting | connecting | connected | error
    this.detail = '';
    this.username = '';
    this.abort = null;
  }

  setStatus(status, detail = '') {
    this.status = status;
    this.detail = detail;
    this.emit('status', { status, detail, username: this.username });
  }

  buildOptions() {
    const send = this.config.sendToTikTokChat || {};
    const opts = { enableExtendedGiftInfo: true };
    const apiKey = process.env.EULER_API_KEY || send.signApiKey;
    if (apiKey) opts.signApiKey = apiKey;
    const sessionId = process.env.TIKTOK_SESSION_ID || send.sessionId;
    const ttTargetIdc = process.env.TIKTOK_TARGET_IDC || send.ttTargetIdc;
    if (send.enabled && sessionId && ttTargetIdc) {
      opts.authenticateWs = true;
      opts.session = { cookie: { type: 'cookie', value: { sessionId, ttTargetIdc } } };
    }
    return opts;
  }

  canSend() {
    const send = this.config.sendToTikTokChat || {};
    return Boolean(send.enabled && this.conn?.isConnected &&
      (process.env.EULER_API_KEY || send.signApiKey) &&
      (process.env.TIKTOK_SESSION_ID || send.sessionId));
  }

  async sendMessage(text) {
    if (!this.canSend()) return false;
    await this.conn.sendMessage(text);
    return true;
  }

  // Runs until stop(): connect, and after a drop wait and connect again.
  async start(username) {
    await this.stop();
    this.username = String(username || '').replace(/^@/, '').trim();
    if (!this.username) throw new Error('No TikTok username set.');
    const abort = new AbortController();
    this.abort = abort;
    const c = this.config.connection || {};
    this.loop(abort.signal, c).catch((err) => this.setStatus('error', err.message));
  }

  async loop(signal, c) {
    while (!signal.aborted) {
      const conn = new TikTokLiveConnection(this.username, this.buildOptions());
      this.conn = conn;
      this.wire(conn);
      const closed = new Promise((resolve) => conn.once(ControlEvent.DISCONNECTED, resolve));
      try {
        this.setStatus('connecting');
        const state = await conn.connect();
        if (signal.aborted) { // stop() or a new start() ran while connecting
          await conn.disconnect().catch(() => {});
          break;
        }
        this.setStatus('connected', `room ${state.roomId}`);
        this.emit('connected', state);
        await Promise.race([closed, new Promise((r) => signal.addEventListener('abort', r, { once: true }))]);
        if (signal.aborted) break;
        this.emit('disconnected');
      } catch (err) {
        if (signal.aborted) break;
        const offline = err instanceof UserOfflineError || /offline|not.*live|isn't online/i.test(`${err?.name} ${err?.message}`);
        this.setStatus(offline ? 'waiting' : 'error', offline ? `@${this.username} is not live yet` : String(err?.message || err));
        conn.disconnect().catch(() => {});
        if (c.autoReconnect === false) break;
        await sleep((offline ? (c.waitForLiveSeconds ?? 60) : (c.reconnectDelaySeconds ?? 15)) * 1000, signal);
        continue;
      }
      if (c.autoReconnect === false) break;
      this.setStatus('waiting', 'Disconnected — reconnecting soon');
      await sleep((c.reconnectDelaySeconds ?? 15) * 1000, signal);
    }
    if (!signal.aborted) this.setStatus('idle', 'Stopped');
  }

  wire(conn) {
    const pass = (event, fn) => conn.on(event, (d) => {
      try { this.emit('event', fn(d)); } catch (err) { this.emit('warn', `bad ${event} payload: ${err.message}`); }
    });
    pass(WebcastEvent.CHAT, N.chat);
    pass(WebcastEvent.GIFT, N.gift);
    pass(WebcastEvent.LIKE, N.like);
    pass(WebcastEvent.FOLLOW, N.simple('follow'));
    pass(WebcastEvent.SHARE, N.simple('share'));
    pass(WebcastEvent.MEMBER, N.simple('join'));
    pass(WebcastEvent.ROOM_USER, N.viewers);
    pass(WebcastEvent.QUESTION_NEW, N.question);
    conn.on(WebcastEvent.STREAM_END, () => this.emit('streamEnd'));
    conn.on(ControlEvent.ERROR, (e) => this.emit('warn', e?.info || e?.exception?.message || 'connection error'));
  }

  async stop() {
    this.abort?.abort();
    this.abort = null;
    const conn = this.conn;
    this.conn = null;
    if (conn) await conn.disconnect().catch(() => {});
    this.setStatus('idle', 'Stopped');
  }
}
