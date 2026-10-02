import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot, fill } from '../src/bot.js';
import * as N from '../src/normalize.js';

const baseConfig = {
  commandPrefix: '!',
  commandCooldownSeconds: 10,
  userCooldownSeconds: 20,
  commands: { discord: 'Join: discord.gg/x' },
  welcome: { firstChat: true, message: 'Welcome {user}!', minSecondsBetween: 15 },
  thanks: { follow: 'Thanks {user}', share: 'Shared {user}', gift: 'Thanks {user} for {count}x {gift}', giftMinDiamonds: 1 },
  giftRules: [{ minDiamonds: 100, message: 'BIG {user}' }],
  likeMilestone: 100,
  likeMilestoneMessage: '{total} likes!',
  goals: { likes: 0, diamonds: 50, follows: 2 },
  timers: [{ everyMinutes: 5, message: 'Follow me!' }],
  timerMinChatLines: 2,
  moderation: {
    enabled: true, bannedWords: ['scam'], blockLinks: true, maxCapsRatio: 0.75, repeatLimit: 3,
    floodMessagesPer10s: 6, strikesBeforeMute: 2, muteMinutes: 10, warnMessage: 'warn {user} {reason}', trustedUsers: ['mod1'],
  },
};

function setup(overrides = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const bot = new Bot({ ...baseConfig, ...overrides }, { now: clock.now });
  const says = [];
  const alerts = [];
  bot.on('say', (s) => says.push(s.text));
  bot.on('alert', (a) => alerts.push(a));
  return { bot, clock, says, alerts };
}

const u = (name) => ({ id: name, username: name, nickname: name, avatar: '' });
const chat = (name, text) => ({ type: 'chat', user: u(name), text });

test('fill replaces known placeholders and keeps unknown ones', () => {
  assert.equal(fill('Hi {user}, {x}', { user: 'Ana' }), 'Hi Ana, {x}');
});

test('welcomes first-time chatters, throttled', () => {
  const { bot, says, clock } = setup();
  bot.handle(chat('a', 'hello'));
  bot.handle(chat('b', 'hey'));
  assert.deepEqual(says, ['Welcome a!']);
  clock.advance(16_000);
  bot.handle(chat('c', 'yo'));
  bot.handle(chat('a', 'again'));
  assert.deepEqual(says, ['Welcome a!', 'Welcome c!']);
});

test('custom and built-in commands reply, with cooldowns', () => {
  const { bot, says, clock } = setup({ welcome: {} });
  bot.handle(chat('a', '!discord'));
  bot.handle(chat('b', '!discord')); // global cooldown
  assert.deepEqual(says, ['Join: discord.gg/x']);
  clock.advance(11_000);
  bot.handle(chat('b', '!DISCORD'));
  assert.equal(says.length, 2);
  bot.handle(chat('c', '!nope'));
  assert.equal(says.length, 2);
  bot.handle(chat('c', '!commands'));
  assert.match(says.at(-1), /!discord.*!uptime.*!join/);
});

test('gift streaks are only counted when they end', () => {
  const { bot, says } = setup({ welcome: {} });
  const g = { type: 'gift', user: u('a'), giftId: '1', giftName: 'Rose', diamonds: 1, image: '' };
  bot.handle({ ...g, count: 3, streaking: true });
  assert.equal(bot.stats.diamonds, 0);
  bot.handle({ ...g, count: 5, streaking: false });
  assert.equal(bot.stats.diamonds, 5);
  assert.deepEqual(says, ['Thanks a for 5x Rose']);
  bot.handle({ ...g, giftName: 'Galaxy', diamonds: 1000, count: 1, streaking: false });
  assert.ok(says.includes('BIG a'));
  assert.equal(bot.topGifters(1)[0].diamonds, 1005);
});

test('goals fire once and can be reset', () => {
  const { bot, alerts } = setup({ welcome: {} });
  bot.handle({ type: 'follow', user: u('a') });
  bot.handle({ type: 'follow', user: u('b') });
  bot.handle({ type: 'follow', user: u('c') });
  assert.equal(alerts.filter((a) => a.kind === 'goal').length, 1);
  bot.setGoal('follows', 4);
  bot.handle({ type: 'follow', user: u('d') });
  assert.equal(alerts.filter((a) => a.kind === 'goal').length, 2);
});

test('like milestones announce each step once', () => {
  const { bot, says } = setup({ welcome: {} });
  bot.handle({ type: 'like', user: u('a'), count: 50, total: 50 });
  bot.handle({ type: 'like', user: u('a'), count: 60, total: 110 });
  bot.handle({ type: 'like', user: u('a'), count: 20, total: 130 });
  bot.handle({ type: 'like', user: u('a'), count: 300, total: 430 });
  assert.deepEqual(says, ['100 likes!', '400 likes!']);
});

test('moderation hides banned words, links, caps and repeats, then mutes', () => {
  const { bot, says } = setup({ welcome: {} });
  assert.equal(bot.handle(chat('x', 'this is a SCAM')).reason, 'banned word');
  assert.equal(bot.handle(chat('y', 'visit www.spam.example')).reason, 'links');
  assert.equal(bot.handle(chat('z', 'THIS IS SO LOUD OMG')).reason, 'too many caps');
  assert.equal(bot.handle(chat('ok', 'scammer is a word too')).hidden, false);
  assert.ok(says.includes('warn x banned word'));

  bot.handle(chat('x', 'scam again')); // 2nd strike -> mute
  assert.ok(bot.muted.has('x'));
  assert.equal(bot.handle(chat('x', 'hello')).reason, 'muted');
  bot.unmute('x');
  assert.equal(bot.handle(chat('x', 'hello')).hidden, false);

  const r = ['spam', 'spam', 'spam'].map((t) => bot.handle(chat('r', t)));
  assert.deepEqual(r.map((i) => i.hidden), [false, false, true]);
  assert.equal(bot.handle(chat('mod1', 'scam alert, ignore it')).hidden, false);
});

test('hidden messages do not trigger commands', () => {
  const { bot, says } = setup({ welcome: {}, moderation: { ...baseConfig.moderation, warnMessage: '' } });
  bot.handle(chat('a', '!discord scam'));
  assert.deepEqual(says, []);
});

test('viewer queue join/leave/next', () => {
  const { bot, says } = setup({ welcome: {} });
  bot.handle(chat('a', '!join'));
  bot.handle(chat('b', '!join'));
  assert.deepEqual(bot.queue.map((q) => q.username), ['a', 'b']);
  bot.handle(chat('a', '!leave'));
  assert.deepEqual(bot.queue.map((q) => q.username), ['b']);
  assert.equal(bot.queueNext().username, 'b');
  assert.equal(says.at(-1), 'Up next: b! 🎮');
});

test('polls count one vote per user and close on tick', () => {
  const { bot, says, clock } = setup({ welcome: {} });
  bot.startPoll('Next game?', ['Fortnite', 'Minecraft'], 30);
  bot.handle(chat('a', '1'));
  bot.handle(chat('a', '2'));
  bot.handle(chat('b', 'minecraft'));
  bot.handle(chat('c', '2'));
  assert.deepEqual(bot.pollResults().options.map((o) => o.votes), [1, 2]);
  clock.advance(31_000);
  bot.tick();
  assert.equal(bot.poll, null);
  assert.match(says.at(-1), /Minecraft wins with 2 vote/);
  assert.throws(() => bot.startPoll('?', ['only one']));
});

test('timers wait for interval and chat activity', () => {
  const { bot, says, clock } = setup({ welcome: {} });
  clock.advance(6 * 60_000);
  bot.tick();
  assert.deepEqual(says, []); // chat too quiet
  bot.handle(chat('a', 'hi'));
  bot.handle(chat('b', 'hey'));
  bot.tick();
  assert.deepEqual(says, ['Follow me!']);
  bot.tick();
  assert.equal(says.length, 1);
});

test('normalize handles v3 protobuf payloads', () => {
  const user = { id: '7', displayId: 'ana_live', nickname: 'Ana', avatarThumb: { urlList: ['https://x/a.jpg'] } };
  assert.deepEqual(N.chat({ user, content: 'hi' }), {
    type: 'chat', user: { id: '7', username: 'ana_live', nickname: 'Ana', avatar: 'https://x/a.jpg' }, text: 'hi',
  });
  const g = N.gift({ user, giftId: '5655', repeatCount: 3, repeatEnd: 0, gift: { name: 'Rose', diamondCount: 1, type: 1 } });
  assert.equal(g.streaking, true);
  assert.equal(g.giftName, 'Rose');
  assert.equal(N.gift({ user, repeatCount: 3, repeatEnd: 1, gift: { type: 1 } }).streaking, false);
  assert.deepEqual(N.like({ user, count: 15, total: '1200' }).total, 1200);
  assert.equal(N.viewers({ total: '321' }).count, 321);
  assert.equal(N.question({ data: { user, content: 'why?' } }).text, 'why?');
});

test('normalize handles legacy payloads', () => {
  const user = { userId: '9', uniqueId: 'bob', nickname: 'Bob', profilePictureUrl: 'p.jpg' };
  assert.equal(N.chat({ user, comment: 'yo' }).text, 'yo');
  assert.equal(N.chat({ user, comment: 'yo' }).user.username, 'bob');
  const g = N.gift({ user, giftId: 1, repeatCount: 2, repeatEnd: true, giftDetails: { giftName: 'Rose', diamondCount: 1, giftType: 1 } });
  assert.equal(g.streaking, false);
  assert.equal(g.count, 2);
  assert.equal(N.like({ user, likeCount: 3, totalLikeCount: 9 }).total, 9);
  assert.equal(N.viewers({ viewerCount: 42 }).count, 42);
});

test('the streamer is never welcomed, moderated or auto-answered', () => {
  const { bot, says } = setup({ tiktokUsername: '@Host_Name', ai: { answerQuestions: true } });
  bot.settings.ai = true;
  const asked = [];
  bot.on('aiQuestion', (q) => asked.push(q.text));
  assert.equal(bot.handle(chat('host_name', 'THIS IS A SCAM LOL')).hidden, false);
  bot.handle(chat('host_name', 'who is ready to play?'));
  assert.deepEqual(says, []);
  assert.deepEqual(asked, []);
  bot.handle(chat('host_name', '!discord'));
  assert.deepEqual(says, ['Join: discord.gg/x']);
});
