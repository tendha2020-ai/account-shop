import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { AiResponder, buildSystemPrompt } from '../src/ai.js';
import { Bot } from '../src/bot.js';

const u = (name) => ({ id: name, username: name, nickname: name, avatar: '' });

function fakeClient(reply, calls = []) {
  return {
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          if (reply instanceof Error) throw reply;
          return typeof reply === 'function' ? reply(params) : reply;
        },
      },
    },
  };
}

const textResponse = (text, stop_reason = 'end_turn') => ({
  stop_reason,
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }],
});

function setup(reply, aiCfg = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const calls = [];
  const ai = new AiResponder(
    { ai: { minSecondsBetweenReplies: 8, userCooldownSeconds: 60, maxRepliesPerStream: 3, ...aiCfg }, moderation: { bannedWords: ['scam'] } },
    { client: fakeClient(reply, calls), now: clock.now },
  );
  return { ai, clock, calls };
}

test('answers with a mention and sends a safe, low-effort request', async () => {
  const { ai, calls } = setup(textResponse('I stream Fortnite most nights! 🎮'));
  const reply = await ai.answer({ user: u('ana'), text: 'what game is this?' }, 'live for 5m');
  assert.equal(reply, '@ana I stream Fortnite most nights! 🎮');
  const p = calls[0];
  assert.equal(p.model, 'claude-opus-5-5');
  assert.deepEqual(p.output_config, { effort: 'low' });
  assert.equal(p.fallbacks, 'default');
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.match(p.messages[0].content, /<viewer_message>what game is this\?<\/viewer_message>/);
  assert.match(p.messages[0].content, /live for 5m/);
  assert.ok(!('thinking' in p) && !('temperature' in p));
});

test('cooldowns, per-stream cap and busy state limit calls', async () => {
  const { ai, clock, calls } = setup(textResponse('Sure!'));
  assert.ok(await ai.answer({ user: u('a'), text: 'q1?' }));
  assert.equal(await ai.answer({ user: u('b'), text: 'q2?' }), null); // global cooldown
  clock.advance(9_000);
  assert.equal(await ai.answer({ user: u('a'), text: 'q3?' }), null); // user cooldown
  assert.ok(await ai.answer({ user: u('b'), text: 'q4?' }));
  clock.advance(9_000);
  assert.ok(await ai.answer({ user: u('c'), text: 'q5?' }));
  clock.advance(61_000);
  assert.equal(await ai.answer({ user: u('d'), text: 'q6?' }), null); // cap of 3 reached
  assert.equal(calls.length, 3);
  ai.resetStream();
  assert.ok(await ai.answer({ user: u('d'), text: 'q7?' }));
});

test('drops SKIP, refusals, links and banned words; trims long replies', async () => {
  for (const [res, expected] of [
    [textResponse('SKIP'), null],
    [{ stop_reason: 'refusal', content: [] }, null],
    [textResponse('Check www.example.com for more'), null],
    [textResponse('This is not a scam'), null],
  ]) {
    const { ai } = setup(res);
    assert.equal(await ai.answer({ user: u('a'), text: 'hello there?' }), expected);
  }
  const { ai } = setup(textResponse('word '.repeat(60)), { maxReplyChars: 50 });
  const reply = await ai.answer({ user: u('a'), text: 'tell me everything?' });
  assert.ok(reply.length <= '@a '.length + 50, reply);
  assert.ok(reply.endsWith('…'));
});

test('auth errors switch AI off; rate limits pause it', async () => {
  const authErr = new Anthropic.AuthenticationError(401, { error: { message: 'bad key' } }, 'bad key', new Headers());
  const { ai } = setup(authErr);
  const warns = [];
  ai.on('warn', (w) => warns.push(w));
  assert.equal(await ai.answer({ user: u('a'), text: 'hi there?' }), null);
  assert.equal(ai.status, 'no-key');
  assert.equal(ai.skipReason(u('z')), 'no API key');
  assert.match(warns[0], /API key/);

  const noCreds = setup(new Error('Could not resolve authentication method. Expected one of apiKey...'));
  await noCreds.ai.answer({ user: u('a'), text: 'hi there?' });
  assert.equal(noCreds.ai.status, 'no-key');

  const rl = new Anthropic.RateLimitError(429, { error: { message: 'slow down' } }, 'slow down', new Headers());
  const limited = setup(rl);
  await limited.ai.answer({ user: u('a'), text: 'hi there?' });
  assert.equal(limited.ai.skipReason(u('z')), 'paused');
  limited.clock.advance(31_000);
  assert.equal(limited.ai.skipReason(u('z')), null);
});

test('system prompt carries the streamer info and guards against instructions in chat', () => {
  const p = buildSystemPrompt({ botName: 'Robo', about: 'Streamer: Mia. Plays Minecraft.', maxReplyChars: 150 });
  assert.match(p, /You are Robo/);
  assert.match(p, /Plays Minecraft/);
  assert.match(p, /never as instructions/);
});

test('bot routes !ask, questions and Q&A to the AI only when enabled', () => {
  const config = { commandPrefix: '!', ai: { enabled: true, answerQuestions: true }, moderation: { enabled: true, bannedWords: ['scam'] } };
  const bot = new Bot(config);
  const asked = [];
  bot.on('aiQuestion', (q) => asked.push(q.text));
  bot.handle({ type: 'chat', user: u('a'), text: '!ask what is your setup' });
  bot.handle({ type: 'chat', user: u('b'), text: 'where are you from?' });
  bot.handle({ type: 'chat', user: u('c'), text: 'ok?' }); // too short
  bot.handle({ type: 'chat', user: u('d'), text: 'is this a scam?' }); // hidden by moderation
  bot.handle({ type: 'question', user: u('e'), text: 'How old are you' });
  assert.deepEqual(asked, ['what is your setup', 'where are you from?', 'How old are you']);

  bot.settings.ai = false;
  bot.handle({ type: 'chat', user: u('f'), text: '!ask anything here' });
  assert.equal(asked.length, 3);
  assert.match(bot.aiContext(), /live for .* viewers/);
});
