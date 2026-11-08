// Turns raw tiktok-live-connector payloads into small, stable event objects.
// The library has shipped several payload shapes (v1/v2 vs v3 protobufs), so
// every field falls back across the known names.

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const firstUrl = (img) => (img && Array.isArray(img.urlList) && img.urlList[0]) || img?.url || '';

export function normalizeUser(u) {
  if (!u) return { id: '', username: 'unknown', nickname: 'unknown', avatar: '' };
  const username = u.uniqueId || u.displayId || u.username || u.nickname || String(u.userId || u.id || 'unknown');
  return {
    id: String(u.userId || u.id || username),
    username,
    nickname: u.nickname || username,
    avatar: firstUrl(u.avatarThumb) || u.profilePictureUrl || '',
  };
}

export function chat(d) {
  return { type: 'chat', user: normalizeUser(d.user), text: String(d.content ?? d.comment ?? '') };
}

export function gift(d) {
  const g = d.gift || {};
  const details = d.giftDetails || {};
  const ext = d.extendedGiftInfo || {};
  const giftType = num(g.type ?? details.giftType ?? ext.type);
  // Streakable gifts (type 1) fire repeatedly; only the final event (repeatEnd) is counted.
  const streaking = giftType === 1 && !d.repeatEnd;
  return {
    type: 'gift',
    user: normalizeUser(d.user),
    giftId: String(d.giftId ?? g.id ?? ''),
    giftName: g.name || details.giftName || ext.name || `Gift #${d.giftId}`,
    diamonds: num(g.diamondCount ?? details.diamondCount ?? ext.diamond_count),
    count: Math.max(1, num(d.repeatCount) || num(d.comboCount) || 1),
    image: firstUrl(g.image) || firstUrl(g.icon) || firstUrl(details.giftImage) || '',
    streaking,
  };
}

export function like(d) {
  return {
    type: 'like',
    user: normalizeUser(d.user),
    count: num(d.count ?? d.likeCount),
    total: num(d.total ?? d.totalLikeCount),
  };
}

export function viewers(d) {
  return { type: 'viewers', count: num(d.viewerCount ?? d.total ?? d.totalUser) };
}

export function simple(type) {
  return (d) => ({ type, user: normalizeUser(d.user) });
}

export function question(d) {
  const q = d.data || d.details || d;
  return {
    type: 'question',
    user: normalizeUser(q.user || d.user),
    text: String(q.text ?? q.content ?? d.questionText ?? ''),
  };
}
