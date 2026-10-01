// The stream manager: everything the bot decides lives here, independent of
// TikTok and the web server so it can be driven by the simulator and tests.
//
// Input:  bot.handle(normalizedEvent), bot.tick(), dashboard actions.
// Output: events 'feed' (dashboard log), 'alert' (overlay pop-up),
//         'say' (bot message for overlay/TTS/TikTok chat), 'change' (state dirty).

import { EventEmitter } from 'node:events';

const MINUTE = 60_000;

export function fill(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LINK_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|net|org|gg|ly|io|me|xyz|link|shop)\b/i;

export class Bot extends EventEmitter {
  constructor(config, { now = () => Date.now() } = {}) {
    super();
    this.config = config;
    this.now = now;
    this.settings = {
      autoThanks: true,
      welcome: true,
      moderation: config.moderation?.enabled !== false,
      timers: true,
      commands: true,
    };
    this.goals = {
      likes: config.goals?.likes || 0,
      diamonds: config.goals?.diamonds || 0,
      follows: config.goals?.follows || 0,
    };
    this.resetSession();
  }

  resetSession() {
    const t = this.now();
    this.startedAt = t;
    this.stats = { viewers: 0, peakViewers: 0, likes: 0, diamonds: 0, follows: 0, shares: 0, chats: 0, gifts: 0, joins: 0 };
    this.gifters = new Map(); // username -> { user, diamonds, gifts }
    this.chatters = new Map(); // username -> { user, messages }
    this.seen = new Set(); // usernames that have chatted this session
    this.goalsHit = new Set();
    this.nextLikeMilestone = this.config.likeMilestone || 0;
    this.history = new Map(); // username -> [{ text, ts }]
    this.strikes = new Map();
    this.muted = new Map(); // username -> until ts
    this.cooldowns = new Map();
    this.lastWelcome = 0;
    this.queue = [];
    this.poll = null;
    this.questions = [];
    this.chatSinceTimer = 0;
    this.timerState = (this.config.timers || []).map(() => ({ last: t }));
    this.feedId = 0;
    this.changed();
  }

  changed() {
    this.emit('change');
  }

  // ---- input ---------------------------------------------------------------

  handle(ev) {
    switch (ev.type) {
      case 'chat': return this.onChat(ev);
      case 'gift': return this.onGift(ev);
      case 'like': return this.onLike(ev);
      case 'follow': return this.onFollow(ev);
      case 'share': return this.onShare(ev);
      case 'join': return this.onJoin(ev);
      case 'viewers': return this.onViewers(ev);
      case 'question': return this.onQuestion(ev);
      default: return undefined;
    }
  }

  onChat({ user, text }) {
    const s = this.stats;
    s.chats++;
    const mod = this.moderate(user, text);
    const item = this.feed('chat', user, text, mod);
    const c = this.chatters.get(user.username) || { user, messages: 0 };
    c.messages++;
    this.chatters.set(user.username, c);

    if (mod.hidden) {
      this.changed();
      return item;
    }
    this.chatSinceTimer++;

    if (!this.seen.has(user.username)) {
      this.seen.add(user.username);
      if (this.settings.welcome && this.config.welcome?.firstChat) this.welcome(user);
    }

    const trimmed = text.trim();
    if (this.poll && this.vote(user, trimmed)) {
      this.changed();
      return item;
    }
    const prefix = this.config.commandPrefix || '!';
    if (this.settings.commands && trimmed.startsWith(prefix)) this.command(user, trimmed.slice(prefix.length));
    this.changed();
    return item;
  }

  onGift(ev) {
    if (ev.streaking) return null; // wait for the end of the streak
    const total = ev.diamonds * ev.count;
    this.stats.gifts += ev.count;
    this.stats.diamonds += total;
    const g = this.gifters.get(ev.user.username) || { user: ev.user, diamonds: 0, gifts: 0 };
    g.diamonds += total;
    g.gifts += ev.count;
    this.gifters.set(ev.user.username, g);

    const vars = { user: ev.user.nickname, gift: ev.giftName, count: ev.count, diamonds: total };
    const rule = (this.config.giftRules || []).find((r) =>
      (r.gift ? r.gift.toLowerCase() === ev.giftName.toLowerCase() : true) &&
      (r.minDiamonds ? total >= r.minDiamonds : true));
    const message = fill(rule?.message || this.config.thanks?.gift, vars);

    this.feed('gift', ev.user, `${ev.giftName} x${ev.count} (${total} 💎)`);
    this.alert('gift', ev.user, `${ev.user.nickname} sent ${ev.giftName} x${ev.count}`, message, ev.image);
    if (this.settings.autoThanks && total >= (this.config.thanks?.giftMinDiamonds ?? 1)) this.say(message, 'thanks');
    this.checkGoals();
    this.changed();
    return message;
  }

  onLike({ user, count, total }) {
    this.stats.likes = Math.max(this.stats.likes + count, total || 0);
    const step = this.config.likeMilestone;
    if (step && this.stats.likes >= this.nextLikeMilestone) {
      const reached = Math.floor(this.stats.likes / step) * step;
      this.nextLikeMilestone = reached + step;
      const msg = fill(this.config.likeMilestoneMessage, { total: reached.toLocaleString('en-US') });
      this.alert('likes', user, `${reached.toLocaleString('en-US')} likes!`, msg);
      this.say(msg, 'milestone');
    }
    this.checkGoals();
    this.changed();
  }

  onFollow({ user }) {
    this.stats.follows++;
    const msg = fill(this.config.thanks?.follow, { user: user.nickname });
    this.feed('follow', user, 'followed');
    this.alert('follow', user, `${user.nickname} followed!`, msg);
    if (this.settings.autoThanks) this.say(msg, 'thanks');
    this.checkGoals();
    this.changed();
  }

  onShare({ user }) {
    this.stats.shares++;
    const msg = fill(this.config.thanks?.share, { user: user.nickname });
    this.feed('share', user, 'shared the live');
    this.alert('share', user, `${user.nickname} shared the live!`, msg);
    if (this.settings.autoThanks) this.say(msg, 'thanks');
    this.changed();
  }

  onJoin({ user }) {
    this.stats.joins++;
    if (this.settings.welcome && this.config.welcome?.onJoin) this.welcome(user);
    this.changed();
  }

  onViewers({ count }) {
    this.stats.viewers = count;
    this.stats.peakViewers = Math.max(this.stats.peakViewers, count);
    this.changed();
  }

  onQuestion({ user, text }) {
    this.questions.push({ id: ++this.feedId, user, text, ts: this.now() });
    if (this.questions.length > 50) this.questions.shift();
    this.feed('question', user, text);
    this.changed();
  }

  // ---- moderation ----------------------------------------------------------

  moderate(user, text) {
    const cfg = this.config.moderation || {};
    const t = this.now();
    const name = user.username;
    const hist = (this.history.get(name) || []).filter((h) => t - h.ts < 30_000);
    hist.push({ text: text.toLowerCase().trim(), ts: t });
    this.history.set(name, hist);

    const until = this.muted.get(name);
    if (until && until > t) return { hidden: true, reason: 'muted' };
    if (until) this.muted.delete(name);
    if (!this.settings.moderation || (cfg.trustedUsers || []).includes(name)) return { hidden: false };

    const reason = this.violation(text, hist, t, cfg);
    if (!reason) return { hidden: false };

    const strikes = (this.strikes.get(name) || 0) + 1;
    this.strikes.set(name, strikes);
    const limit = cfg.strikesBeforeMute || 3;
    if (strikes >= limit) {
      this.mute(name, cfg.muteMinutes || 10);
      this.strikes.set(name, 0);
      this.say(`${user.nickname} has been muted for ${cfg.muteMinutes || 10} min.`, 'moderation');
    } else if (cfg.warnMessage) {
      this.say(fill(cfg.warnMessage, { user: user.nickname, reason }), 'moderation');
    }
    return { hidden: true, reason };
  }

  violation(text, hist, t, cfg) {
    const lower = text.toLowerCase();
    for (const word of cfg.bannedWords || []) {
      if (word && new RegExp(`(^|\\W)${escapeRegex(word.toLowerCase())}($|\\W)`).test(lower)) return 'banned word';
    }
    if (cfg.blockLinks && LINK_RE.test(text)) return 'links';
    const letters = text.replace(/[^a-zA-Z]/g, '');
    if (cfg.maxCapsRatio && letters.length >= 10) {
      const caps = letters.replace(/[^A-Z]/g, '').length / letters.length;
      if (caps > cfg.maxCapsRatio) return 'too many caps';
    }
    const last = hist[hist.length - 1].text;
    if (cfg.repeatLimit && hist.filter((h) => h.text === last).length >= cfg.repeatLimit) return 'repeating';
    if (cfg.floodMessagesPer10s && hist.filter((h) => t - h.ts < 10_000).length > cfg.floodMessagesPer10s) return 'flooding';
    return null;
  }

  mute(username, minutes) {
    this.muted.set(username, this.now() + minutes * MINUTE);
    this.changed();
  }

  unmute(username) {
    this.muted.delete(username);
    this.strikes.delete(username);
    this.changed();
  }

  // ---- commands ------------------------------------------------------------

  command(user, body) {
    const [rawName, ...args] = body.split(/\s+/);
    const name = (rawName || '').toLowerCase();
    if (!name) return null;
    const t = this.now();
    const builtins = {
      commands: () => {
        const custom = Object.keys(this.config.commands || {});
        const p = this.config.commandPrefix || '!';
        return `Commands: ${[...custom, 'uptime', 'top', 'goal', 'join', 'leave', 'queue'].map((c) => p + c).join(' ')}`;
      },
      uptime: () => `Live for ${formatDuration(t - this.startedAt)}.`,
      top: () => {
        const top = this.topGifters(3);
        return top.length
          ? `Top gifters: ${top.map((g, i) => `${i + 1}. ${g.user.nickname} (${g.diamonds}💎)`).join(' ')}`
          : 'No gifts yet — be the first! 🎁';
      },
      goal: () => this.goalText(),
      join: () => this.queueJoin(user),
      leave: () => this.queueLeave(user),
      queue: () => (this.queue.length
        ? `Queue (${this.queue.length}): ${this.queue.slice(0, 5).map((q) => q.nickname).join(', ')}${this.queue.length > 5 ? '…' : ''}`
        : 'The queue is empty. Type !join to get in.'),
    };
    const custom = this.config.commands?.[name];
    if (!custom && !builtins[name]) return null;

    // Queue commands are per-user actions, so only the per-user cooldown applies.
    const perUserOnly = name === 'join' || name === 'leave';
    const gKey = `cmd:${name}`;
    const uKey = `user:${user.username}:${name}`;
    if (!perUserOnly && (this.cooldowns.get(gKey) || 0) > t) return null;
    if ((this.cooldowns.get(uKey) || 0) > t) return null;
    if (!perUserOnly) this.cooldowns.set(gKey, t + (this.config.commandCooldownSeconds ?? 10) * 1000);
    this.cooldowns.set(uKey, t + (this.config.userCooldownSeconds ?? 20) * 1000);

    const reply = custom ? fill(custom, { user: user.nickname, args: args.join(' ') }) : builtins[name]();
    if (reply) this.say(reply, 'command');
    return reply;
  }

  // ---- viewer queue --------------------------------------------------------

  queueJoin(user) {
    if (this.queue.some((q) => q.username === user.username)) {
      return `${user.nickname}, you're already #${this.queue.findIndex((q) => q.username === user.username) + 1} in the queue.`;
    }
    this.queue.push(user);
    return `${user.nickname} joined the queue (#${this.queue.length}).`;
  }

  queueLeave(user) {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.username !== user.username);
    return before !== this.queue.length ? `${user.nickname} left the queue.` : null;
  }

  queueNext() {
    const next = this.queue.shift();
    if (next) {
      this.say(`Up next: ${next.nickname}! 🎮`, 'queue');
      this.alert('queue', next, `Up next: ${next.nickname}`, '');
    }
    this.changed();
    return next;
  }

  queueRemove(username) {
    this.queue = this.queue.filter((q) => q.username !== username);
    this.changed();
  }

  queueClear() {
    this.queue = [];
    this.changed();
  }

  // ---- polls ---------------------------------------------------------------

  startPoll(question, options, seconds = 60) {
    const opts = options.map((o) => String(o).trim()).filter(Boolean).slice(0, 6);
    if (!question || opts.length < 2) throw new Error('A poll needs a question and at least 2 options.');
    this.poll = {
      question,
      options: opts,
      votes: new Map(), // username -> option index
      endsAt: this.now() + seconds * 1000,
    };
    this.say(`📊 POLL: ${question} — type ${opts.map((o, i) => `${i + 1} for ${o}`).join(', ')}`, 'poll');
    this.changed();
  }

  vote(user, text) {
    const p = this.poll;
    if (!p) return false;
    let idx = /^\d$/.test(text) ? Number(text) - 1 : p.options.findIndex((o) => o.toLowerCase() === text.toLowerCase());
    if (idx < 0 || idx >= p.options.length) return false;
    if (p.votes.has(user.username)) return true; // first vote counts
    p.votes.set(user.username, idx);
    return true;
  }

  pollResults() {
    const p = this.poll;
    if (!p) return null;
    const counts = p.options.map(() => 0);
    for (const idx of p.votes.values()) counts[idx]++;
    return { question: p.question, options: p.options.map((o, i) => ({ option: o, votes: counts[i] })), total: p.votes.size, endsAt: p.endsAt };
  }

  endPoll() {
    const r = this.pollResults();
    if (!r) return null;
    this.poll = null;
    const best = Math.max(...r.options.map((o) => o.votes));
    const winners = r.options.filter((o) => o.votes === best).map((o) => o.option);
    const msg = r.total === 0
      ? `📊 Poll closed: no votes for "${r.question}".`
      : `📊 Poll result: ${winners.join(' & ')} wins with ${best} vote(s) of ${r.total}!`;
    this.say(msg, 'poll');
    this.alert('poll', null, 'Poll results', msg);
    this.changed();
    return r;
  }

  // ---- goals ---------------------------------------------------------------

  setGoal(kind, target) {
    if (!(kind in this.goals)) return;
    this.goals[kind] = Math.max(0, Number(target) || 0);
    this.goalsHit.delete(kind);
    this.changed();
  }

  checkGoals() {
    for (const [kind, target] of Object.entries(this.goals)) {
      if (!target || this.goalsHit.has(kind) || this.stats[kind] < target) continue;
      this.goalsHit.add(kind);
      const msg = `🎉 ${kind.toUpperCase()} GOAL REACHED: ${target.toLocaleString('en-US')}! Thank you all!`;
      this.alert('goal', null, 'Goal reached!', msg);
      this.say(msg, 'goal');
    }
  }

  goalText() {
    const parts = Object.entries(this.goals)
      .filter(([, target]) => target)
      .map(([kind, target]) => `${kind}: ${Math.min(this.stats[kind], target).toLocaleString('en-US')}/${target.toLocaleString('en-US')}`);
    return parts.length ? `Goals — ${parts.join(' · ')}` : 'No goals set right now.';
  }

  // ---- timers / welcome ----------------------------------------------------

  tick() {
    const t = this.now();
    if (this.poll && t >= this.poll.endsAt) this.endPoll();
    if (!this.settings.timers) return;
    const minLines = this.config.timerMinChatLines ?? 5;
    (this.config.timers || []).forEach((timer, i) => {
      const st = this.timerState[i];
      if (t - st.last < timer.everyMinutes * MINUTE) return;
      // Skip timers while chat is quiet so the bot doesn't talk to itself.
      if (this.chatSinceTimer < minLines) return;
      st.last = t;
      this.chatSinceTimer = 0;
      this.say(timer.message, 'timer');
    });
  }

  welcome(user) {
    const t = this.now();
    const gap = (this.config.welcome?.minSecondsBetween ?? 15) * 1000;
    if (t - this.lastWelcome < gap) return;
    this.lastWelcome = t;
    this.say(fill(this.config.welcome?.message, { user: user.nickname }), 'welcome');
  }

  // ---- output --------------------------------------------------------------

  feed(kind, user, text, mod = { hidden: false }) {
    const item = { id: ++this.feedId, kind, user, text, hidden: !!mod.hidden, reason: mod.reason || '', ts: this.now() };
    this.emit('feed', item);
    return item;
  }

  alert(kind, user, title, message, image = '') {
    this.emit('alert', { kind, user, title, message, image: image || user?.avatar || '', ts: this.now() });
  }

  say(text, source = 'manual') {
    if (!text) return;
    this.emit('say', { text, source, ts: this.now() });
  }

  // ---- views ---------------------------------------------------------------

  topGifters(n = 10) {
    return [...this.gifters.values()].sort((a, b) => b.diamonds - a.diamonds).slice(0, n);
  }

  topChatters(n = 10) {
    return [...this.chatters.values()].sort((a, b) => b.messages - a.messages).slice(0, n);
  }

  snapshot() {
    const t = this.now();
    return {
      startedAt: this.startedAt,
      uptime: t - this.startedAt,
      stats: { ...this.stats },
      goals: Object.fromEntries(Object.entries(this.goals).map(([k, target]) => [k, { target, current: this.stats[k] }])),
      settings: { ...this.settings },
      topGifters: this.topGifters(10),
      topChatters: this.topChatters(10),
      queue: this.queue,
      poll: this.pollResults(),
      questions: this.questions.slice(-20),
      muted: [...this.muted.entries()].filter(([, until]) => until > t).map(([username, until]) => ({ username, until })),
    };
  }
}

export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}
