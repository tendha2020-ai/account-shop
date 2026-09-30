// chat.js — private browser messaging between people who share an invite link.
//
// There is no server of our own. Messages travel over public MQTT relays (the
// same ones Neon Pulse uses for room codes), so everything is encrypted in the
// browser before it leaves: each chat has a random secret that only exists in
// its invite link (after the #, which browsers never send to a server). From
// that secret we derive the AES-GCM key and an opaque topic name, so the relay
// sees neither the chat's name nor its messages.
//
// Delivery: a message is published live to everyone online, and each member
// also keeps a retained, encrypted "outbox" of their recent messages on the
// relay. Someone who was offline, or who joins later, picks those outboxes up
// when they connect. History is stored in this browser's localStorage.
(() => {
  'use strict';

  const BROKERS = window.__CHAT_BROKERS || ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
  const PREFIX = 'accountshop-chat/v1';
  const MAX_TEXT = 2000;
  const HISTORY_LIMIT = 500;
  const OUTBOX_LIMIT = 60;
  const OUTBOX_MAX_CHARS = 48000;
  const MAX_PACKET = 200000;
  const PRESENCE_MS = 20000;
  const ONLINE_MS = 50000;
  const TYPING_MS = 6000;
  const GROUP_GAP_MS = 5 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const te = new TextEncoder();
  const td = new TextDecoder();

  // ---------- Storage ----------
  const memory = new Map();
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem('chat.' + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        return memory.has(key) ? memory.get(key) : fallback;
      }
    },
    set(key, value) {
      memory.set(key, value);
      try {
        localStorage.setItem('chat.' + key, JSON.stringify(value));
      } catch (e) {
        // Private mode or full storage: keep going with the in-memory copy.
      }
    },
    remove(key) {
      memory.delete(key);
      try {
        localStorage.removeItem('chat.' + key);
      } catch (e) {
        // Nothing to clean up.
      }
    },
  };

  // ---------- Small helpers ----------
  const randId = (n = 12) => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (const b of crypto.getRandomValues(new Uint8Array(n))) s += chars[b % chars.length];
    return s;
  };
  const b64u = {
    enc(bytes) {
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    dec(str) {
      const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    },
  };
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const cleanName = (v, fallback = 'Someone') => {
    const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 32) : '';
    return s || fallback;
  };
  const cleanTitle = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 40) : '');
  const validId = (v) => typeof v === 'string' && /^[a-z0-9]{6,32}$/.test(v);
  const initials = (name) =>
    name
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => Array.from(w)[0].toUpperCase())
      .join('') || '?';
  const hue = (s) => {
    let h = 0;
    for (const c of s) h = (h * 31 + c.codePointAt(0)) % 360;
    return h;
  };
  const paintAvatar = (el, seed, label) => {
    el.textContent = initials(label);
    el.style.background = `hsl(${hue(seed)} 55% 48%)`;
  };

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const shortDateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const dayKey = (ts) => new Date(ts).toDateString();
  const dayLabel = (ts) => {
    const today = new Date();
    const yesterday = new Date(Date.now() - 864e5);
    if (dayKey(ts) === today.toDateString()) return 'Today';
    if (dayKey(ts) === yesterday.toDateString()) return 'Yesterday';
    return dateFmt.format(ts);
  };
  const listTime = (ts) => (dayKey(ts) === new Date().toDateString() ? timeFmt.format(ts) : shortDateFmt.format(ts));

  // ---------- Encryption ----------
  // HKDF turns the 128-bit chat secret into an AES-256-GCM key and a topic id.
  // The MQTT topic is bound in as associated data, so a packet can't be
  // replayed under another member's topic or another message type.
  async function deriveChat(secret) {
    const raw = b64u.dec(secret);
    if (raw.length !== 16) throw new Error('bad secret');
    const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
    const salt = te.encode('account-shop-chat-v1');
    const key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('message-key') },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('topic') }, base, 128);
    return { key, topic: hex(bits) };
  }

  async function seal(key, topic, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(topic) }, key, te.encode(JSON.stringify(obj)));
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv);
    out.set(new Uint8Array(ct), 12);
    return b64u.enc(out);
  }

  async function open(key, topic, text) {
    const bytes = b64u.dec(text);
    if (bytes.length < 29) throw new Error('short');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: te.encode(topic) }, key, bytes.slice(12));
    const obj = JSON.parse(td.decode(pt));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('shape');
    return obj;
  }

  // ---------- Invite links ----------
  // chat.html#join=<secret>~<title>, both base64url so the link survives
  // being pasted into any messenger.
  function inviteLink(chat) {
    const base = location.href.split('#')[0];
    return `${base}#join=${chat.secret}~${b64u.enc(te.encode(chat.title))}`;
  }

  function parseInvite(text) {
    const m = String(text || '').trim().match(/(?:join=)?([A-Za-z0-9_-]{22})(?:~([A-Za-z0-9_-]*))?\s*$/);
    if (!m) return null;
    try {
      if (b64u.dec(m[1]).length !== 16) return null;
    } catch (e) {
      return null;
    }
    let title = '';
    try {
      title = cleanTitle(td.decode(b64u.dec(m[2] || '')));
    } catch (e) {
      title = '';
    }
    return { secret: m[1], title: title || 'Chat' };
  }

  // ---------- State ----------
  const me = store.get('me', null) || { id: randId(), name: '' };
  if (!validId(me.id)) me.id = randId();
  me.name = cleanName(me.name, '');
  store.set('me', me);

  const chats = new Map(); // topic -> chat
  let active = null;

  function saveChats() {
    store.set(
      'chats',
      [...chats.values()].map((c) => ({ secret: c.secret, title: c.title, joinedAt: c.joinedAt, lastRead: c.lastRead })),
    );
  }

  const saveTimers = new Map();
  function saveMessages(chat) {
    if (saveTimers.has(chat.id)) return;
    saveTimers.set(
      chat.id,
      setTimeout(() => {
        saveTimers.delete(chat.id);
        if (chats.get(chat.id) === chat) store.set('msgs.' + chat.id, chat.msgs);
      }, 250),
    );
  }

  async function addChat(secret, title, opts = {}) {
    const { key, topic } = await deriveChat(secret);
    if (chats.has(topic)) return chats.get(topic);
    const chat = {
      id: topic,
      secret,
      title: cleanTitle(title) || 'Chat',
      joinedAt: opts.joinedAt || Date.now(),
      lastRead: opts.lastRead || 0,
      key,
      msgs: [],
      seen: new Set(),
      members: new Map(), // member id -> { name, seenAt, typingUntil }
      outboxTimer: null,
      bye: null,
    };
    const saved = store.get('msgs.' + topic, []);
    if (Array.isArray(saved)) {
      for (const m of saved) {
        if (!m || !validId(m.id) || chat.seen.has(m.id) || typeof m.text !== 'string' || !Number.isFinite(m.ts)) continue;
        chat.seen.add(m.id);
        chat.msgs.push(m);
        noteMember(chat, m.from, m.name, 0);
      }
      chat.msgs.sort((a, b) => a.ts - b.ts);
    }
    chats.set(topic, chat);
    seal(key, presenceTopic(chat), { t: 'p', from: me.id, name: me.name, off: true }).then((p) => (chat.bye = p));
    saveChats();
    subscribeChat(chat);
    return chat;
  }

  function removeChat(chat) {
    // Clear our retained outbox so our old messages don't sit on the relay.
    for (const c of net.clients) {
      if (!c.connected) continue;
      c.publish(outboxTopic(chat), '', { qos: 1, retain: true });
      if (chat.bye) c.publish(presenceTopic(chat), chat.bye, { qos: 0 });
      c.unsubscribe(`${PREFIX}/${chat.id}/#`);
    }
    clearTimeout(chat.outboxTimer);
    chats.delete(chat.id);
    store.remove('msgs.' + chat.id);
    saveChats();
    if (active === chat) active = null;
  }

  function noteMember(chat, id, name, seenAt) {
    if (!validId(id) || id === me.id) return;
    const prev = chat.members.get(id) || { name: 'Someone', seenAt: 0, typingUntil: 0 };
    if (name) prev.name = cleanName(name);
    if (seenAt) prev.seenAt = Math.max(prev.seenAt, seenAt);
    chat.members.set(id, prev);
  }

  const unreadCount = (chat) => chat.msgs.reduce((n, m) => n + (m.from !== me.id && m.ts > chat.lastRead ? 1 : 0), 0);
  const lastActivity = (chat) => (chat.msgs.length ? chat.msgs[chat.msgs.length - 1].ts : chat.joinedAt);
  const onlineMembers = (chat) => [...chat.members.values()].filter((m) => Date.now() - m.seenAt < ONLINE_MS);

  // Adds messages we haven't seen. Returns the ones that were new.
  function ingest(chat, from, name, list) {
    if (!validId(from) || !Array.isArray(list)) return [];
    const added = [];
    const now = Date.now();
    for (const m of list.slice(-OUTBOX_LIMIT)) {
      if (!m || !validId(m.id) || chat.seen.has(m.id)) continue;
      if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > MAX_TEXT) continue;
      if (!Number.isFinite(m.ts) || m.ts <= 0) continue;
      const msg = { id: m.id, from, name: cleanName(name), text: m.text, ts: Math.min(m.ts, now + 60000), sent: true };
      chat.seen.add(msg.id);
      chat.msgs.push(msg);
      added.push(msg);
    }
    if (!added.length) return added;
    noteMember(chat, from, name, 0);
    chat.msgs.sort((a, b) => a.ts - b.ts);
    if (chat.msgs.length > HISTORY_LIMIT) {
      for (const old of chat.msgs.splice(0, chat.msgs.length - HISTORY_LIMIT)) chat.seen.delete(old.id);
    }
    saveMessages(chat);
    return added;
  }

  // ---------- Relay ----------
  const net = { clients: [], state: 'connecting' };
  const liveTopic = (chat) => `${PREFIX}/${chat.id}/m`;
  const outboxTopic = (chat) => `${PREFIX}/${chat.id}/o/${me.id}`;
  const presenceTopic = (chat) => `${PREFIX}/${chat.id}/p/${me.id}`;
  const isConnected = () => net.clients.some((c) => c.connected);

  function setConn(state) {
    net.state = state;
    const el = $('conn');
    el.dataset.state = state;
    const text = { online: 'Online', connecting: 'Connecting…', offline: 'Offline', unavailable: 'Unavailable' }[state];
    $('connText').textContent = text;
    el.title =
      state === 'online'
        ? 'Connected to the message relay'
        : state === 'unavailable'
          ? 'Could not load the messaging library. Check your connection and reload.'
          : 'Messages you send now will go out once you reconnect.';
  }

  function refreshConn() {
    if (!window.mqtt) return setConn('unavailable');
    if (isConnected()) return setConn('online');
    setConn(navigator.onLine === false ? 'offline' : 'connecting');
  }

  function subscribeChat(chat) {
    for (const c of net.clients) if (c.connected) syncChat(c, chat);
  }

  // Everything a freshly connected client needs to do for one chat: listen,
  // announce ourselves, and re-send anything that didn't make it out before.
  function syncChat(client, chat) {
    client.subscribe(`${PREFIX}/${chat.id}/#`, { qos: 1 });
    publishPresence(chat, false, [client]);
    publishOutbox(chat, [client]);
    for (const m of chat.msgs) if (m.from === me.id && !m.sent) publishLive(chat, m, [client]);
  }

  async function publish(chat, topic, obj, opts, clients) {
    const targets = (clients || net.clients).filter((c) => c.connected);
    if (!targets.length) return false;
    const payload = await seal(chat.key, topic, obj);
    const acks = targets.map(
      (c) =>
        new Promise((resolve) => {
          c.publish(topic, payload, opts, (err) => resolve(!err));
        }),
    );
    if (!opts.qos) return true;
    return new Promise((resolve) => {
      let pending = acks.length;
      for (const a of acks)
        a.then((ok) => {
          if (ok) resolve(true);
          else if (--pending === 0) resolve(false);
        });
    });
  }

  function publishLive(chat, msg, clients) {
    const body = { t: 'msg', from: me.id, name: me.name, id: msg.id, text: msg.text, ts: msg.ts };
    publish(chat, liveTopic(chat), body, { qos: 1 }, clients).then((ok) => {
      if (!ok || msg.sent) return;
      msg.sent = true;
      saveMessages(chat);
      if (active === chat) renderMessages();
    });
  }

  function publishOutbox(chat, clients) {
    const mine = [];
    let size = 0;
    for (let i = chat.msgs.length - 1; i >= 0 && mine.length < OUTBOX_LIMIT; i--) {
      const m = chat.msgs[i];
      if (m.from !== me.id) continue;
      size += m.text.length + 40;
      if (size > OUTBOX_MAX_CHARS) break;
      mine.unshift({ id: m.id, text: m.text, ts: m.ts });
    }
    publish(chat, outboxTopic(chat), { t: 'outbox', from: me.id, name: me.name, msgs: mine }, { qos: 1, retain: true }, clients);
  }

  function scheduleOutbox(chat) {
    clearTimeout(chat.outboxTimer);
    chat.outboxTimer = setTimeout(() => publishOutbox(chat), 400);
  }

  function publishPresence(chat, typing, clients) {
    publish(chat, presenceTopic(chat), { t: 'p', from: me.id, name: me.name, typing: !!typing }, { qos: 0 }, clients);
  }

  async function onPacket(topic, buf) {
    if (!topic.startsWith(PREFIX + '/') || !buf.length || buf.length > MAX_PACKET) return;
    const parts = topic.slice(PREFIX.length + 1).split('/');
    const chat = chats.get(parts[0]);
    if (!chat) return;
    let data;
    try {
      data = await open(chat.key, topic, buf.toString());
    } catch (e) {
      return; // Not for us, tampered, or garbage.
    }
    if (chats.get(chat.id) !== chat || !validId(data.from)) return;
    const kind = parts[1];

    if (kind === 'm' && parts.length === 2 && data.t === 'msg') {
      const added = ingest(chat, data.from, data.name, [data]);
      if (data.from !== me.id) noteMember(chat, data.from, data.name, Date.now());
      const member = chat.members.get(data.from);
      if (member) member.typingUntil = 0;
      if (added.length) delivered(chat, added, true);
    } else if (kind === 'o' && parts.length === 3 && parts[2] === data.from && data.t === 'outbox') {
      const added = ingest(chat, data.from, data.name, data.msgs);
      noteMember(chat, data.from, data.name, 0);
      if (added.length) delivered(chat, added, false);
      else if (active === chat) renderHeader();
    } else if (kind === 'p' && parts.length === 3 && parts[2] === data.from && data.t === 'p' && data.from !== me.id) {
      const isNew = !chat.members.has(data.from) || Date.now() - chat.members.get(data.from).seenAt > ONLINE_MS;
      noteMember(chat, data.from, data.name, data.off ? 0 : Date.now());
      const member = chat.members.get(data.from);
      if (data.off) member.seenAt = 0;
      member.typingUntil = data.typing && !data.off ? Date.now() + TYPING_MS : 0;
      // Say hello back so a newcomer sees us online without waiting a beat.
      if (isNew && !data.off) publishPresence(chat, false);
      if (active === chat) {
        renderHeader();
        renderTyping();
      }
      renderList();
    }
  }

  function connect() {
    if (!window.mqtt || typeof window.mqtt.connect !== 'function') {
      setConn('unavailable');
      return;
    }
    net.clients = BROKERS.map((url) => {
      const c = window.mqtt.connect(url, {
        clean: true,
        connectTimeout: 8000,
        reconnectPeriod: 3000,
        clientId: 'acs_' + randId(16),
      });
      c.on('connect', () => {
        for (const chat of chats.values()) syncChat(c, chat);
        refreshConn();
      });
      c.on('close', refreshConn);
      c.on('offline', refreshConn);
      c.on('error', () => {});
      c.on('message', (topic, buf) => onPacket(topic, buf));
      return c;
    });
    refreshConn();
  }

  setInterval(() => {
    for (const chat of chats.values()) publishPresence(chat, typingChat === chat);
  }, PRESENCE_MS);

  // Expire "online" and "typing…" labels as time passes.
  setInterval(() => {
    if (active) {
      renderHeader();
      renderTyping();
    }
  }, 3000);

  window.addEventListener('pagehide', () => {
    for (const chat of chats.values()) {
      if (!chat.bye) continue;
      for (const c of net.clients) if (c.connected) c.publish(presenceTopic(chat), chat.bye, { qos: 0 });
    }
  });
  window.addEventListener('online', refreshConn);
  window.addEventListener('offline', refreshConn);

  // ---------- Notifications ----------
  function delivered(chat, added, live) {
    const fromOthers = added.filter((m) => m.from !== me.id);
    const visible = active === chat && !document.hidden;
    if (visible) markRead(chat);
    renderList();
    if (active === chat) renderMessages();
    updateTitle();
    if (!fromOthers.length || visible || !live) return;
    const last = fromOthers[fromOthers.length - 1];
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(`${last.name} · ${chat.title}`, { body: last.text.slice(0, 140), tag: chat.id });
        n.onclick = () => {
          window.focus();
          openChat(chat);
          n.close();
        };
      } catch (e) {
        // Some mobile browsers only allow notifications from a service worker.
      }
    }
  }

  function markRead(chat) {
    const last = chat.msgs.length ? chat.msgs[chat.msgs.length - 1].ts : 0;
    if (last > chat.lastRead) {
      chat.lastRead = last;
      saveChats();
    }
  }

  function updateTitle() {
    let total = 0;
    for (const chat of chats.values()) total += unreadCount(chat);
    document.title = total ? `(${total}) Messages` : 'Messages';
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && active) {
      markRead(active);
      renderList();
      updateTitle();
    }
  });

  // ---------- Rendering ----------
  function renderProfile() {
    $('meName').textContent = me.name || 'Set your name';
    paintAvatar($('meAvatar'), me.id, me.name || '?');
  }

  function renderList() {
    const list = $('chatList');
    list.textContent = '';
    const sorted = [...chats.values()].sort((a, b) => lastActivity(b) - lastActivity(a));
    $('noChats').classList.toggle('hidden', sorted.length > 0);
    for (const chat of sorted) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-item' + (chat === active ? ' active' : '');
      btn.addEventListener('click', () => openChat(chat));

      const av = document.createElement('span');
      av.className = 'avatar' + (onlineMembers(chat).length ? ' online' : '');
      paintAvatar(av, chat.id, chat.title);

      const meta = document.createElement('span');
      meta.className = 'chat-meta';
      const row1 = document.createElement('span');
      row1.className = 'chat-row';
      const name = document.createElement('span');
      name.className = 'chat-name';
      name.textContent = chat.title;
      const time = document.createElement('span');
      time.className = 'chat-time';
      time.textContent = listTime(lastActivity(chat));
      row1.append(name, time);

      const row2 = document.createElement('span');
      row2.className = 'chat-row';
      const preview = document.createElement('span');
      preview.className = 'chat-preview';
      const last = chat.msgs[chat.msgs.length - 1];
      preview.textContent = last ? `${last.from === me.id ? 'You' : last.name}: ${last.text.replace(/\s+/g, ' ')}` : 'No messages yet — send the invite link';
      row2.append(preview);
      const unread = unreadCount(chat);
      if (unread) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = unread > 99 ? '99+' : String(unread);
        badge.setAttribute('aria-label', `${unread} unread`);
        row2.append(badge);
      }
      meta.append(row1, row2);
      btn.append(av, meta);
      li.append(btn);
      list.append(li);
    }
  }

  function renderHeader() {
    if (!active) return;
    $('chatTitle').textContent = active.title;
    const members = [...active.members.values()];
    const online = onlineMembers(active);
    let sub;
    if (!members.length) sub = 'Waiting for someone to join — tap Invite';
    else if (members.length === 1) sub = online.length ? `${members[0].name} is online` : members[0].name;
    else {
      const names = members.map((m) => m.name).join(', ');
      sub = online.length ? `${online.length} online · ${names}` : names;
    }
    $('chatSub').textContent = sub;
  }

  function renderTyping() {
    if (!active) return;
    const now = Date.now();
    const typing = [...active.members.values()].filter((m) => m.typingUntil > now).map((m) => m.name);
    $('typing').textContent = !typing.length ? '' : typing.length === 1 ? `${typing[0]} is typing…` : `${typing.join(', ')} are typing…`;
  }

  // Turns URLs into links without ever parsing message text as HTML.
  function appendText(el, text) {
    const re = /\bhttps?:\/\/[^\s<>"']+/gi;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      let url = m[0].replace(/[).,!?;:]+$/, '');
      if (m.index > last) el.append(text.slice(last, m.index));
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      el.append(a);
      last = m.index + url.length;
      re.lastIndex = last;
    }
    if (last < text.length) el.append(text.slice(last));
  }

  function renderMessages() {
    if (!active) return;
    const box = $('messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.textContent = '';
    if (!active.msgs.length) {
      const p = document.createElement('p');
      p.className = 'empty-chat';
      p.textContent = active.members.size
        ? 'No messages yet. Say hi!'
        : 'No messages yet. Tap Invite and send the link to the people you want to talk to.';
      box.append(p);
      return;
    }
    let prev = null;
    const group = active.members.size > 1;
    for (const m of active.msgs) {
      if (!prev || dayKey(prev.ts) !== dayKey(m.ts)) {
        const d = document.createElement('div');
        d.className = 'day';
        d.textContent = dayLabel(m.ts);
        box.append(d);
        prev = null;
      }
      const mine = m.from === me.id;
      const first = !prev || prev.from !== m.from || m.ts - prev.ts > GROUP_GAP_MS;
      const el = document.createElement('div');
      el.className = 'msg' + (mine ? ' mine' : '') + (first ? ' first' : '');
      if (first && !mine && group) {
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = m.name;
        who.style.color = `hsl(${hue(m.from)} 60% 45%)`;
        el.append(who);
      }
      const body = document.createElement('span');
      appendText(body, m.text);
      el.append(body);
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = timeFmt.format(m.ts) + (mine ? (m.sent ? ' ✓' : ' 🕓') : '');
      when.title = mine && !m.sent ? 'Waiting to send' : new Date(m.ts).toLocaleString();
      el.append(when);
      box.append(el);
      prev = m;
    }
    if (atBottom || box.dataset.jump) {
      box.scrollTop = box.scrollHeight;
      delete box.dataset.jump;
    }
  }

  function openChat(chat) {
    active = chat;
    $('welcome').classList.add('hidden');
    $('chatView').classList.remove('hidden');
    $('app').classList.add('show-conv');
    $('messages').dataset.jump = '1';
    menu.open = false;
    stopTyping();
    markRead(chat);
    renderHeader();
    renderTyping();
    renderMessages();
    renderList();
    updateTitle();
    if (!matchMedia('(pointer: coarse)').matches) $('input').focus();
  }

  function closeChat() {
    stopTyping();
    active = null;
    $('app').classList.remove('show-conv');
    $('chatView').classList.add('hidden');
    $('welcome').classList.remove('hidden');
    renderList();
  }

  // ---------- Composer ----------
  const input = $('input');
  let typingChat = null;
  let typingIdle = null;
  let typingSentAt = 0;

  function stopTyping() {
    clearTimeout(typingIdle);
    if (typingChat) publishPresence(typingChat, false);
    typingChat = null;
    typingSentAt = 0;
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight + 2, 140) + 'px';
    $('sendBtn').disabled = !input.value.trim();
  }

  input.addEventListener('input', () => {
    autosize();
    if (!active) return;
    if (!input.value.trim()) return stopTyping();
    if (typingChat !== active || Date.now() - typingSentAt > 3000) {
      typingChat = active;
      typingSentAt = Date.now();
      publishPresence(active, true);
    }
    clearTimeout(typingIdle);
    typingIdle = setTimeout(stopTyping, 4000);
  });
  input.addEventListener('blur', stopTyping);

  input.addEventListener('keydown', (e) => {
    // Enter sends on keyboards; on phones it inserts a new line and the Send
    // button sends, like most messaging apps.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      send();
    }
  });

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    send();
    if (matchMedia('(pointer: coarse)').matches) input.focus();
  });

  function send() {
    const text = input.value.trim().slice(0, MAX_TEXT);
    if (!text || !active) return;
    if (!me.name) return openProfile();
    const chat = active;
    let ts = Date.now();
    const last = chat.msgs[chat.msgs.length - 1];
    if (last && last.ts >= ts) ts = last.ts + 1; // keep our own order even if clocks disagree
    const msg = { id: randId(), from: me.id, name: me.name, text, ts, sent: false };
    chat.seen.add(msg.id);
    chat.msgs.push(msg);
    if (chat.msgs.length > HISTORY_LIMIT) for (const old of chat.msgs.splice(0, chat.msgs.length - HISTORY_LIMIT)) chat.seen.delete(old.id);
    saveMessages(chat);
    input.value = '';
    autosize();
    clearTimeout(typingIdle);
    typingChat = null;
    markRead(chat);
    $('messages').dataset.jump = '1';
    renderMessages();
    renderList();
    publishLive(chat, msg);
    scheduleOutbox(chat);
  }

  // ---------- Dialogs ----------
  for (const btn of document.querySelectorAll('dialog [data-close]')) {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  }

  function openProfile() {
    $('nameInput').value = me.name;
    $('profileCancel').classList.toggle('hidden', !me.name);
    const canNotify = 'Notification' in window && Notification.permission === 'default';
    $('notifyRow').classList.toggle('hidden', !canNotify);
    $('profileDlg').showModal();
  }

  $('profileBtn').addEventListener('click', openProfile);
  $('profileCancel').addEventListener('click', () => $('profileDlg').close());
  $('profileDlg').addEventListener('cancel', (e) => {
    if (!me.name) e.preventDefault(); // a name is needed before chatting
  });
  $('profileForm').addEventListener('submit', (e) => {
    const name = cleanName($('nameInput').value, '');
    if (!name) {
      e.preventDefault();
      return;
    }
    setName(name);
  });
  $('notifyBtn').addEventListener('click', () => {
    Notification.requestPermission().then(() => $('notifyRow').classList.add('hidden'));
  });

  function setName(name) {
    if (name === me.name) return;
    me.name = name;
    store.set('me', me);
    renderProfile();
    for (const chat of chats.values()) {
      publishPresence(chat, false);
      scheduleOutbox(chat);
    }
  }

  $('newChatBtn').addEventListener('click', () => {
    if (!me.name) return openProfile();
    $('newTitle').value = '';
    $('newDlg').showModal();
  });
  $('newForm').addEventListener('submit', async () => {
    const title = cleanTitle($('newTitle').value);
    if (!title) return;
    const secret = b64u.enc(crypto.getRandomValues(new Uint8Array(16)));
    const chat = await addChat(secret, title, { lastRead: Date.now() });
    openChat(chat);
    showInvite(chat);
  });

  let pendingInvite = null;
  function showJoin(invite) {
    pendingInvite = invite;
    $('joinError').textContent = '';
    $('joinInput').classList.toggle('hidden', !!invite);
    $('joinInput').value = '';
    $('joinHeading').textContent = invite ? `Join "${invite.title}"` : 'Join a chat';
    $('joinText').textContent = invite
      ? 'You were invited to a private chat. Messages are end-to-end encrypted and stay in this browser.'
      : 'Paste the invite link someone sent you.';
    $('joinNameRow').classList.toggle('hidden', !!me.name);
    $('joinName').value = me.name;
    $('joinDlg').showModal();
  }

  $('joinChatBtn').addEventListener('click', () => showJoin(null));
  $('joinForm').addEventListener('submit', async (e) => {
    const invite = pendingInvite || parseInvite($('joinInput').value);
    const name = me.name || cleanName($('joinName').value, '');
    if (!invite || !name) {
      e.preventDefault();
      $('joinError').textContent = !invite ? "That doesn't look like an invite link." : 'Please enter your name.';
      return;
    }
    pendingInvite = null;
    setName(name);
    const chat = await addChat(invite.secret, invite.title, { lastRead: 0 });
    openChat(chat);
  });

  function showInvite(chat) {
    $('inviteTitle').textContent = chat.title;
    $('inviteLink').value = inviteLink(chat);
    $('shareBtn').classList.toggle('hidden', typeof navigator.share !== 'function');
    $('copyBtn').textContent = 'Copy link';
    $('inviteDlg').showModal();
    $('inviteLink').select();
  }

  $('inviteBtn').addEventListener('click', () => active && showInvite(active));
  $('inviteLink').addEventListener('focus', (e) => e.target.select());
  $('copyBtn').addEventListener('click', () => {
    const link = $('inviteLink').value;
    const done = (ok) => ($('copyBtn').textContent = ok ? 'Copied!' : 'Select and copy it above');
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => done(true), () => done(false));
    else done(false);
  });
  $('shareBtn').addEventListener('click', () => {
    if (!active) return;
    navigator.share({ title: active.title, text: `Join my chat "${active.title}"`, url: inviteLink(active) }).catch(() => {});
  });

  const menu = $('menuDetails');
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });

  $('renameBtn').addEventListener('click', () => {
    menu.open = false;
    if (!active) return;
    $('renameInput').value = active.title;
    $('renameDlg').showModal();
  });
  $('renameForm').addEventListener('submit', () => {
    const title = cleanTitle($('renameInput').value);
    if (!title || !active) return;
    active.title = title;
    saveChats();
    renderHeader();
    renderList();
  });

  $('leaveBtn').addEventListener('click', () => {
    menu.open = false;
    if (!active) return;
    if (!confirm(`Leave "${active.title}"? Its messages will be deleted from this browser. You can rejoin later with the invite link.`)) return;
    removeChat(active);
    closeChat();
    updateTitle();
  });

  $('backBtn').addEventListener('click', closeChat);

  // ---------- Start ----------
  async function handleHash() {
    const m = location.hash.match(/^#join=(.+)$/);
    if (!m) return;
    const invite = parseInvite(m[1]);
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) {
      // Some embeds refuse history changes; nothing depends on the address bar.
    }
    if (!invite) return;
    const { topic } = await deriveChat(invite.secret);
    if (chats.has(topic)) return openChat(chats.get(topic));
    if ($('profileDlg').open) $('profileDlg').close();
    showJoin(invite);
  }

  async function start() {
    renderProfile();
    if (!window.crypto || !crypto.subtle) {
      $('welcome').querySelector('h2').textContent = 'This browser can’t encrypt messages';
      $('welcome').querySelector('.fine').textContent = 'Open this page over https:// in an up-to-date browser.';
      setConn('unavailable');
      return;
    }
    const saved = store.get('chats', []);
    for (const c of Array.isArray(saved) ? saved : []) {
      try {
        await addChat(c.secret, c.title, { joinedAt: c.joinedAt, lastRead: c.lastRead });
      } catch (e) {
        // Skip a corrupt entry rather than losing every chat.
      }
    }
    renderList();
    updateTitle();
    connect();
    if (!me.name && !/^#join=/.test(location.hash)) openProfile();
    await handleHash();
    window.addEventListener('hashchange', handleHash);
  }

  // Exposed for automated checks.
  window.__chat = { me, chats, parseInvite, inviteLink, get active() { return active; } };

  start();
})();
