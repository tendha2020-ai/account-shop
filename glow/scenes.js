/* Glow Studio — scene data (scenes.js)
 *
 * window.GlowScenes loads glow/scenes.json, the ONLY source of the preset scene texts (there is deliberately no
 * free-text prompt anywhere). ai.js waits for it (GlowScenes.ready) before it starts. The Windows launcher reads the
 * same file to build a friend's video on the host's PC ("Share with friends"), so the prompt texts are composed here
 * by the same plain rules as in the launcher (string joins only, no trimming, no regex): DESIGN (a.3).
 *
 *   GlowScenes.ready           Promise<data>   (rejects when the file can't be loaded or is not valid)
 *   GlowScenes.data            the parsed scenes.json once loaded
 *   GlowScenes.use(data)       validate + install data synchronously (tests; returns data, throws on problems)
 *   GlowScenes.validate(data)  [problem, ...] (empty = valid)
 *   GlowScenes.sceneById(id)   a scene, or the default scene
 *   GlowScenes.shotCount(d)    1, 2 or 4 shots for 5, 10, 20 s
 *   GlowScenes.shots(sc, d)    [{ id, title, still, motion, framing, sing, lipSync }]  (the local texts of each shot)
 *   GlowScenes.variantLocal(sc, v)  the local texts of a non-story scene in one framing (variant)
 *   GlowScenes.stillText(model, text, framing)  the full photo prompt for 'qwen' or 'klein'
 *   GlowScenes.tempoFeel(bpm, energy)  'fast' | 'upbeat' | 'slow'
 *   GlowScenes.tempoHint(feel, bpm)    ' Everyone moves in time with …' ('' without a tempo)
 *   GlowScenes.guestPlan(sc, req, host) the plan a friend's job request gets on the host's PC (DESIGN a.5)
 *
 * A classic script; it also runs in node (tests) where there is no window/fetch: then only use() is used.
 */
(function (root) {
  'use strict';
  var URL_ = 'scenes.json';
  var LIP = 77 / 16, DANCE = 161 / 32;

  var G = {
    data: null, ready: null, error: null,
    use: use, validate: validate, sceneById: sceneById, shotCount: shotCount, shots: shots, variantLocal: variantLocal,
    strip: strip, stillText: stillText, tempoFeel: tempoFeel, tempoHint: tempoHint, guestPlan: guestPlan, jsRound: jsRound
  };
  function D() { if (!G.data) throw new Error('scenes.json is not loaded'); return G.data; }

  function isStr(s) { return typeof s === 'string'; }
  function nonEmpty(s) { return isStr(s) && s.length > 0; }
  function utf8Len(s) { var n = 0; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c <= 0xdbff) ? (i++, 4) : 3; } return n; }
  function count(hay, needle) { var n = 0, at = 0; for (;;) { at = hay.indexOf(needle, at); if (at < 0) return n; n++; at += needle.length; } }

  // The load-time rules of DESIGN (a.4). Returns a list of problems (empty when the data is good).
  function validate(d) {
    var p = [];
    function need(c, msg) { if (!c) p.push(msg); }
    if (!d || typeof d !== 'object') return ['not an object'];
    need(d.format === 'glow-scenes' && d.version === 1, 'format/version');
    var L = d.local || {}, C = d.cloud || {};
    need(nonEmpty(C.stillRules) && nonEmpty(C.motionRules) && nonEmpty(C.negative), 'cloud texts');
    need(L.who && nonEmpty(L.who.qwen) && nonEmpty(L.who.klein), 'local.who');
    need(nonEmpty(L.rulesBefore) && nonEmpty(L.rulesAfter) && nonEmpty(L.defaultFraming), 'local rules');
    need(nonEmpty(L.negative) && nonEmpty(L.motionEnd) && nonEmpty(L.songHint) && nonEmpty(L.songLanguage), 'local texts');
    ['fast', 'upbeat', 'slow'].forEach(function (k) { need(L.tempoHints && isStr(L.tempoHints[k]) && count(L.tempoHints[k], '{bpm}') === 1, 'tempoHints.' + k); });
    var V = Array.isArray(d.variants) ? d.variants : [];
    need(V.length >= 4 && ['main', 'closer', 'angle', 'closeup'].every(function (id, i) { return V[i] && V[i].id === id; }), 'variants main/closer/angle/closeup');
    V.forEach(function (v, i) { need(v && isStr(v.lstill) && isStr(v.lmotion) && isStr(v.title), 'variant ' + i); });
    var S = Array.isArray(d.scenes) ? d.scenes : [], ids = {};
    need(S.length > 0, 'scenes');
    S.forEach(function (sc, i) {
      var id = sc && sc.id;
      need(isStr(id) && /^[a-z0-9-]{2,32}$/.test(id), 'scene id ' + i);
      need(!ids[id], 'duplicate scene ' + id); ids[id] = true;
      need(nonEmpty(sc.name), id + ': name');
      need(sc.audio === 'optional' || sc.audio === 'recommended' || sc.audio === 'required', id + ': audio');
      if (sc.song != null) need(nonEmpty(sc.song.lyrics) && nonEmpty(sc.song.style), id + ': song');
      if (sc.story) {
        var sh = Array.isArray(sc.shots) ? sc.shots : [], sid = {};
        need(sh.length >= 1, id + ': shots');
        sh.forEach(function (s) {
          need(s && isStr(s.id) && !sid[s.id], id + ': shot id ' + (s && s.id)); if (s) sid[s.id] = true;
          var l = (s && s.local) || {};
          need(nonEmpty(l.still) && nonEmpty(l.motion) && nonEmpty(l.sing), id + '/' + (s && s.id) + ': local texts');
        });
        if (sc.pick) Object.keys(sc.pick).forEach(function (k) { (sc.pick[k] || []).forEach(function (x) { need(!!sid[x], id + ': pick ' + x); }); });
      } else {
        var lc = sc.local || {};
        need(nonEmpty(lc.still) && nonEmpty(lc.motion) && nonEmpty(lc.sing), id + ': local texts');
        need(isStr(lc.motion) && isStr(L.motionEnd) && lc.motion.slice(-L.motionEnd.length) === L.motionEnd, id + ': local.motion must end with motionEnd');
      }
    });
    need(nonEmpty(d.defaultScene) && !!ids[d.defaultScene], 'defaultScene');
    (function walk(o, path) {
      if (isStr(o)) { if (utf8Len(o) > 4096) p.push('too long: ' + path); return; }
      if (o && typeof o === 'object') Object.keys(o).forEach(function (k) { walk(o[k], path + '.' + k); });
    })(d, '');
    return p;
  }
  function use(d) {
    var p = validate(d);
    if (p.length) { var e = new Error('scenes.json is not valid: ' + p.slice(0, 5).join('; ')); e.problems = p; throw e; }
    G.data = d;
    return d;
  }

  function sceneById(id) {
    var S = D().scenes;
    for (var i = 0; i < S.length; i++) if (S[i].id === id) return S[i];
    for (var j = 0; j < S.length; j++) if (S[j].id === D().defaultScene) return S[j];
    return S[0];
  }
  function shotCount(d) { return d >= 20 ? 4 : d >= 10 ? 2 : 1; }
  // a motion line without its closing "; realistic natural motion."
  function strip(m) { var e = D().local.motionEnd; return m.length >= e.length && m.slice(m.length - e.length) === e ? m.slice(0, m.length - e.length) : m; }
  // The local texts of a non-story scene in one framing (the same scene a little closer, from another angle, …)
  function variantLocal(sc, v) {
    var L = D().local;
    return { still: sc.local.still + (v.lstill || ''), motion: strip(sc.local.motion) + (v.lmotion || '') + L.motionEnd, sing: sc.local.sing, framing: v.framing || '' };
  }
  // The shots of a video of d seconds: story scenes their own shots (sc.pick), others the scene in 1–4 framings.
  function shots(sc, d) {
    var n = shotCount(d);
    if (sc.story) {
      var ids = (sc.pick && sc.pick[String(n * 5)]) || sc.shots.slice(0, n).map(function (s) { return s.id; });
      return ids.map(function (id) {
        var s = sc.shots[0];
        for (var i = 0; i < sc.shots.length; i++) if (sc.shots[i].id === id) { s = sc.shots[i]; break; }
        return { id: s.id, title: s.title, still: s.local.still, motion: s.local.motion, framing: s.local.framing || '', sing: s.local.sing, lipSync: !!s.lipSync };
      });
    }
    return D().variants.slice(0, n).map(function (v) {
      var l = variantLocal(sc, v);
      return { id: v.id, title: v.title, still: l.still, motion: l.motion, framing: l.framing, sing: l.sing, lipSync: sc.song != null };
    });
  }
  // model: 'qwen' (Qwen-Image-Edit, "Picture 1") or 'klein' (FLUX.2 klein, "image 1")
  function stillText(model, text, framing) {
    var L = D().local;
    return L.who[model === 'klein' ? 'klein' : 'qwen'] + text + '.' + L.rulesBefore + (framing ? framing : L.defaultFraming) + L.rulesAfter;
  }
  // "Dance to the beat": the feel of a tempo, from the unrounded bpm/energy of the part that plays
  function tempoFeel(bpm, energy) {
    return (bpm >= 118 || (energy || 0) > 0.85) ? 'fast' : (bpm < 96 || (energy || 1) < 0.45) ? 'slow' : 'upbeat';
  }
  function tempoHint(feel, bpm) {
    var h = D().local.tempoHints;
    // (the caller checks that there is a tempo at all: a bpm > 0 before rounding)
    if (!h[feel] || typeof bpm !== 'number' || !isFinite(bpm)) return '';
    return h[feel].replace('{bpm}', String(bpm));
  }
  // ECMAScript Math.round for x >= 0, written out as the launcher does it
  function jsRound(x) { var r = Math.floor(x); return x - r >= 0.5 ? r + 1 : r; }

  /* The plan of a friend's job request on the host's PC (DESIGN a.5): always the story path, 1, 2 or 4 shots.
   * req = { sceneId, duration, sound, sync, quality, tempo: {bpm, feel}|null, audio: bool, lipStarts?: [] }
   * host = { singing, fast }. Returns { error } or the plan with the composed prompt texts. */
  function guestPlan(sc, req, host) {
    var L = D().local;
    host = host || {};
    var sound = req.sound === 'own' ? 'own' : sc.audio === 'required' ? 'ai' : (req.sound === 'ai' && sc.song == null) ? 'music' : req.sound;
    if (sound === 'ai' && !host.singing) return { error: 'missing-pack' };
    var list = shots(sc, req.duration);
    var lipsAvail = !!host.singing && ((sound === 'own' && !!req.audio) || (sound === 'ai' && sc.song != null));
    var sync = req.sync === 'lips' && lipsAvail ? 'lips' : 'beat';
    var lipsN = 0;
    var out = list.map(function (s) {
      var lip = lipsAvail && (sync === 'lips' || (s.lipSync && (!!sc.story || sound === 'ai')));
      if (lip) lipsN++;
      return { shot: s, lip: lip };
    });
    if (sound === 'own' && req.audio && lipsN === 0) return { error: 'unexpected-audio' };
    if (sound !== 'own' && req.audio) return { error: 'unexpected-audio' };
    var quality = (sound === 'ai' || lipsN > 0) ? 'best' : (req.quality === 'fast' ? 'fast' : 'best');
    var stillModel = quality === 'fast' && host.fast ? 'klein' : 'qwen';
    var hint = sound === 'ai' ? (sc.story ? L.songHint : '') : (req.tempo ? tempoHint(req.tempo.feel, req.tempo.bpm) : '');
    var offsets = out.map(function () { return null; }), song = null;
    if (sound === 'ai') {
      var B = [0];
      out.forEach(function (x, k) { B[k + 1] = B[k] + (x.lip ? LIP : 5.03); });
      var asked = Math.max(10, Math.min(60, Math.ceil(B[out.length] + 2)));
      var cur = 0, need = 0;
      out.forEach(function (x, k) {
        var at = x.lip ? jsRound(B[k] * 1000) / 1000 : cur;
        offsets[k] = jsRound(at * 1e6) / 1e6;
        cur = at + (x.lip ? LIP : DANCE);
        need = Math.max(need, offsets[k] + (x.lip ? 5 : DANCE));
      });
      var secs = jsRound(Math.min(120, Math.max(5, Math.max(asked, Math.ceil(need * 10) / 10))) * 10) / 10;
      song = { seconds: secs, style: sc.song.style, lyrics: sc.song.lyrics, language: L.songLanguage };
    } else if (sound === 'own' && Array.isArray(req.lipStarts)) {
      out.forEach(function (x, k) { offsets[k] = x.lip && typeof req.lipStarts[k] === 'number' ? jsRound(req.lipStarts[k] * 1000) / 1000 : null; });
    }
    return {
      sceneId: sc.id, sound: sound, sync: sync, quality: quality, stillModel: stillModel, hint: hint,
      video: quality === 'fast' ? { width: 384, height: 672 } : { width: 480, height: 832 },
      needsAudio: sound === 'own' && lipsN > 0, lips: lipsN,
      shots: out.map(function (x, k) {
        return { id: x.shot.id, title: x.shot.title, lip: x.lip, seconds: x.lip ? LIP : DANCE, offset: offsets[k],
          stillPrompt: stillText(stillModel, x.shot.still, x.shot.framing), motionPrompt: x.lip ? x.shot.sing : x.shot.motion + hint, negativePrompt: L.negative };
      }),
      song: song
    };
  }

  // The browser: fetch scenes.json now (index.html preloads it), with a couple of retries for a flaky connection.
  if (root && typeof root.fetch === 'function') {
    G.ready = new Promise(function (resolve, reject) {
      var tries = 0;
      (function go() {
        tries++;
        root.fetch(URL_, { cache: 'no-cache', credentials: 'same-origin' }).then(function (r) {
          if (!r.ok) { var e = new Error('scenes.json: HTTP ' + r.status); e.status = r.status; throw e; }
          return r.json();
        }).then(function (d) { resolve(use(d)); }, function (e) {
          if (e && e.problems) { G.error = e; reject(e); return; } // a bad file does not get better by asking again
          if (tries < 3) { setTimeout(go, tries * 700); return; }
          G.error = e; reject(e);
        });
      })();
    });
    G.ready.catch(function (e) { if (root.console) root.console.warn('[glow] scenes.json', e); });
  } else {
    G.ready = Promise.reject(new Error('no fetch'));
    G.ready.catch(function () { /* node: tests call use() */ });
  }
  root.GlowScenes = G;
})(typeof window !== 'undefined' ? window : this);
