// Fake TikTok LIVE events for `npm run demo`, so the dashboard, overlay and
// bot rules can be tried without going live.

import { EventEmitter } from 'node:events';

const NAMES = ['luna.dance', 'gamerjoe', 'sk8r_mia', 'chefkai', 'nova_x', 'ben.tok', 'ava_sings', 'max.builds', 'zoe.art', 'leo_live'];
const CHAT = ['hiii 👋', 'love this stream!', 'where are you from?', 'first time here', 'lol 😂', 'this is so cool',
  '!commands', '!discord', '!uptime', '!top', '!join', '!goal', 'what game is this?', '🔥🔥🔥', 'FREE FOLLOWERS at scam.xyz',
  'THIS IS THE BEST STREAM EVER OMG', '1', '2'];
const GIFTS = [
  { giftName: 'Rose', diamonds: 1 }, { giftName: 'TikTok', diamonds: 1 }, { giftName: 'Finger Heart', diamonds: 5 },
  { giftName: 'Doughnut', diamonds: 30 }, { giftName: 'Hand Hearts', diamonds: 100 }, { giftName: 'Galaxy', diamonds: 1000 },
];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const user = () => {
  const n = pick(NAMES);
  return { id: n, username: n, nickname: n.replace(/[._]/g, ' '), avatar: '' };
};

export class Simulator extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle';
    this.detail = '';
    this.username = 'demo';
    this.timer = null;
    this.likes = 0;
    this.viewers = 40;
  }

  setStatus(status, detail = '') {
    this.status = status;
    this.detail = detail;
    this.emit('status', { status, detail, username: this.username });
  }

  canSend() { return false; }
  async sendMessage() { return false; }

  async start(username = 'demo') {
    await this.stop();
    this.username = username || 'demo';
    this.setStatus('connected', 'demo mode — simulated events');
    this.emit('connected', { roomId: 'demo' });
    this.timer = setInterval(() => this.step(), 700);
  }

  step() {
    const r = Math.random();
    if (r < 0.45) this.emit('event', { type: 'chat', user: user(), text: pick(CHAT) });
    else if (r < 0.65) {
      const n = 5 + Math.floor(Math.random() * 60);
      this.likes += n;
      this.emit('event', { type: 'like', user: user(), count: n, total: this.likes });
    } else if (r < 0.75) {
      const g = pick(GIFTS);
      this.emit('event', { type: 'gift', user: user(), giftId: g.giftName, ...g, count: 1 + Math.floor(Math.random() * 5), image: '', streaking: false });
    } else if (r < 0.8) this.emit('event', { type: 'follow', user: user() });
    else if (r < 0.83) this.emit('event', { type: 'share', user: user() });
    else if (r < 0.85) this.emit('event', { type: 'question', user: user(), text: 'What setup do you use?' });
    else {
      this.viewers = Math.max(5, this.viewers + Math.round((Math.random() - 0.4) * 6));
      this.emit('event', { type: 'viewers', count: this.viewers });
      this.emit('event', { type: 'join', user: user() });
    }
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.setStatus('idle', 'Stopped');
  }
}
