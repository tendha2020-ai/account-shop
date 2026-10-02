# TikTok LIVE Bot

A bot that manages your TikTok LIVE stream while you focus on the stream itself.
It runs on your computer next to OBS or TikTok LIVE Studio. You control it from a
dashboard in your browser, and viewers see it through an on-stream overlay.

## What it does

| Feature | Details |
|---|---|
| **Alerts** | Pop-ups and chimes for follows, shares, gifts, like milestones and goals. Gift streaks are counted once, when the streak ends. |
| **Auto thanks** | Thanks gifters, followers and sharers. Gift rules let you give a special message for a gift name (e.g. Rose) or for big gifts. |
| **Welcome** | Greets people the first time they chat. It is throttled so it doesn't spam. |
| **Chat commands** | Your own commands (`!discord`, `!socials`, `!rules`…) plus built-ins: `!commands`, `!uptime`, `!top`, `!goal`, `!join`, `!leave`, `!queue`. Each has a global cooldown and a per-user cooldown. |
| **Auto-moderation** | Hides messages that have banned words, links, too many caps, repeats or flooding. Sends a warning, and after enough strikes mutes the user (the bot ignores them) for N minutes. Users in the trusted list are never moderated. |
| **Viewer queue** | Viewers type `!join` to get in line (for games or duets). You click **Next** on the dashboard. |
| **Polls** | Start a poll from the dashboard. Viewers vote by typing `1`, `2`, `3`… or the option name. The result is announced when the poll ends. |
| **Goals** | Progress bars for likes, diamonds and follows, shown on the overlay. You can edit them live. |
| **Timed announcements** | Repeating messages (e.g. "tap follow!") that only run while chat is active. |
| **Q&A** | Questions from TikTok's Q&A feature are collected on the dashboard. |
| **AI replies** | Optional. Claude answers viewer questions (`!ask …`, chat messages ending in `?`, and TikTok Q&A) in one short sentence, using the info you give it about your stream. See [AI replies](#ai-replies-optional). |
| **Stats** | Viewers, peak viewers, likes, diamonds, follows, shares, chats, uptime, top gifters. A JSON summary is saved to `data/` when the stream ends. |
| **Auto-connect** | Waits for you to go live and reconnects by itself if the connection drops. |

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
cd tiktok-bot
npm install
npm run demo        # try it with fake viewers. No TikTok account needed.
```

Then open **http://localhost:3000** for the dashboard and **http://localhost:3000/overlay** for the overlay.

When you're ready to use it for real:

```bash
npm start
```

It's already set up for **@tendha2** (Fortnite, music, Snapchat `Tendha6`). All settings are in
`config.example.json`. To change them without touching the shared file, copy it to `config.json`
(on Windows: `copy config.example.json config.json`) and edit that. If `config.json` exists, the bot uses it instead.
Put API keys and cookies only in `config.json` or in environment variables, never in `config.example.json`
(`config.json` is never uploaded to GitHub).

Start the bot before or after you go live. If you aren't live yet, it waits and connects
when your stream starts.

## Adding the overlay to your stream

**TikTok LIVE Studio (PC):**
1. Start the bot first (`npm start`).
2. In LIVE Studio, click **Add Source** → **Link**.
3. Paste `http://localhost:3000/overlay` and click **OK**.
4. Drag the corners of the new source so it covers the whole screen. Keep it above your game capture.
5. On the dashboard, click a **Test alerts** button. An alert should appear in LIVE Studio.

To place each part separately, add more Link sources. For example, use `http://localhost:3000/overlay?show=alerts`
for alerts only and `http://localhost:3000/overlay?show=goals` for goal bars only. Each one can then be moved around the
screen (for example, away from your Fortnite minimap). If a Link source shows up as a tiny box or stays blank,
resize it to fill the screen. If that doesn't help, use OBS (below) and send it to LIVE Studio with OBS Virtual Camera.

**OBS / Streamlabs:** add a **Browser Source** with these settings:

- URL: `http://localhost:3000/overlay`
- Size: `1920 x 1080` for a landscape stream like a PC game, or `1080 x 1920` for a vertical stream

You can choose which widgets are shown, or add each widget as its own source so you can place it anywhere:

| URL | Shows |
|---|---|
| `/overlay` | everything |
| `/overlay?show=alerts` | only alerts |
| `/overlay?show=goals` | only goal bars |
| `/overlay?show=chat` | only chat (moderated: hidden messages never appear) |
| `/overlay?show=bot` | only the bot's message banner |
| `/overlay?tts=1` | also reads bot messages aloud (text-to-speech) |
| `/overlay?sound=0` | no alert chimes |

In OBS, tick **"Control audio via OBS"** on the source if you want to hear the chimes and TTS on stream.

## Making the bot post in your TikTok chat (optional)

By default the bot **reads** your live without logging in. Its replies (thanks, command
answers, warnings) appear on the **overlay** and can be read aloud with TTS. That is the
safest setup.

To have the bot also **type into TikTok chat**, the library needs a logged-in session:

1. Get an API key **with a paid plan** at [eulerstream.com](https://www.eulerstream.com). This is the signing service the library uses, and posting to chat is a paid feature there.
2. Log in to tiktok.com in your browser. Open DevTools → Application → Cookies and copy the values of
   `sessionid` and `tt-target-idc`. **Use a separate bot account, not your main account.**
3. Put these values in `config.json` under `sendToTikTokChat` and set `"enabled": true`.
   You can also set them as the environment variables `EULER_API_KEY`, `TIKTOK_SESSION_ID` and
   `TIKTOK_TARGET_IDC` so they don't sit in a file.

Messages are queued with a minimum gap (`minSecondsBetweenMessages`) so the account doesn't get rate-limited.

> ⚠️ **Read this before you enable it.** TikTok has no official live-chat API. This bot uses the
> community library [tiktok-live-connector](https://github.com/zerodytrash/TikTok-Live-Connector),
> which reverse-engineers TikTok's protocol. It can break when TikTok changes things. Posting
> automatically with a session cookie may go against TikTok's terms of service. Your `sessionid` is a
> password for that account: never share it or commit it (`config.json` is already in `.gitignore`).
> Real bans, blocks and comment deletions still have to be done in the TikTok app. Assign a human
> moderator there too.

## AI replies (optional)

The bot can answer viewers' questions with Claude (Anthropic's AI). For example, a viewer types
`what phone do you use?` and the bot replies `@Ana Sam streams with an iPhone 15! 📱`.

1. Create an API key at [console.anthropic.com](https://console.anthropic.com). Each answer is a small paid API call.
2. Give the bot the key, either way:
   - as an environment variable: `ANTHROPIC_API_KEY=sk-ant-... npm start` (Windows PowerShell: `$env:ANTHROPIC_API_KEY="sk-ant-..."; npm start`)
   - or in `config.json` under `ai.apiKey`
3. In `config.json`, set `ai.enabled` to `true` and write about yourself in `ai.about`: your name, what you stream,
   your schedule, your setup, your socials. **The bot only knows what you put here.** If a question isn't covered,
   it says you can answer it yourself, instead of making something up.
4. Restart the bot. You can turn AI replies on and off live from the dashboard.

What gets answered:
- `!ask <question>`: always (while AI replies are on)
- any chat message that ends in `?` (set `answerQuestions` to `false` to turn this off)
- questions sent with TikTok's Q&A feature

Built-in limits keep it from spamming chat or your bill:
- one answer at a time, at least `minSecondsBetweenReplies` apart (default 8 s)
- each viewer can get one answer every `userCooldownSeconds` (default 60 s)
- at most `maxRepliesPerStream` answers per stream (default 200)

Safety: messages hidden by moderation are never sent to the AI. The AI treats chat only as questions to answer
(viewers can't give it orders). Replies that contain links or banned words are dropped. Rude or spam messages get
no reply.

The default model is `claude-opus-5-5` at `low` effort, which suits short chat answers. You can change `model` and
`effort` in `config.json`.

## Configuration

Everything is in `config.json`. Text templates can use `{user}`, and gift templates can also use `{gift}`,
`{count}` and `{diamonds}`.

| Key | What it controls |
|---|---|
| `tiktokUsername` | The account whose live the bot manages |
| `server.host` / `server.port` | Where the dashboard runs. Keep `127.0.0.1` so only your computer can control the bot. |
| `connection` | Auto-reconnect, and how often to check whether you're live |
| `commands` | Your custom `!commands` and their replies |
| `commandCooldownSeconds` / `userCooldownSeconds` | Anti-spam cooldowns for commands |
| `welcome` | First-chat greeting (`onJoin: true` also greets viewers who join without chatting) |
| `thanks` | Thank-you messages. `giftMinDiamonds` skips thanking gifts below that value. |
| `giftRules` | Special messages, matched by `gift` name and/or `minDiamonds`. The first match wins. |
| `likeMilestone` | Announce every N likes |
| `goals` | Starting targets for likes, diamonds and follows (`0` hides a goal) |
| `timers` / `timerMinChatLines` | Repeating announcements and how much chat activity is needed between them |
| `moderation` | Banned words, link/caps/repeat/flood rules, strikes before a mute, mute length, trusted users |
| `ai` | AI replies: on/off, API key, what the bot knows about you (`about`), and its limits |
| `overlay` | How long alerts stay on screen, and default TTS |

On the dashboard you can turn each feature on or off live, hide a message from the overlay,
mute or unmute users, edit goals, run polls, manage the queue, fire test alerts, and type
messages for the bot to say.

## Project layout

```
tiktok-bot/
├── src/
│   ├── server.js      web server, WebSocket hub, dashboard actions, TikTok chat outbox
│   ├── bot.js         all bot logic (commands, moderation, goals, polls, queue, timers)
│   ├── ai.js          AI replies with Claude (rate limits, reply safety checks)
│   ├── tiktok.js      TikTok LIVE connection with wait-for-live + auto-reconnect
│   ├── normalize.js   turns raw TikTok events into simple objects
│   └── simulator.js   fake events for `npm run demo`
├── public/
│   ├── dashboard.html/.css/.js   control panel
│   └── overlay.html              OBS browser source
└── test/            run with `npm test`
```

## Troubleshooting

- **The status stays on "waiting"**: you're not live yet, or the username is wrong. Check the username in
  the dashboard (without the `@`).
- **Status shows "error" with a rate-limit or sign error**: the free signing tier is busy. Wait a minute,
  or add an `EULER_API_KEY`.
- **The overlay shows nothing**: check that the bot is running and that the URL is exactly
  `http://localhost:3000/overlay`. Click a **Test alerts** button on the dashboard.
- **AI doesn't reply**: check that "AI replies to questions" is on in the dashboard. If the dashboard says it needs
  an API key, set `ANTHROPIC_API_KEY` and restart. Questions also need to end in `?` (or start with `!ask`), and the
  cooldowns above apply.
- **No sound in OBS**: tick "Control audio via OBS" on the Browser Source and unmute it in the mixer.
