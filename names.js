// names.js
// Name Lab: Epic Games display-name finder, Unicode font changer, symbols and logo maker

const EPIC_MIN = 3;
const EPIC_MAX = 16;
const SAMPLE = 'Epic Name';

const $ = (sel, root = document) => root.querySelector(sel);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked: favourites just won't persist
  }
}

// ---------- Copy + toast ----------

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`Copied: ${text}`);
}

// ---------- Epic name checks ----------

const charCount = (s) => Array.from(s).length;

function epicStatus(s) {
  const n = charCount(s);
  if (n < EPIC_MIN) return { label: 'Too short', cls: 'bad', safe: false };
  if (n > EPIC_MAX) return { label: `Too long for Epic`, cls: 'bad', safe: false };
  if (/^[A-Za-z0-9._ -]+$/.test(s)) {
    if (s !== s.trim()) return { label: 'Remove edge spaces', cls: 'warn', safe: false };
    return { label: 'Epic-safe', cls: 'good', safe: true };
  }
  return { label: 'Fancy', cls: 'warn', safe: false, tip: 'Fancy Unicode – great for Discord & socials, Epic may reject it' };
}

function badgeHTML(s) {
  const st = epicStatus(s);
  return `<span class="badge ${st.cls}"${st.tip ? ` title="${st.tip}"` : ''}>${st.label}</span>`;
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Font engine ----------

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

// Mathematical Alphanumeric Symbols block, with the letters that live elsewhere in Unicode
function mathMap(start, digitStart, holes = {}) {
  const map = {};
  for (let i = 0; i < 26; i++) {
    map[UPPER[i]] = String.fromCodePoint(start + i);
    map[LOWER[i]] = String.fromCodePoint(start + 26 + i);
  }
  if (digitStart) {
    for (let i = 0; i < 10; i++) map[DIGITS[i]] = String.fromCodePoint(digitStart + i);
  }
  for (const [ch, cp] of Object.entries(holes)) map[ch] = String.fromCodePoint(cp);
  return map;
}

// Map from lookalike strings (26 upper, 26 lower, optional 10 digits)
function lookMap(upper, lower = upper, digits = '') {
  const map = {};
  const U = Array.from(upper);
  const L = Array.from(lower);
  const D = Array.from(digits);
  for (let i = 0; i < 26; i++) {
    map[UPPER[i]] = U[i];
    map[LOWER[i]] = L[i];
  }
  D.forEach((d, i) => { map[DIGITS[i]] = d; });
  return map;
}

function rangeMap(upperStart, lowerStart = upperStart) {
  const map = {};
  for (let i = 0; i < 26; i++) {
    map[UPPER[i]] = String.fromCodePoint(upperStart + i);
    map[LOWER[i]] = String.fromCodePoint(lowerStart + i);
  }
  return map;
}

const withDigits = (map, zero, oneStart) => {
  map['0'] = String.fromCodePoint(zero);
  for (let i = 1; i <= 9; i++) map[String(i)] = String.fromCodePoint(oneStart + i - 1);
  return map;
};

const mapper = (map) => (t) => Array.from(t).map((c) => map[c] ?? c).join('');
const combining = (mark) => (t) => Array.from(t).map((c) => (c === ' ' ? c : c + mark)).join('');
const joinWith = (sep) => (t) => Array.from(t).join(sep);
const reverse = (t) => Array.from(t).reverse().join('');

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function seededRandom(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MARKS_UP = Array.from({ length: 0x36f - 0x300 + 1 }, (_, i) => String.fromCodePoint(0x300 + i))
  .filter((c) => !/[̖-̳̹-̼͇ͅ-͉͍͎͓-͖͙͚͜͟͢]/.test(c));
const MARKS_DOWN = Array.from('̖̗̘̙̜̝̞̟̠̤̥̦̩̪̫̬̭̮̯̰̱̲̳̹̺̻̼͇͈͉͍͎͓͔͕͖͙͚ͅ');

function zalgo(up, down) {
  return (t) => {
    const rand = seededRandom(hashSeed(t + up + down));
    return Array.from(t).map((c) => {
      if (c === ' ') return c;
      let out = c;
      const nu = Math.floor(rand() * (up + 1));
      const nd = Math.floor(rand() * (down + 1));
      for (let i = 0; i < nu; i++) out += MARKS_UP[Math.floor(rand() * MARKS_UP.length)];
      for (let i = 0; i < nd; i++) out += MARKS_DOWN[Math.floor(rand() * MARKS_DOWN.length)];
      return out;
    }).join('');
  };
}

const LEET = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7', b: '8', g: '6' };
const leet = (t) => t.replace(/[aeiostbg]/gi, (c) => LEET[c.toLowerCase()]);
const altCaps = (t) => {
  let i = 0;
  return Array.from(t).map((c) => (/[a-z]/i.test(c) ? (i++ % 2 ? c.toUpperCase() : c.toLowerCase()) : c)).join('');
};

const fullwidthMap = (() => {
  const map = { ' ': '　' };
  for (let c = 0x21; c <= 0x7e; c++) map[String.fromCharCode(c)] = String.fromCodePoint(c + 0xfee0);
  return map;
})();

const flipMap = {
  ...lookMap('∀ꓭƆꓷƎℲ⅁HIſꓘ˥WNOԀΌꓤS⊥∩ΛMX⅄Z', 'ɐqɔpǝɟƃɥᴉɾʞlɯuodbɹsʇnʌʍxʎz', '0ƖᄅƐㄣϛ9ㄥ86'),
  '.': '˙', ',': "'", '!': '¡', '?': '¿', '_': '‾', '&': '⅋',
  '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<',
};

const mirrorMap = {
  ...lookMap('AᙠƆᗡƎꟻᎮHIႱᐴ⅃MИOꟼỌЯꙄTUVWXYƸ', 'ɒdɔbɘʇϱʜiįʞlmnoqpɿƨƚυvwxγz'),
  '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '/': '\\', '\\': '/',
};

const smallCaps = 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ';

// Each style: name, group, fn(text). "safe" styles only use characters Epic accepts.
const FONTS = [
  { name: 'Bold', group: 'Serif', fn: mapper(mathMap(0x1d400, 0x1d7ce)) },
  { name: 'Italic', group: 'Serif', fn: mapper(mathMap(0x1d434, 0, { h: 0x210e })) },
  { name: 'Bold Italic', group: 'Serif', fn: mapper(mathMap(0x1d468, 0x1d7ce)) },
  { name: 'Script', group: 'Cursive', fn: mapper(mathMap(0x1d49c, 0, { B: 0x212c, E: 0x2130, F: 0x2131, H: 0x210b, I: 0x2110, L: 0x2112, M: 0x2133, R: 0x211b, e: 0x212f, g: 0x210a, o: 0x2134 })) },
  { name: 'Bold Script', group: 'Cursive', fn: mapper(mathMap(0x1d4d0, 0x1d7ce)) },
  { name: 'Gothic', group: 'Medieval', fn: mapper(mathMap(0x1d504, 0, { C: 0x212d, H: 0x210c, I: 0x2111, R: 0x211c, Z: 0x2128 })) },
  { name: 'Bold Gothic', group: 'Medieval', fn: mapper(mathMap(0x1d56c, 0x1d7ce)) },
  { name: 'Double-Struck', group: 'Outline', fn: mapper(mathMap(0x1d538, 0x1d7d8, { C: 0x2102, H: 0x210d, N: 0x2115, P: 0x2119, Q: 0x211a, R: 0x211d, Z: 0x2124 })) },
  { name: 'Sans', group: 'Clean', fn: mapper(mathMap(0x1d5a0, 0x1d7e2)) },
  { name: 'Sans Bold', group: 'Clean', fn: mapper(mathMap(0x1d5d4, 0x1d7ec)) },
  { name: 'Sans Italic', group: 'Clean', fn: mapper(mathMap(0x1d608, 0x1d7e2)) },
  { name: 'Sans Bold Italic', group: 'Clean', fn: mapper(mathMap(0x1d63c, 0x1d7ec)) },
  { name: 'Monospace', group: 'Code', fn: mapper(mathMap(0x1d670, 0x1d7f6)) },
  { name: 'Fullwidth', group: 'Wide', fn: mapper(fullwidthMap) },
  { name: 'Vaporwave', group: 'Wide', fn: (t) => mapper(fullwidthMap)(t).split('').join(' ') },
  { name: 'Small Caps', group: 'Tiny', fn: mapper(lookMap(smallCaps, smallCaps)) },
  { name: 'Superscript', group: 'Tiny', fn: mapper(lookMap('ᴬᴮᶜᴰᴱᶠᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᑫᴿˢᵀᵁⱽᵂˣʸᶻ', 'ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖᑫʳˢᵗᵘᵛʷˣʸᶻ', '⁰¹²³⁴⁵⁶⁷⁸⁹')) },
  { name: 'Subscript', group: 'Tiny', fn: mapper(lookMap('ₐBCDₑFGₕᵢⱼₖₗₘₙₒₚQᵣₛₜᵤᵥWₓYZ', 'ₐbcdₑfgₕᵢⱼₖₗₘₙₒₚqᵣₛₜᵤᵥwₓyz', '₀₁₂₃₄₅₆₇₈₉')) },
  { name: 'Bubble', group: 'Bubble', fn: mapper(withDigits(rangeMap(0x24b6, 0x24d0), 0x24ea, 0x2460)) },
  { name: 'Dark Bubble', group: 'Bubble', fn: mapper(withDigits(rangeMap(0x1f150), 0x24ff, 0x2776)) },
  { name: 'Squares', group: 'Boxed', fn: mapper(rangeMap(0x1f130)) },
  { name: 'Dark Squares', group: 'Boxed', fn: mapper(rangeMap(0x1f170)) },
  { name: 'Parentheses', group: 'Boxed', fn: mapper(withDigits(rangeMap(0x1f110, 0x249c), 0x30, 0x2474)) },
  { name: 'Regional Letters', group: 'Boxed', fn: (t) => Array.from(mapper(rangeMap(0x1f1e6))(t)).join('‌') },
  { name: 'Upside Down', group: 'Flip', fn: (t) => reverse(mapper(flipMap)(t)) },
  { name: 'Mirror', group: 'Flip', fn: (t) => reverse(mapper(mirrorMap)(t)) },
  { name: 'Strikethrough', group: 'Lines', fn: combining('̶') },
  { name: 'Slashed', group: 'Lines', fn: combining('̸') },
  { name: 'Underline', group: 'Lines', fn: combining('̲') },
  { name: 'Double Underline', group: 'Lines', fn: combining('̳') },
  { name: 'Overline', group: 'Lines', fn: combining('̅') },
  { name: 'Wavy', group: 'Lines', fn: combining('̴') },
  { name: 'Crossed', group: 'Lines', fn: combining('̽') },
  { name: 'Dotted', group: 'Lines', fn: combining('̤') },
  { name: 'Hearts Between', group: 'Spaced', fn: joinWith('♥') },
  { name: 'Stars Between', group: 'Spaced', fn: joinWith('✦') },
  { name: 'Wide Spaced', group: 'Spaced', fn: joinWith(' ') },
  { name: 'Glitch', group: 'Chaos', fn: zalgo(1, 1) },
  { name: 'Zalgo', group: 'Chaos', fn: zalgo(4, 3) },
  { name: 'Cursed', group: 'Chaos', fn: zalgo(9, 7) },
  { name: 'Faux Greek', group: 'Lookalike', fn: mapper(lookMap('ΛBᄃDΣFGΉIJKᄂMПӨPQЯƧƬЦVЩXYZ')) },
  { name: 'Faux Cyrillic', group: 'Lookalike', fn: mapper(lookMap('ДБCDΞFGHIJҜLMИФPǪЯЅТЦVЩЖЧZ')) },
  { name: 'Currency', group: 'Lookalike', fn: mapper(lookMap('₳฿₵ĐɆ₣₲ⱧłJ₭Ⱡ₥₦Ø₱QⱤ₴₮ɄV₩ӾɎⱫ')) },
  { name: 'Asian Style', group: 'Lookalike', fn: mapper(lookMap('卂乃匚ᗪ乇千Ꮆ卄丨ﾌҜㄥ爪几ㄖ卩Ɋ尺丂ㄒㄩᐯ山乂ㄚ乙')) },
  { name: 'Wizard', group: 'Lookalike', fn: mapper(lookMap('ꍏꌃꏳꀷꏂꎇꁅꀍꀤ꒻ꀘ꒒ꎭꈤꂦᖘꆰꋪꌚ꓄ꀎ꒦ꅐꉧꌩꁴ')) },
  { name: 'Ancient', group: 'Lookalike', fn: mapper(lookMap('ልጌርዕቿቻኗዘጎጋጕረጠክዐየዒዪነፕሁሀሠሸሃጊ')) },
  { name: 'Runes', group: 'Lookalike', fn: mapper(lookMap('ᚨᛒᚲᛞᛖᚠᚷᚺᛁᛃᚲᛚᛗᚾᛟᛈᛩᚱᛋᛏᚢᚡᚹᛪᛃᛉ')) },
  { name: 'Bent', group: 'Lookalike', fn: mapper(lookMap('ąҍçժҽƒցհìʝҟӀʍղօքզɾʂէմѵա×վՀ')) },
  { name: 'Rock Dots', group: 'Lookalike', fn: mapper(lookMap('ÄḄĊḊЁḞĠḦЇJḲḶṀṄÖṖQṚṠṪÜṾẄẌŸŻ', 'äḅċḋëḟġḧïjḳḷṁṅöṗqṛṡẗüṿẅẍÿż')) },
  { name: 'L33t', group: 'Epic-safe', fn: leet, safe: true },
  { name: 'aLtErNaTe', group: 'Epic-safe', fn: altCaps, safe: true },
  { name: 'UPPER', group: 'Epic-safe', fn: (t) => t.toUpperCase(), safe: true },
  { name: 'lower', group: 'Epic-safe', fn: (t) => t.toLowerCase(), safe: true },
  { name: 'Reversed', group: 'Epic-safe', fn: reverse, safe: true },
  { name: 'Under_scored', group: 'Epic-safe', fn: (t) => t.trim().replace(/\s+/g, '_'), safe: true },
  { name: 'Dot.ted', group: 'Epic-safe', fn: (t) => t.trim().replace(/\s+/g, '.'), safe: true },
];

const NORMAL = { name: 'Normal', group: 'Plain', fn: (t) => t, safe: true };

// [left, right, safe?]
const FRAMES = [
  ['꧁', '꧂'], ['꧁༺', '༻꧂'], ['꧁☬', '☬꧂'], ['◥꧁ད', 'ཌ꧂◤'], ['★彡', '彡★'], ['亗 ', ' 亗'], ['乂 ', ' 乂'],
  ['『', '』'], ['【', '】'], ['〖', '〗'], ['「', '」'], ['《', '》'], ['⟦', '⟧'], ['『✦', '✦』'],
  ['⚡', '⚡'], ['☠ ', ' ☠'], ['♛ ', ' ♛'], ['⚔ ', ' ⚔'], ['☾ ', ' ☽'], ['༒', '༒'], ['❖ ', ' ❖'],
  ['✿ ', ' ✿'], ['ღ ', ' ღ'], ['⋆｡°✩ ', ' ✩°｡⋆'], ['˚₊‧ ', ' ‧₊˚'], ['✧･ﾟ ', ' ﾟ･✧'], ['•°• ', ' •°•'],
  ['▄︻デ ', ' ══━一'], ['➶ ', ' ➴'], ['⫷ ', ' ⫸'], ['»', '«'], ['╰☆☆ ', ' ☆☆╮'], ['◦•●◉✿ ', ' ✿◉●•◦'],
  ['𓆩', '𓆪'], ['ᴹᴿ᭄', ''], ['', '᭄ꦿ'], ['', ' ツ'], ['ᴳᵒᵈ ', ''], ['', ' ᴮᴼˢˢ'], ['×͜× ', ''], ['ꔪ ', ' ꔪ'],
  ['xX', 'Xx', true], ['iTz', '', true], ['TTV ', '', true], ['', ' YT', true], ['', ' FN', true],
  ['Not', '', true], ['The', '', true], ['', '.exe', true], ['_', '_', true], ['', ' 1v1', true],
];

// ---------- Name generator ----------

const VIBES = {
  sweaty: {
    label: '🔥 Sweaty',
    adj: ['Cracked', 'Sweaty', 'Clutch', 'Tilted', 'Toxic', 'Swift', 'Rapid', 'Lethal', 'Silent', 'Frosty', 'Savage', 'Turbo', 'Hyper', 'Prime', 'Elite', 'Quick', 'Wild', 'Ghost'],
    noun: ['Builder', 'Editor', 'Sniper', 'Boxer', 'Fragger', 'Cranker', 'Piece', 'Zone', 'Shot', 'Aim', 'Clip', 'Ramp', 'Edit', 'Storm', 'Drop', 'Peak', 'Spray', 'Flick'],
  },
  aesthetic: {
    label: '🌸 Aesthetic',
    adj: ['Soft', 'Velvet', 'Lunar', 'Pastel', 'Hazy', 'Misty', 'Golden', 'Dreamy', 'Faded', 'Lucid', 'Silky', 'Cosmic', 'Lofi', 'Rosy', 'Pale', 'Starry'],
    noun: ['Luna', 'Haze', 'Mist', 'Echo', 'Nova', 'Aura', 'Cloud', 'Sakura', 'Bloom', 'Petal', 'Dream', 'Vapor', 'Solace', 'Ember', 'Opal', 'Moon', 'Halo', 'Lilac'],
  },
  dark: {
    label: '💀 Dark',
    adj: ['Dark', 'Cursed', 'Hollow', 'Grim', 'Wicked', 'Fallen', 'Silent', 'Blood', 'Shadow', 'Toxic', 'Broken', 'Lost', 'Feral', 'Vile', 'Dread', 'Night'],
    noun: ['Reaper', 'Void', 'Wraith', 'Hex', 'Doom', 'Venom', 'Raven', 'Nyx', 'Phantom', 'Abyss', 'Omen', 'Specter', 'Demon', 'Skull', 'Viper', 'Crow', 'Fang', 'Soul'],
  },
  funny: {
    label: '🤪 Funny',
    adj: ['Default', 'Sleepy', 'Spicy', 'Crusty', 'Soggy', 'Lil', 'Big', 'Angry', 'Sneaky', 'Chunky', 'Cheesy', 'Wobbly', 'Salty', 'Lazy', 'Smol', 'Feral'],
    noun: ['Toast', 'Potato', 'Nugget', 'Pickle', 'Banana', 'Waffle', 'Goose', 'Taco', 'Burrito', 'Llama', 'Noodle', 'Bush', 'Camper', 'Goblin', 'Gremlin', 'Bean', 'Muffin', 'Penguin'],
  },
  royal: {
    label: '👑 Royal',
    adj: ['Royal', 'King', 'Lord', 'Alpha', 'Mighty', 'Grand', 'Iron', 'Golden', 'Supreme', 'Divine', 'Noble', 'Epic', 'Mythic', 'Ancient', 'Imperial', 'Sacred'],
    noun: ['King', 'Queen', 'Ace', 'Titan', 'Legend', 'Emperor', 'Knight', 'Warlord', 'Monarch', 'Zeus', 'Atlas', 'Dragon', 'Lion', 'Phoenix', 'Crown', 'Throne', 'Baron', 'Duke'],
  },
  tech: {
    label: '⚡ Tech',
    adj: ['Cyber', 'Neon', 'Turbo', 'Nitro', 'Quantum', 'Digital', 'Pixel', 'Binary', 'Atomic', 'Laser', 'Sonic', 'Hyper', 'Glitch', 'Electric', 'Plasma', 'Retro'],
    noun: ['Byte', 'Pixel', 'Glitch', 'Bot', 'Volt', 'Code', 'Zero', 'Core', 'Node', 'Circuit', 'Chip', 'Hz', 'Drone', 'Matrix', 'Vector', 'Proxy', 'Kernel', 'Data'],
  },
  beast: {
    label: '🐺 Beast',
    adj: ['Wild', 'Frost', 'Storm', 'Thunder', 'Blaze', 'Savage', 'Arctic', 'Venom', 'Night', 'Iron', 'Swift', 'Shadow', 'Alpha', 'Lone', 'Rabid', 'Primal'],
    noun: ['Wolf', 'Tiger', 'Falcon', 'Shark', 'Cobra', 'Panther', 'Hawk', 'Bear', 'Fox', 'Lynx', 'Viper', 'Raptor', 'Eagle', 'Jaguar', 'Rhino', 'Kraken', 'Mamba', 'Orca'],
  },
  og: { label: '💎 OG Short', adj: [], noun: [] },
};

const PREFIXES = ['iTz', 'Its', 'Not', 'The', 'Mr', 'Lil', 'Big', 'Sir', 'OG', 'Pro', 'Real', 'Just', 'TTV', 'YT', 'xX'];
const SUFFIXES = ['FN', 'YT', 'TTV', 'x', 'z', 'Gg', 'HD', 'Pro', 'OG', 'Szn', 'God', 'Main', 'OnTop', 'Plays', 'Mode', 'ify', 'ish', 'Xx'];
const NUMBERS = ['1', '2', '3', '7', '9', '0', '11', '13', '21', '22', '23', '24', '33', '47', '77', '88', '99', '101', '247', '404', '777', '999'];
const SEPS = ['', '_', '.', '-', ' '];

function syllableName() {
  const cons = 'bdfgjklmnprstvzxkzvnrl';
  const vow = 'aeiouy';
  const shapes = ['cvc', 'cvcv', 'vcv', 'cvcvc', 'cvcv', 'cvc'];
  const shape = pick(shapes);
  let out = '';
  for (const s of shape) out += s === 'c' ? pick(cons) : pick(vow);
  return [out];
}

function capWord(w) {
  if (/[A-Z]/.test(w.slice(1))) return w; // keep iTz, TTV, OnTop as-is
  return w.charAt(0).toUpperCase() + w.slice(1);
}

function applyCaps(parts, mode) {
  switch (mode) {
    case 'lower': return parts.map((p) => p.toLowerCase());
    case 'upper': return parts.map((p) => p.toUpperCase());
    case 'alt': return parts.map(capWord);
    default: return parts.map(capWord);
  }
}

function cleanKeyword(k) {
  return k.replace(/[^A-Za-z0-9]/g, '');
}

function makeName(opts) {
  const vibeKeys = opts.vibes.length ? opts.vibes : Object.keys(VIBES);
  const vibe = VIBES[pick(vibeKeys)];
  const isOG = vibe === VIBES.og;
  const pool = isOG ? VIBES[pick(Object.keys(VIBES).filter((k) => k !== 'og'))] : vibe;
  const kw = opts.keywords.length ? pick(opts.keywords) : null;

  let parts;
  if (isOG) {
    parts = kw && chance(0.4) ? [kw.slice(0, Math.max(3, Math.min(5, kw.length)))] : syllableName();
    if (chance(0.25)) parts[0] += pick(['x', 'z', 'o', 'y']);
  } else if (kw) {
    const shapes = [
      () => [kw, pick(pool.noun)],
      () => [pick(pool.adj), kw],
      () => [kw, pick(pool.adj)],
      () => [pick(pool.noun), kw],
      () => [kw],
      () => [kw.replace(/(?!^)[aeiou]/gi, ''), pick(pool.noun)],
      () => [kw + kw.slice(-1).repeat(2)],
      () => [kw + (/[aeiou]$/i.test(kw) ? 'x' : 'y')],
    ];
    parts = pick(shapes)();
  } else {
    const shapes = [
      () => [pick(pool.adj), pick(pool.noun)],
      () => [pick(pool.adj), pick(pool.noun)],
      () => [pick(pool.noun), pick(pool.noun)],
      () => [pick(pool.noun)],
      () => [pick(pool.adj), pick(VIBES[pick(Object.keys(VIBES).filter((k) => k !== 'og'))].noun)],
    ];
    parts = pick(shapes)();
  }

  if (opts.decor && !isOG) {
    if (chance(0.22)) parts.unshift(pick(PREFIXES));
    else if (chance(0.22)) parts.push(pick(SUFFIXES));
  }

  const capsMode = opts.caps === 'mix' ? pick(['camel', 'camel', 'lower', 'upper', 'alt']) : opts.caps;
  parts = applyCaps(parts.filter(Boolean), capsMode);

  let sep = opts.sep === 'mix' ? pick(SEPS) : opts.sep;
  if (parts.length === 1) sep = '';
  let name = parts.join(sep);

  if (name.startsWith('xX') && !name.endsWith('Xx') && chance(0.7)) name += 'Xx';
  if (opts.nums === 'always' || (opts.nums === 'some' && chance(0.3))) {
    name += (sep && chance(0.5) ? sep : '') + pick(NUMBERS);
  }
  if (opts.leet && chance(0.3)) name = leet(name);
  if (capsMode === 'alt') name = altCaps(name);
  return name;
}

function generateNames(opts, count) {
  const out = new Set();
  let tries = 0;
  while (out.size < count && tries < count * 60) {
    tries++;
    const n = makeName(opts);
    const len = charCount(n);
    if (len < opts.min || len > opts.max) continue;
    if (n !== n.trim()) continue;
    out.add(n);
  }
  return [...out];
}

// ---------- Symbols ----------

const SYMBOLS = [
  ['Popular in names', '★ ☆ ✦ ✧ ⚡ ☠ ♛ ♕ ♚ 亗 乂 ツ ッ シ 彡 ღ ♡ ♥ ❤ ✿ ❀ ☯ ⚔ ✞ ☬ ༒ ꧁ ꧂ ࿐ ༺ ༻ ϟ ☾ ☽ ⚜ ❖ ꔪ 𓆩 𓆪 ᭄ ꦿ'],
  ['Stars & sparkles', '⋆ ✩ ✪ ✫ ✬ ✭ ✮ ✯ ✰ ✶ ✷ ✸ ✹ ✺ ❂ ✴ ✵ ❃ ❋ ✱ ✲ ✳ ❇ ❈ ❉ ❊ ⁂ ⁎ ⁑ ˚ ° ₊ ‧ ⊹ ✼ ❄ ❅ ❆'],
  ['Hearts', '♡ ♥ ❤ ❥ ❣ ❦ ❧ ღ ۵ ❤︎ ♥︎ ɞ ε ⸜ ⸝'],
  ['Crowns & power', '♔ ♕ ♖ ♗ ♘ ♙ ♚ ♛ ♜ ♝ ♞ ♟ ⚜ ☬ ♆ ☤ ⚚ ⚕ ✠ ✙ ✚ ✛ ✜ ✝ ✟ ⛧'],
  ['Weapons & danger', '⚔ 🗡 ☠ ☢ ☣ ⚠ ϟ ↯ ⌖ ⊕ ⨁ ⨂ ⛨ ︻デ═一 ▄︻デ══━一 ⌐╦╦═─ ━╤デ╦︻'],
  ['Japanese & Chinese', '亗 乂 彡 ツ シ ッ ン 龍 鬼 神 王 死 愛 夢 光 闇 炎 氷 風 雷 侍 忍 狼 虎 刀 武 道 影 魂 天 星 月 花 桜 猫 狐 鷹'],
  ['Brackets', '『 』 「 」 【 】 〖 〗 《 》 〈 〉 ⟦ ⟧ ⟨ ⟩ ⦃ ⦄ ⦅ ⦆ 〘 〙 〚 〛 ﴾ ﴿ ⁅ ⁆ ⌈ ⌋ ⫷ ⫸ » «'],
  ['Arrows', '→ ← ↑ ↓ ↔ ⇒ ⇐ ⇑ ⇓ ➤ ➜ ➔ ➶ ➴ ➹ ➸ ➳ ➵ ⟶ ⟵ ↬ ↫ ⇝ ⇜ ↺ ↻ ⤴ ⤵ ↗ ↘ ↙ ↖'],
  ['Shapes & lines', '■ □ ▪ ▫ ▲ △ ▼ ▽ ◆ ◇ ○ ● ◎ ◉ ◈ ▣ ◐ ◑ ░ ▒ ▓ █ ▄ ▀ ═ ━ ─ │ ┃ ╰ ╯ ╭ ╮ ◢ ◣ ◤ ◥ ⬡ ⬢'],
  ['Greek & math', 'α β γ δ ε ζ η θ λ μ ξ π σ φ ψ ω Ω Σ Δ Φ Ψ Λ ∞ ∑ √ ≈ ≠ ± ∅ ∇ ∴ ∵ ∫ ∂ ⊗ ⊘ ∆'],
  ['Money & marks', '$ € £ ¥ ₿ ¢ ₹ ₩ ₽ ₺ § ¶ © ® ™ ℗ ℠ † ‡ • · ¤ № ℃ ℉'],
  ['Nature & weather', '☀ ☁ ☂ ☃ ☄ ❄ ☘ ⚘ ✾ ❁ ❀ ✿ ❦ ☼ ☽ ☾ ⛅ ⛈ 🌙 🔥 🌊 🌪 🌸 🍀'],
  ['Cards & music', '♠ ♣ ♥ ♦ ♤ ♧ ♡ ♢ ♩ ♪ ♫ ♬ ♭ ♮ ♯ 🂡 🃏'],
  ['Emoji', '🔥 💀 👑 ⚡ 💎 🎯 🐐 🦅 🐺 🐉 👻 ☄️ 🌙 ⭐ 🎮 🏆 💯 😈 🗡️ 🛡️ 🥷 🦈 🐍 🦊 🍕 🌈 💜 🖤 🤍 ❤️‍🔥'],
  ['Name tags', 'ᴳᵒᵈ ᴮᴼˢˢ ᴹᴿ ᴷᴵᴺᴳ ᴾᴿᴼ ᴼᴳ ᵀᵀⱽ ʸᵗ ˣ ᶻ ✓ ✔ ✗ ✘ ×͜×'],
  ['Kaomoji', 'ʕ•ᴥ•ʔ|( ͡° ͜ʖ ͡°)|¯\\_(ツ)_/¯|(╯°□°)╯︵ ┻━┻|ᕦ(ò_óˇ)ᕤ|(◣_◢)|ಠ_ಠ|(•̀ᴗ•́)و|(っ◔◡◔)っ|(ง •̀_•́)ง|٩(◕‿◕)۶|(✿◠‿◠)|(ノ◕ヮ◕)ノ*:･ﾟ✧|ʘ‿ʘ|(⌐■_■)', '|'],
];

const INVISIBLE = [
  ['Hangul filler (blank)', 'ㅤ'],
  ['Braille blank', '⠀'],
  ['Zero-width space', '​'],
  ['Em space', ' '],
  ['Thin space', ' '],
];

// ---------- Saved ----------

let saved = load('nameLabSaved', []);

function isSaved(text) {
  return saved.includes(text);
}

function toggleSaved(text) {
  if (isSaved(text)) {
    saved = saved.filter((s) => s !== text);
    toast('Removed from saved');
  } else {
    saved.unshift(text);
    toast('Saved ★');
  }
  save('nameLabSaved', saved);
  renderSaved();
  refreshStars();
}

function refreshStars() {
  document.querySelectorAll('[data-star]').forEach((btn) => {
    const on = isSaved(btn.dataset.star);
    btn.classList.toggle('on', on);
    btn.textContent = on ? '★' : '☆';
    btn.setAttribute('aria-label', on ? 'Remove from saved' : 'Save');
  });
}

function resultRow(name, { styleBtn = true, removeBtn = false } = {}) {
  const row = document.createElement('div');
  row.className = 'result';
  const safe = escapeHTML(name);
  row.innerHTML = `
    <div class="name-wrap" style="flex:1;min-width:0">
      <div class="name" title="Copy">${safe}</div>
      <div class="sub"><span class="count">${charCount(name)}/${EPIC_MAX}</span>${badgeHTML(name)}</div>
    </div>
    <button type="button" class="icon" data-act="copy" aria-label="Copy">⧉</button>
    ${styleBtn ? '<button type="button" class="icon" data-act="style" aria-label="Style with fonts">Aa</button>' : ''}
    ${removeBtn ? '<button type="button" class="icon" data-act="remove" aria-label="Remove">✕</button>'
      : `<button type="button" class="icon" data-star="${safe}">☆</button>`}
  `;
  row.querySelector('.name').addEventListener('click', () => copyText(name));
  row.querySelector('[data-act="copy"]').addEventListener('click', () => copyText(name));
  row.querySelector('[data-act="style"]')?.addEventListener('click', () => {
    setBase(name);
    showTab('fonts');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  row.querySelector('[data-act="remove"]')?.addEventListener('click', () => toggleSaved(name));
  row.querySelector('[data-star]')?.addEventListener('click', () => toggleSaved(name));
  return row;
}

function renderSaved() {
  const list = $('#savedList');
  list.innerHTML = '';
  saved.forEach((s) => list.appendChild(resultRow(s, { styleBtn: epicStatus(s).safe, removeBtn: true })));
  $('#savedCount').textContent = saved.length;
  $('#savedEmpty').hidden = saved.length > 0;
}

// ---------- Workbench ----------

const baseInput = () => $('#base');
const baseText = () => baseInput().value || SAMPLE;

function setBase(text) {
  baseInput().value = text;
  onBaseChange();
}

function updateBenchMeta() {
  const v = baseInput().value;
  const n = charCount(v);
  const count = $('#baseCount');
  count.textContent = `${n}/${EPIC_MAX}`;
  count.classList.toggle('over', n > EPIC_MAX);
  const badge = $('#baseBadge');
  if (!v) {
    badge.className = 'badge';
    badge.textContent = '—';
  } else {
    const st = epicStatus(v);
    badge.className = `badge ${st.cls}`;
    badge.textContent = st.tip ? 'Fancy · Epic may reject' : st.label;
  }
}

let renderQueued = false;
function onBaseChange() {
  updateBenchMeta();
  save('nameLabBase', baseInput().value);
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderFonts();
    renderDecor();
    renderLogos();
  });
}

function insertAtCursor(text) {
  const input = baseInput();
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
  onBaseChange();
}

// ---------- Fonts tab ----------

function styleCard(label, text, meta = '') {
  const card = document.createElement('div');
  card.className = 'card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  const safe = escapeHTML(text);
  card.innerHTML = `
    <div class="card-head">
      <span class="label">${escapeHTML(label)}</span>
      ${meta}
      <button type="button" class="icon" data-star="${safe}">☆</button>
    </div>
    <div class="out">${safe}</div>`;
  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-star]')) return;
    copyText(text);
  });
  card.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === card) {
      e.preventDefault();
      copyText(text);
    }
  });
  card.querySelector('[data-star]').addEventListener('click', () => toggleSaved(text));
  return card;
}

function renderFonts() {
  const list = $('#fontList');
  const q = $('#fontSearch').value.trim().toLowerCase();
  const safeOnly = $('#safeOnly').checked;
  const text = baseText();
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const f of FONTS) {
    if (q && !`${f.name} ${f.group}`.toLowerCase().includes(q)) continue;
    const out = f.fn(text);
    if (safeOnly && !epicStatus(out).safe) continue;
    frag.appendChild(styleCard(`${f.name}`, out, `<span class="count">${charCount(out)}</span>${badgeHTML(out)}`));
  }
  list.appendChild(frag);
  if (!list.children.length) list.innerHTML = '<p class="note">No styles match.</p>';
  refreshStars();
}

// ---------- Decorate tab ----------

const DECO_FONTS = [NORMAL, ...FONTS];

function renderDecor() {
  const list = $('#decoList');
  const font = DECO_FONTS[Number($('#decoFont').value) || 0];
  const styled = font.fn(baseText());
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  FRAMES.forEach(([l, r]) => {
    const out = l + styled + r;
    frag.appendChild(styleCard(font.name, out, `<span class="count">${charCount(out)}</span>${badgeHTML(out)}`));
  });
  list.appendChild(frag);
  refreshStars();
}

// ---------- Symbols tab ----------

let symbolMode = 'insert';

function renderSymbols() {
  const root = $('#symbolList');
  const frag = document.createDocumentFragment();
  const addGroup = (title, items) => {
    const group = document.createElement('div');
    group.className = 'sym-group';
    group.innerHTML = `<h3>${escapeHTML(title)}</h3><div class="sym-grid"></div>`;
    const grid = group.querySelector('.sym-grid');
    items.forEach(([label, value]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sym';
      if (label !== value) b.classList.add('named');
      else if (charCount(value) > 2) b.classList.add('wide');
      b.textContent = label;
      b.title = label === value ? value : label;
      b.addEventListener('click', () => {
        if (symbolMode === 'copy') {
          copyText(value);
        } else {
          insertAtCursor(value);
          toast(`Added ${label === value ? value : label}`);
        }
      });
      grid.appendChild(b);
    });
    frag.appendChild(group);
  };
  SYMBOLS.forEach(([title, chars, splitOn = ' ']) => {
    addGroup(title, chars.split(splitOn).filter(Boolean).map((c) => [c, c]));
  });
  addGroup('Invisible & spaces (often rejected by Epic)', INVISIBLE);
  root.appendChild(frag);

  document.querySelectorAll('.seg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      symbolMode = btn.dataset.mode;
      document.querySelectorAll('.seg button').forEach((b) => {
        b.classList.toggle('on', b === btn);
        b.setAttribute('aria-checked', String(b === btn));
      });
    });
  });
}

// ---------- Logo fonts tab ----------

const LOGO_FONTS = [
  'Bangers', 'Luckiest Guy', 'Permanent Marker', 'Press Start 2P', 'Orbitron', 'Audiowide', 'Monoton', 'Bungee',
  'Bungee Shade', 'Black Ops One', 'Creepster', 'Pacifico', 'Lobster', 'Righteous', 'Russo One', 'Faster One',
  'Rubik Glitch', 'Rubik Wet Paint', 'Nosifer', 'Fredoka', 'Sedgwick Ave Display', 'Cinzel Decorative',
  'UnifrakturMaguntia', 'Silkscreen', 'VT323', 'Major Mono Display', 'Bebas Neue', 'Anton', 'Kaushan Script',
  'Great Vibes', 'Satisfy', 'Shrikhand', 'Rampart One', 'Special Elite', 'Zen Dots', 'Exo 2', 'Teko',
  'Metal Mania', 'Pirata One', 'Londrina Solid', 'Titan One', 'Rubik Mono One',
];

let logoFontsLoaded = false;
function ensureLogoFonts() {
  if (logoFontsLoaded) return;
  logoFontsLoaded = true;
  const families = LOGO_FONTS.map((f) => `family=${f.replace(/ /g, '+')}`).join('&');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
  document.head.appendChild(link);
}

function logoSettings() {
  return {
    fx: $('#logoFx').value,
    c1: $('#logoC1').value,
    c2: $('#logoC2').value,
    bg: $('#logoBg').value,
  };
}

function applyLogoVars() {
  const { fx, c1, c2 } = logoSettings();
  const grid = $('#logoList');
  grid.className = `logo-grid fx-${fx}`;
  grid.style.setProperty('--c1', c1);
  grid.style.setProperty('--c2', c2);
  save('nameLabLogo', logoSettings());
}

function renderLogos() {
  const grid = $('#logoList');
  if (!grid.children.length) {
    const frag = document.createDocumentFragment();
    LOGO_FONTS.forEach((font) => {
      const card = document.createElement('div');
      card.className = 'logo-card';
      card.innerHTML = `
        <div class="card-head"><span class="label">${font}</span>
          <span><button type="button" class="btn" data-act="png">PNG</button></span></div>
        <div class="logo-text" style="font-family:'${font}', sans-serif"></div>`;
      card.querySelector('[data-act="png"]').addEventListener('click', () => downloadLogo(font));
      frag.appendChild(card);
    });
    grid.appendChild(frag);
  }
  const text = baseText();
  grid.querySelectorAll('.logo-text').forEach((el) => { el.textContent = text; });
}

async function downloadLogo(font) {
  const text = baseText();
  const { fx, c1, c2, bg } = logoSettings();
  const size = 160;
  const fontCss = `${size}px "${font}"`;
  try {
    await document.fonts.load(fontCss, text);
  } catch {
    // draw with whatever is available
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = fontCss;
  const m = ctx.measureText(text);
  const pad = Math.round(size * 0.45);
  const ascent = m.actualBoundingBoxAscent || size * 0.8;
  const descent = m.actualBoundingBoxDescent || size * 0.25;
  canvas.width = Math.ceil(m.width + pad * 2);
  canvas.height = Math.ceil(ascent + descent + pad * 2);

  if (bg !== 'transparent') {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.font = fontCss;
  ctx.textBaseline = 'alphabetic';
  const x = pad;
  const y = pad + ascent;

  switch (fx) {
    case 'gradient': {
      const g = ctx.createLinearGradient(x, 0, x + m.width, 0);
      g.addColorStop(0, c1);
      g.addColorStop(1, c2);
      ctx.fillStyle = g;
      ctx.fillText(text, x, y);
      break;
    }
    case 'neon':
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = c1;
      [40, 20, 8].forEach((blur) => {
        ctx.shadowBlur = blur;
        ctx.fillText(text, x, y);
      });
      break;
    case 'outline':
      ctx.fillStyle = c2;
      ctx.fillText(text, x, y);
      ctx.lineWidth = size / 18;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = c1;
      ctx.strokeText(text, x, y);
      break;
    case 'three': {
      const depth = Math.round(size / 18);
      ctx.fillStyle = c2;
      for (let i = depth; i > 0; i--) ctx.fillText(text, x + i, y + i);
      ctx.fillStyle = c1;
      ctx.fillText(text, x, y);
      break;
    }
    default:
      ctx.fillStyle = c1;
      ctx.fillText(text, x, y);
  }

  canvas.toBlob((blob) => {
    if (!blob) return toast('Could not create image');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${text.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'name'}-${font.replace(/\s+/g, '')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('PNG downloaded');
  }, 'image/png');
}

// ---------- Tabs ----------

function showTab(name) {
  document.querySelectorAll('.tabs [role="tab"]').forEach((t) => {
    t.setAttribute('aria-selected', String(t.dataset.tab === name));
  });
  document.querySelectorAll('.panel').forEach((p) => {
    p.hidden = p.id !== `panel-${name}`;
  });
  if (name === 'logo') ensureLogoFonts();
  save('nameLabTab', name);
}

// ---------- Generator UI ----------

let lastOpts = null;

function readGenOptions() {
  let min = Math.max(EPIC_MIN, Math.min(EPIC_MAX, Number($('#minLen').value) || EPIC_MIN));
  let max = Math.max(EPIC_MIN, Math.min(EPIC_MAX, Number($('#maxLen').value) || EPIC_MAX));
  if (min > max) [min, max] = [max, min];
  return {
    keywords: $('#keywords').value.split(/[,\s]+/).map(cleanKeyword).filter((k) => k.length >= 2),
    vibes: [...document.querySelectorAll('#vibes .chip[aria-pressed="true"]')].map((c) => c.dataset.vibe),
    sep: $('#sep').value,
    caps: $('#caps').value,
    nums: $('#nums').value,
    leet: $('#leet').checked,
    decor: $('#decor').checked,
    min,
    max,
  };
}

function showNames(append) {
  const opts = append && lastOpts ? lastOpts : readGenOptions();
  lastOpts = opts;
  const list = $('#genResults');
  if (!append) list.innerHTML = '';
  const existing = new Set([...list.querySelectorAll('.name')].map((n) => n.textContent));
  const names = generateNames(opts, 30).filter((n) => !existing.has(n));
  if (!names.length && !append) {
    list.innerHTML = '<p class="note">No names fit those settings — try a wider length range.</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  names.forEach((n) => frag.appendChild(resultRow(n)));
  list.appendChild(frag);
  refreshStars();
}

function setupGenerator() {
  const vibesEl = $('#vibes');
  Object.entries(VIBES).forEach(([key, v]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.vibe = key;
    chip.textContent = v.label;
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => {
      const on = chip.getAttribute('aria-pressed') !== 'true';
      chip.setAttribute('aria-pressed', String(on));
      if (key === 'og' && on) {
        $('#maxLen').value = 6;
      }
    });
    vibesEl.appendChild(chip);
  });

  $('#genForm').addEventListener('submit', (e) => {
    e.preventDefault();
    showNames(false);
  });
  $('#moreNames').addEventListener('click', () => showNames(true));
}

// ---------- Surprise me ----------

function surprise() {
  const font = pick(FONTS.filter((f) => !['Cursed', 'Zalgo', 'Wide Spaced', 'Vaporwave'].includes(f.name)));
  const [l, r] = pick(FRAMES);
  const out = l + font.fn(baseText()) + r;
  copyText(out);
}

// ---------- Init ----------

function init() {
  const decoSelect = $('#decoFont');
  DECO_FONTS.forEach((f, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = f.name;
    decoSelect.appendChild(opt);
  });
  decoSelect.value = String(DECO_FONTS.findIndex((f) => f.name === 'Bold Script'));

  baseInput().value = load('nameLabBase', '');
  baseInput().addEventListener('input', onBaseChange);
  $('#copyBase').addEventListener('click', () => {
    if (baseInput().value) copyText(baseInput().value);
    else toast('Type a name first');
  });
  $('#clearBase').addEventListener('click', () => {
    setBase('');
    baseInput().focus();
  });
  $('#surprise').addEventListener('click', surprise);

  $('#fontSearch').addEventListener('input', renderFonts);
  $('#safeOnly').addEventListener('change', renderFonts);
  decoSelect.addEventListener('change', renderDecor);
  $('#decoRandom').addEventListener('click', () => {
    decoSelect.value = String(1 + Math.floor(Math.random() * FONTS.length));
    renderDecor();
  });

  const logo = load('nameLabLogo', null);
  if (logo) {
    $('#logoFx').value = logo.fx;
    $('#logoC1').value = logo.c1;
    $('#logoC2').value = logo.c2;
    $('#logoBg').value = logo.bg;
  }
  ['#logoFx', '#logoC1', '#logoC2', '#logoBg'].forEach((sel) => $(sel).addEventListener('input', applyLogoVars));
  applyLogoVars();

  $('#copyAllSaved').addEventListener('click', () => {
    if (saved.length) copyText(saved.join('\n'));
  });
  $('#clearSaved').addEventListener('click', () => {
    if (!saved.length || !confirm('Remove all saved names?')) return;
    saved = [];
    save('nameLabSaved', saved);
    renderSaved();
    refreshStars();
  });

  document.querySelectorAll('.tabs [role="tab"]').forEach((t) => {
    t.addEventListener('click', () => showTab(t.dataset.tab));
  });

  setupGenerator();
  renderSymbols();
  renderSaved();
  onBaseChange();
  const tab = load('nameLabTab', 'finder');
  showTab(document.getElementById(`panel-${tab}`) ? tab : 'finder');
  showNames(false);
}

document.addEventListener('DOMContentLoaded', init);
