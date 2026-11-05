// Host page: runs the quiz on the projector.
// Phone mode: the database is the source of truth and every action is a host_* function.
// Card mode: this page runs the flow from its cached questions and pushes its
// position to the database whenever the internet is up, so it works offline.
(function () {
  var Q = window.Quiz;
  var CODE = Q.cfg.GAME_CODE || 'TNB';
  var PLAYER_URL = Q.cfg.PLAYER_URL || location.href.replace(/host\.html.*$/, '');
  var K = {
    pin: 'tnbq_pin', pinHash: 'tnbq_pin_hash_' + CODE, view: 'tnbq_host_view_' + CODE,
    qs: 'tnbq_host_questions_' + CODE, card: 'tnbq_host_card_' + CODE
  };

  var H = {
    pin: Q.session.get(K.pin),
    view: Q.local.getJSON(K.view),
    questions: Q.local.getJSON(K.qs),
    card: Q.local.getJSON(K.card), // { on, status, index, started_at, paused_at, awards, dirty, posDirty }
    online: false,
    unlocked: false,
    busy: false,
    finalStep: 0,
    manage: false,
    armed: {},
    autoRevealed: {},
    lastHtml: '',
    podiumShown: false,
    hideScores: Q.local.get('tnbq_hide_scores') === 'on',
    qr: null
  };

  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage');

  // ---------------------------------------------------------------- state
  function cardOn() { return !!(H.card && H.card.on); }
  function saveCard() { Q.local.setJSON(K.card, H.card); }
  function opts(g) {
    var o = g && g.options;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { o = null; } }
    return Array.isArray(o) ? o : [];
  }

  // The game as shown: the server row, or the local card mode state.
  function game() {
    if (cardOn()) {
      var c = H.card, q = H.questions && H.questions[c.index];
      var shown = c.status === 'reveal' || c.status === 'leaderboard' || c.status === 'final';
      return {
        status: c.status, current_index: c.index, total_questions: H.questions ? H.questions.length : 15,
        duration_s: 20, category: q ? q.category : null, question_text: q ? q.text : null,
        options: q ? q.options : null, started_at: c.started_at, paused_at: c.paused_at,
        revealed_index: shown && q ? q.correct_index : null, explanation: shown && q ? q.explanation : null,
        card_mode: true
      };
    }
    return H.view ? H.view.game : null;
  }
  function players() { return (H.view && H.view.players) || []; }

  // Group score = average member total + 100 per card award. Tie-break: correct answers.
  function standings() {
    var base = {};
    ((H.view && H.view.groups) || []).forEach(function (g) { base[g.name] = g; });
    var awards = H.card ? (H.card.awards || {}) : ((H.view && H.view.card_awards) || {});
    var cards = {};
    Q.GROUPS.forEach(function (g) { cards[g] = 0; });
    Object.keys(awards).forEach(function (k) {
      (awards[k] || []).forEach(function (g) { if (g in cards) cards[g]++; });
    });
    var rows = Q.GROUPS.map(function (name, i) {
      var b = base[name] || {};
      var avg = Number(b.avg) || 0;
      var phoneCorrect = (b.correct || 0) - Math.round((b.card_points || 0) / 100);
      return {
        name: name, order: i, members: b.members || 0, avg: avg, cards: cards[name],
        score: avg + cards[name] * 100, correct: phoneCorrect + cards[name]
      };
    });
    var ranked = rows.slice().sort(function (a, b) {
      return b.score - a.score || b.correct - a.correct || a.order - b.order;
    });
    ranked.forEach(function (r, i) {
      var p = ranked[i - 1];
      r.rank = p && Math.abs(p.score - r.score) < 0.005 && p.correct === r.correct ? p.rank : i + 1;
    });
    return { rows: rows, ranked: ranked };
  }

  // ---------------------------------------------------------------- server calls
  function setOnline(on) {
    if (H.online === on) return;
    H.online = on;
    renderChips();
  }

  function applyView(v) {
    if (!v || !v.game) return;
    var cur = H.view && H.view.game;
    if (cur && cur.id === v.game.id && Q.ts(v.game.updated_at) < Q.ts(cur.updated_at)) return; // older poll
    H.view = v;
    if (v.game.status !== 'final') H.finalStep = 0;
    Q.local.setJSON(K.view, v);
  }

  function call(fn, args) {
    var sent = Date.now();
    var a = { p_code: CODE, p_pin: H.pin };
    for (var k in args || {}) a[k] = args[k];
    return Q.rpc(fn, a, 10000).then(function (r) {
      if (r.network) { setOnline(false); return r; }
      setOnline(true);
      if (r.error === 'bad_pin' || r.error === 'pin_not_set') { relock(r.error); return r; }
      if (r.error === 'locked') { toast('Too many wrong PINs. Host actions are locked for a minute.'); return r; }
      if (r.data && r.data.server_now) Q.syncClock(r.data.server_now, sent, Date.now());
      if (r.data && r.data.game) applyView(r.data);
      var note = r.data && r.data.note;
      if (note === 'stale') toast('The screen was behind. It is up to date now.');
      if (note === 'cannot_unreveal') toast('The answer is already out. Use Next.');
      if (note === 'no_such_question') toast('No questions loaded. Run questions.local.sql in Supabase.');
      return r;
    });
  }

  function act(fn, args) {
    if (H.busy) return Promise.resolve();
    H.busy = true;
    renderControls();
    return call(fn, args).then(function (r) {
      H.busy = false;
      if (r.network) toast('No connection. Try again, or turn on card mode.');
      render();
      return r;
    });
  }

  function poll() {
    var g = game();
    var delay = g && g.status === 'question' ? 1000 : 2000;
    if (!H.unlocked || !Q.configured) return setTimeout(poll, delay);
    call('host_state').then(function (r) {
      if (!r.network && cardOn() && needsPush()) push();
      render();
      setTimeout(poll, delay);
    });
  }

  function loadQuestions() {
    return call('host_questions').then(function (r) {
      if (r.data && r.data.questions) {
        H.questions = r.data.questions;
        Q.local.setJSON(K.qs, H.questions);
      }
    });
  }

  // ---------------------------------------------------------------- actions
  function armed(name, msg) {
    if (H.armed[name] && H.armed[name] > Date.now()) { delete H.armed[name]; renderControls(); return true; }
    H.armed = {};
    H.armed[name] = Date.now() + 4000;
    if (msg) toast(msg);
    renderControls();
    render();
    setTimeout(function () { renderControls(); render(); }, 4100);
    return false;
  }

  function next() {
    var g = game();
    if (!g || H.busy) return;
    if (g.status === 'final') { if (H.finalStep === 0) { H.finalStep = 1; render(); } return; }
    if (cardOn()) return cardNext();
    if (g.status === 'lobby') return act('host_start');
    if (g.status === 'question') return act('host_reveal', { p_index: g.current_index });
    return act('host_next', { p_from_status: g.status, p_from_index: g.current_index });
  }

  function back() {
    var g = game();
    if (!g || H.busy || g.status === 'lobby') return;
    if (g.status === 'final' && H.finalStep === 1) { H.finalStep = 0; render(); return; }
    if (g.status === 'reveal') { toast('The answer is already out. Use Next.'); return; }
    if (g.status === 'question' && !cardOn() && H.view && H.view.answers_in > 0 &&
        !armed('back', 'Press Back again to cancel this question. Its answers will be deleted.')) return;
    if (cardOn()) return cardBack();
    act('host_back', { p_from_status: g.status, p_from_index: g.current_index });
  }

  function pause() {
    var g = game();
    if (!g || g.status !== 'question') return;
    if (cardOn()) {
      var c = H.card;
      if (c.paused_at) { c.started_at += Q.now() - c.paused_at; c.paused_at = null; }
      else c.paused_at = Q.now();
      saveCard(); render();
      return;
    }
    act('host_pause', { p_index: g.current_index, p_paused: !g.paused_at });
  }

  function end() {
    var g = game();
    if (!g || g.status === 'final') return;
    if (!armed('end', 'Click End quiz again to finish now.')) return;
    if (cardOn()) return cardSet('final', g.current_index);
    act('host_end');
  }

  function reset() {
    if (!armed('reset', 'Click Reset game again. This deletes all players and scores.')) return;
    act('host_reset').then(function (r) {
      if (!r || r.error) { if (r && r.network) toast('Reset needs the internet.'); return; }
      H.card = null; Q.local.del(K.card);
      H.finalStep = 0; H.autoRevealed = {}; H.manage = false;
      toast('Game reset. Back to the lobby.');
      render();
    });
  }

  function removePlayer(id, name) {
    if (!armed('rm:' + id)) return;
    act('host_remove_player', { p_player: id }).then(function (r) {
      if (r && !r.error) toast(name + ' was removed.');
    });
  }

  // ---------------------------------------------------------------- card mode
  function cardSet(status, index) {
    var c = H.card;
    var changed = c.status !== status || c.index !== index;
    if (status === 'question' && changed) { c.started_at = Q.now(); c.paused_at = null; }
    c.status = status; c.index = status === 'lobby' ? -1 : index;
    if (status !== 'final') H.finalStep = 0;
    c.posDirty = true;
    saveCard(); render(); push();
  }
  function cardNext() {
    var c = H.card, total = H.questions.length;
    if (c.status === 'lobby') cardSet('question', 0);
    else if (c.status === 'question') cardSet('reveal', c.index);
    else if (c.status === 'reveal') cardSet('leaderboard', c.index);
    else if (c.status === 'leaderboard') {
      if (c.index + 1 < total) cardSet('question', c.index + 1); else cardSet('final', c.index);
    }
  }
  function cardBack() {
    var c = H.card;
    if (c.status === 'leaderboard') cardSet('reveal', c.index);
    else if (c.status === 'final') cardSet('leaderboard', Math.max(c.index, 0));
    else if (c.status === 'question') {
      if (c.awards[c.index]) { delete c.awards[c.index]; c.dirty[c.index] = true; }
      if (c.index === 0) cardSet('lobby', -1); else cardSet('leaderboard', c.index - 1);
    }
  }
  function toggleAward(group) {
    var c = H.card;
    if (!cardOn() || (c.status !== 'reveal' && c.status !== 'leaderboard')) return;
    var list = (c.awards[c.index] || []).slice();
    var i = list.indexOf(group);
    if (i >= 0) list.splice(i, 1); else list.push(group);
    c.awards[c.index] = list;
    c.dirty[c.index] = true;
    saveCard(); render(); push();
  }

  function needsPush() {
    return !!(H.card && (H.card.posDirty || Object.keys(H.card.dirty || {}).length));
  }
  var pushing = false;
  function push() {
    if (pushing || !H.card || !needsPush() || !Q.configured) return Promise.resolve(true);
    pushing = true;
    var c = H.card;
    var chain = Promise.resolve(true);
    Object.keys(c.dirty).forEach(function (k) {
      chain = chain.then(function (ok) {
        if (!ok) return false;
        var list = (c.awards[k] || []).slice();
        return call('host_card_set', { p_index: Number(k), p_groups: list }).then(function (r) {
          if (r.network || r.error) return false;
          if (JSON.stringify(c.awards[k] || []) === JSON.stringify(list)) delete c.dirty[k];
          return true;
        });
      });
    });
    chain = chain.then(function (ok) {
      if (!ok || !c.posDirty) return ok;
      var s = c.status, i = c.index;
      return call('host_goto', { p_status: s, p_index: s === 'lobby' ? -1 : i }).then(function (r) {
        if (r.network || r.error) return false;
        if (c.status === s && c.index === i) c.posDirty = false;
        return true;
      });
    });
    return chain.then(function (ok) { pushing = false; saveCard(); return ok; });
  }

  function setCardMode(on) {
    var toggle = $('cardToggle');
    if (on) {
      if (!H.questions) {
        toggle.checked = false;
        toast('Card mode needs the questions. Unlock once while online to load them.');
        return;
      }
      var g = H.view && H.view.game;
      var keep = H.card && H.card.awards ? H.card.awards : null;
      H.card = {
        on: true,
        status: g ? g.status : 'lobby',
        index: g ? g.current_index : -1,
        started_at: g && g.started_at ? Q.ts(g.started_at) : Q.now(),
        paused_at: g && g.paused_at ? Q.ts(g.paused_at) : null,
        awards: JSON.parse(JSON.stringify(keep || (H.view && H.view.card_awards) || {})),
        dirty: {}, posDirty: false
      };
      saveCard();
      if (Q.configured) call('host_set_card_mode', { p_on: true });
      toast('Card mode on. Phone answers are off. Teams hold up A, B, C or D.');
      render();
      return;
    }
    if (!H.online) {
      toggle.checked = true;
      toast('Card mode stays on until the internet is back.');
      return;
    }
    push().then(function (ok) {
      if (!ok) return { network: true };
      return call('host_set_card_mode', { p_on: false });
    }).then(function (r) {
      if (r.network || r.error) { toggle.checked = true; toast('Could not reach the server. Card mode is still on.'); return; }
      H.card.on = false; saveCard();
      toast('Card mode off. Phones can answer again.');
      render();
    });
  }

  // ---------------------------------------------------------------- voice
  // A game-show narrator, like quiz.com's Voice mode: it welcomes players as they join,
  // opens the quiz, reads each question out as it appears, calls the right answer on the
  // reveal and announces the champions. quiz.com uses its own paid voice service; this uses
  // the laptop's built-in voices (free, works offline) and picks the most natural English one.
  // Browsers only allow speech after a click, which the PIN unlock provides.
  // The Voice button mutes it.
  var voice = (function () {
    var ok = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
    var on = Q.local.get('tnbq_voice') !== 'off';
    var seen = null, best = null;
    function pick() {
      if (!ok) return;
      var list = window.speechSynthesis.getVoices() || [];
      var score = function (v) {
        if (!/^en/i.test(v.lang)) return -1;
        return (/natural/i.test(v.name) ? 8 : 0) + (/online|neural/i.test(v.name) ? 4 : 0) +
          (/google/i.test(v.name) ? 3 : 0) + (/en[-_](gb|ng)/i.test(v.lang) ? 2 : 0) + (v.localService ? 0 : 1);
      };
      best = list.filter(function (v) { return score(v) >= 0; })
        .sort(function (a, b) { return score(b) - score(a); })[0] || null;
    }
    if (ok) {
      pick();
      try { window.speechSynthesis.addEventListener('voiceschanged', pick); } catch (e) {}
    }
    // interrupt: stop whatever is being said first (a new question beats an old welcome).
    function say(text, interrupt) {
      if (!on || !ok || !text) return;
      try {
        var sp = window.speechSynthesis;
        if (interrupt) sp.cancel();
        else if (sp.pending) return; // no long queue when many join at once
        var make = function (v) {
          var u = new SpeechSynthesisUtterance(text);
          if (v) { u.voice = v; u.lang = v.lang; }
          u.rate = 1; u.pitch = 1.05;
          return u;
        };
        var u = make(best);
        // Online voices (Google, Microsoft Natural) fail without internet: retry with a built-in one.
        u.onerror = function (e) {
          if (!best || best.localService || e.error === 'interrupted' || e.error === 'canceled') return;
          var local = (sp.getVoices() || []).filter(function (v) { return v.localService && /^en/i.test(v.lang); })[0];
          sp.speak(make(local || null));
        };
        sp.speak(u);
      } catch (e) {}
    }
    return {
      on: function () { return on && ok; },
      name: function () { return best ? best.name : ''; },
      toggle: function () {
        on = !on; Q.local.set('tnbq_voice', on ? 'on' : 'off');
        if (!on && ok) { try { window.speechSynthesis.cancel(); } catch (e) {} }
      },
      players: function (list, inLobby) {
        var ids = {};
        list.forEach(function (p) { ids[p.id] = true; });
        var fresh = seen ? list.filter(function (p) { return !seen[p.id]; }) : [];
        var first = seen === null;
        seen = ids;
        if (first || !inLobby || !H.unlocked || !fresh.length) return;
        if (fresh.length > 3) {
          say('Welcome ' + fresh[0].name + ', ' + fresh[1].name + ' and ' + (fresh.length - 2) + ' others!');
        } else {
          say(fresh.map(function (p) { return 'Welcome ' + p.name + ', ' + p.group + '!'; }).join(' '));
        }
      },
      // Called once per change of screen (status or question).
      step: function (g) {
        if (!g) return;
        var o = opts(g);
        if (g.status === 'question') {
          var intro = g.current_index === 0 ? 'Teams and Banter. Let\'s go! ' : '';
          var last = g.current_index + 1 === g.total_questions ? 'Last question! ' : '';
          say(intro + last + (g.question_text || ''), true);
        } else if (g.status === 'reveal' && g.revealed_index != null && o[g.revealed_index] != null) {
          say(String(o[g.revealed_index]) + '.', true);
        } else if (g.status === 'final' && H.finalStep === 0) {
          var w = standings().ranked.filter(function (r) { return r.rank === 1; }).map(function (r) { return r.name; });
          if (w.length) say((w.length > 1 ? 'It\'s a tie! Your champions are ' : 'And your champions are... ') + w.join(' and ') + '!', true);
        } else if (g.status === 'lobby' || g.status === 'leaderboard') {
          try { window.speechSynthesis.cancel(); } catch (e) {}
        }
      }
    };
  })();

  // ---------------------------------------------------------------- typewriter
  // Idea 4: a new question types itself out on the projector (about 35 letters a second).
  // Picks up where it should be after a redraw, and shows the whole text straight away
  // if the page is opened more than 3 seconds into a question.
  var tw = { key: '', start: 0, raf: 0 };
  function typewriter(g) {
    cancelAnimationFrame(tw.raf);
    if (!g || g.status !== 'question') { tw.key = ''; return; }
    var key = g.current_index + ':' + (g.started_at || '');
    if (tw.key !== key) {
      tw.key = key;
      var into = (g.duration_s || 20) - Q.remaining(g);
      tw.start = into > 3 ? 0 : Date.now();
    }
    var full = g.question_text || '';
    (function step() {
      var el = stage.querySelector('.q-text');
      if (!el) return;
      var n = Math.min(full.length, Math.floor((Date.now() - tw.start) / 28));
      var html = esc(full.slice(0, n)) + (n < full.length ? '<span class="tw-rest">' + esc(full.slice(n)) + '</span>' : '');
      if (el.innerHTML !== html) el.innerHTML = html;
      if (n < full.length) tw.raf = requestAnimationFrame(step);
    })();
  }

  // ---------------------------------------------------------------- views
  function esc(s) { return Q.esc(s); }

  function qrSvg() {
    if (H.qr) return H.qr;
    if (!window.qrcode) return '<p class="qr-url">QR code needs the internet.</p>';
    var qr = window.qrcode(0, 'M');
    qr.addData(PLAYER_URL);
    qr.make();
    var n = qr.getModuleCount(), m = 2, d = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += 'M' + (c + m) + ' ' + (r + m) + 'h1v1h-1z';
    }
    var size = n + m * 2;
    H.qr = '<svg viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="QR code for the quiz" shape-rendering="crispEdges">' +
      '<rect width="' + size + '" height="' + size + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
    return H.qr;
  }

  function viewLobby() {
    var counts = {};
    Q.GROUPS.forEach(function (g) { counts[g] = 0; });
    var ps = players();
    ps.forEach(function (p) { counts[p.group] = (counts[p.group] || 0) + 1; });
    var groups = Q.GROUPS.map(function (g) {
      return '<div class="lg"><div class="n">' + counts[g] + '</div><div class="g">' + g + '</div></div>';
    }).join('');
    var names;
    if (H.manage) {
      names = '<div class="names manage">' + (ps.length ? ps.map(function (p) {
        var arm = H.armed['rm:' + p.id] > Date.now();
        return '<button type="button" class="' + (arm ? 'arm' : '') + '" data-remove="' + p.id + '" data-name="' + esc(p.label) + '">' +
          (arm ? 'Remove ' + esc(p.label) + '?' : esc(p.label) + ' · ' + esc(p.group)) + '</button>';
      }).join('') : '<span>No players yet.</span>') + '</div>' +
        '<p class="kicker">Click a name twice to remove that player.</p>';
    } else {
      names = '<div class="names">' + ps.slice(-24).reverse().map(function (p) {
        return '<span>' + esc(p.label) + '</span>';
      }).join('') + '</div>';
    }
    var shortUrl = PLAYER_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return '<section class="lobby">' +
      '<div class="qr-card">' + qrSvg() + '<div class="qr-url">' + esc(shortUrl) + '</div></div>' +
      '<div class="lobby-side">' +
      '  <p class="kicker">Live trivia · ' + (H.questions ? H.questions.length : 15) + ' questions · 20 seconds each</p>' +
      '  <h1 class="h-big">Scan to <span class="grad-text">join</span></h1>' +
      '  <p class="lobby-total">Type your name and tap your team. <b>' + ps.length + '</b> ' + (ps.length === 1 ? 'player' : 'players') + ' in.</p>' +
      '  <div class="lobby-groups">' + groups + '</div>' + names +
      '</div></section>';
  }

  function ring() {
    return '<div class="ring"><svg viewBox="0 0 100 100" aria-hidden="true">' +
      '<defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F2B43A"/><stop offset="1" stop-color="#FFF0A8"/></linearGradient></defs>' +
      '<circle class="track" cx="50" cy="50" r="44" fill="none" stroke-width="8"/>' +
      '<circle class="prog" id="ringProg" cx="50" cy="50" r="44" fill="none" stroke-width="8" stroke-dasharray="276.46" stroke-dashoffset="0"/>' +
      '</svg><div class="t" id="ringT"></div></div>';
  }

  function groupStrip(lead) {
    var s = standings();
    var top = s.ranked[0];
    return '<div class="gstrip">' + s.rows.map(function (r) {
      var isLead = lead && top && r.rank === 1 && r.score > 0;
      return '<div class="gs' + (isLead ? ' lead' : '') + '"><div class="g">' + r.name + '</div><div class="s">' + Q.num(r.score) + '</div></div>';
    }).join('') + '</div>';
  }

  // Live answer counters per team while a question is open: "Agip 3/5".
  // Only teams with players show. A team lights up once everyone in it has answered.
  function teamCounters() {
    var by = (H.view && H.view.team_answers) || {};
    var size = {};
    players().forEach(function (p) { size[p.group] = (size[p.group] || 0) + 1; });
    var chips = Q.GROUPS.filter(function (name) { return size[name]; }).map(function (name) {
      var n = Math.min(by[name] || 0, size[name]);
      var cls = 'tc' + (n >= size[name] ? ' all' : n > 0 ? ' some' : '');
      return '<div class="' + cls + '"><span class="g">' + name + '</span><b>' + n + '/' + size[name] + '</b></div>';
    }).join('');
    return chips ? '<div class="tcounts">' + chips + '</div>' : '';
  }

  function cardButtons(g) {
    var picked = (H.card.awards[g.current_index] || []);
    return '<p class="card-hint">Click each team that held up <b>' + Q.LETTERS[g.revealed_index] + '</b>. 100 points each.</p>' +
      '<div class="gstrip">' + Q.GROUPS.map(function (name) {
        var on = picked.indexOf(name) >= 0;
        return '<button type="button" class="gs" data-award="' + name + '" aria-pressed="' + on + '">' +
          '<div class="g">' + name + '</div><div class="s">' + (on ? '+100' : '0') + '</div></button>';
      }).join('') + '</div>';
  }

  function viewQuestion(g) {
    var o = opts(g);
    var revealed = g.status !== 'question';
    var dist = !revealed || g.card_mode ? null : (H.view && H.view.distribution);
    var totalVotes = dist ? dist.reduce(function (a, b) { return a + b; }, 0) : 0;
    var tiles = o.map(function (t, i) {
      var cls = 'htile tile t' + i + (revealed ? (i === g.revealed_index ? ' right' : ' dim') : '');
      var bar = '';
      if (dist) {
        var pct = totalVotes ? Math.round(dist[i] / totalVotes * 100) : 0;
        bar = '<div class="dist"><span class="track"><span class="fill" style="width:' + pct + '%"></span></span><b>' + dist[i] + '</b></div>';
      }
      return '<div class="' + cls + '"><div class="row"><span class="badge">' + Q.LETTERS[i] + '</span>' +
        '<span class="txt">' + esc(t) + '</span></div>' + bar + '</div>';
    }).join('');

    var foot;
    if (!revealed) {
      var left = g.card_mode
        ? '<span>Card round. Teams, get your A, B, C, D cards ready.</span>'
        : '<span>Answers in: <b>' + ((H.view && H.view.answers_in) || 0) + ' / ' + players().length + '</b></span>';
      foot = (g.card_mode ? '' : teamCounters()) +
        '<div class="q-foot">' + left + '<span class="muted" id="qStatus"></span></div>';
    } else {
      foot = (g.explanation ? '<p class="explain-big">' + esc(g.explanation) + '</p>' : '') +
        (g.card_mode && g.status === 'reveal' ? cardButtons(g) : (H.hideScores ? '' : groupStrip(true)));
    }

    return '<section' + (revealed ? ' class="revealed"' : '') + '>' +
      '<div class="q-top"><div>' +
      '  <div class="q-meta"><span class="num">Question ' + (g.current_index + 1) + ' of ' + g.total_questions + '</span>' +
      (g.category ? '<span class="cat">' + esc(g.category) + '</span>' : '') +
      (dist && totalVotes && g.revealed_index != null
        ? '<span class="got"><b>' + Math.round((dist[g.revealed_index] || 0) / totalVotes * 100) + '%</b> got it right</span>' : '') +
      '</div>' +
      '  <h1 class="q-text">' + esc(g.question_text) + '</h1>' +
      '</div>' + (revealed ? '' : ring()) + '</div>' +
      '<div class="tiles">' + tiles + '</div>' + foot +
      '</section>';
  }

  // Score cell. With a gain (leaderboard after a question) it shows "+842" and the total
  // counts up from the old score to the new one (see countUp).
  function scoreCell(total, gain, key) {
    if (!gain || gain <= 0) return '<span class="sc">' + Q.num(total) + '</span>';
    var from = Math.max(0, total - gain);
    var shown = H.countedKey === key ? total : from;
    return '<span class="sc"><span class="gain">+' + Q.num(gain) + '</span>' +
      '<span class="cnt" data-from="' + from + '" data-to="' + total + '">' + Q.num(shown) + '</span></span>';
  }

  function playerRows(list, compact, key) {
    if (!list.length) return '<p class="kicker">No phone scores yet.</p>';
    return '<div class="list' + (compact ? ' compact' : '') + '">' + list.map(function (p, i) {
      var gain = key ? (p.gained || 0) : 0;
      return '<div class="lrow' + (i === 0 ? ' first' : '') + (gain > 0 ? ' up' : '') + '"><span class="r">' + p.rank + '</span>' +
        '<span class="nm">' + esc(p.label) + '<small>' + esc(p.group) + '</small></span>' +
        scoreCell(p.total, gain, key) + '</div>';
    }).join('') + '</div>';
  }

  // gains: team name -> points the team score went up by on this question.
  function groupRows(ranked, compact, gains, key) {
    return '<div class="list' + (compact ? ' compact' : '') + '">' + ranked.map(function (r, i) {
      var gain = gains ? (gains[r.name] || 0) : 0;
      return '<div class="lrow' + (i === 0 ? ' first' : '') + (gain > 0 ? ' up' : '') + '"><span class="r">' + r.rank + '</span>' +
        '<span class="nm">' + r.name + '<small>' + r.members + (r.members === 1 ? ' player' : ' players') + '</small></span>' +
        scoreCell(r.score, gain, key) + '</div>';
    }).join('') + '</div>';
  }

  // What each team's score went up by on question idx: the average of its members'
  // points on that question (team score is an average) plus 100 for a card award.
  function teamGains(idx, ranked) {
    var sum = {};
    players().forEach(function (p) { sum[p.group] = (sum[p.group] || 0) + (p.gained || 0); });
    var awards = (H.card ? H.card.awards : H.view && H.view.card_awards) || {};
    var carded = awards[idx] || [];
    var out = {};
    ranked.forEach(function (r) {
      out[r.name] = (r.members ? (sum[r.name] || 0) / r.members : 0) + (carded.indexOf(r.name) >= 0 ? 100 : 0);
    });
    return out;
  }

  // Count-up: once per leaderboard, totals run from the old score to the new one.
  // Survives redraws (polls) by working from the start time, not the DOM.
  var cu = { key: '', start: 0, raf: 0 };
  function countUp(g) {
    cancelAnimationFrame(cu.raf);
    if (!g || g.status !== 'leaderboard' || H.hideScores) { cu.key = ''; return; }
    var key = 'lb:' + g.current_index;
    if (H.countedKey === key) return;
    if (cu.key !== key) { cu.key = key; cu.start = Date.now() + 700; } // after the rows slide in
    (function step() {
      var t = Math.max(0, Math.min(1, (Date.now() - cu.start) / 1600));
      var e = 1 - Math.pow(1 - t, 3);
      Array.prototype.forEach.call(stage.querySelectorAll('.cnt'), function (el) {
        var a = Number(el.getAttribute('data-from')), b = Number(el.getAttribute('data-to'));
        el.textContent = Q.num(a + (b - a) * e);
      });
      if (t < 1) cu.raf = requestAnimationFrame(step);
      else H.countedKey = key;
    })();
  }

  function viewLeaderboard(g) {
    if (H.hideScores) {
      return '<section class="hidden-scores">' +
        '<p class="kicker">After question ' + (g.current_index + 1) + ' of ' + g.total_questions + '</p>' +
        '<h1 class="h-big">Scores are <span class="grad-text">top secret</span></h1>' +
        '<p class="lobby-total">The leaderboard comes out at the end. Keep the banter going.</p>' +
        '</section>';
    }
    var s = standings();
    var key = 'lb:' + g.current_index;
    // Teams with nobody in them stay off the leaderboard (they come back once someone joins).
    var teams = s.ranked.filter(function (r) { return r.members > 0 || r.cards > 0; });
    if (!teams.length) teams = s.ranked;
    return '<section>' +
      '<p class="kicker">After question ' + (g.current_index + 1) + ' of ' + g.total_questions + '</p>' +
      '<h1 class="h-mid">Leaderboard</h1>' +
      '<div class="boards">' +
      '  <div><p class="kicker" style="margin-bottom:1.4vh">Top players</p>' + playerRows(players().slice(0, 5), false, key) + '</div>' +
      '  <div><p class="kicker" style="margin-bottom:1.4vh">Teams</p>' + groupRows(teams, teams.length > 6, teamGains(g.current_index, teams), key) + '</div>' +
      '</div></section>';
  }

  function viewFinal() {
    var s = standings();
    if (H.finalStep === 1) {
      return '<section><p class="kicker">Final results</p><h1 class="h-big">Top <span class="grad-text">players</span></h1>' +
        playerRows(players().slice(0, 5), false) + '</section>';
    }
    var r = s.ranked;
    function pod(row, place) {
      if (!row) return '<div></div>';
      return '<div class="pod p' + place + '"><div class="nm">' + row.name + '</div>' +
        '<div class="sc">' + Q.num(row.score) + ' points</div><div class="block">' + row.rank + '</div></div>';
    }
    var winners = r.filter(function (x) { return x.rank === 1; }).map(function (x) { return x.name; });
    return '<section><p class="kicker">Final results</p>' +
      '<h1 class="h-big">' + (winners.length > 1 ? 'Joint winners: ' : 'Champions: ') +
      '<span class="grad-text">' + winners.join(' and ') + '</span></h1>' +
      '<div class="podium">' + pod(r[1], 2) + pod(r[0], 1) + pod(r[2], 3) + '</div>' +
      '<div class="rest list compact">' + r.slice(3).map(function (x) {
        return '<div class="lrow"><span class="r">' + x.rank + '</span><span class="nm">' + x.name + '</span><span class="sc">' + Q.num(x.score) + '</span></div>';
      }).join('') + '</div></section>';
  }

  // ---------------------------------------------------------------- sound
  // Game-show sounds made with Web Audio (no files, works offline). The host
  // laptop plays them through the room speakers. The Sound button mutes them.
  var sfx = (function () {
    var ctx = null, on = Q.local.get('tnbq_sound') !== 'off';
    function ac() {
      if (!on) return null;
      try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone(freq, start, dur, type, vol) {
      var c = ac(); if (!c) return;
      var t = c.currentTime + start, o = c.createOscillator(), g = c.createGain();
      o.type = type || 'square'; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.18, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
    }
    function sweep(f1, f2, dur, vol) {
      var c = ac(); if (!c) return;
      var t = c.currentTime, o = c.createOscillator(), g = c.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(f1, t); o.frequency.exponentialRampToValueAtTime(f2, t + dur);
      g.gain.setValueAtTime(vol || 0.15, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
    }
    return {
      on: function () { return on; },
      toggle: function () { on = !on; Q.local.set('tnbq_sound', on ? 'on' : 'off'); },
      unlock: function () { ac(); },
      tick: function (n) { tone(n <= 3 ? 880 : 660, 0, 0.09, 'square', 0.12); },
      buzz: function () { tone(140, 0, 0.5, 'sawtooth', 0.2); tone(110, 0.05, 0.5, 'sawtooth', 0.15); },
      whoosh: function () { sweep(220, 1200, 0.35, 0.12); },
      reveal: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, i * 0.09, 0.22, 'triangle', 0.2); }); },
      fanfare: function () {
        [[523, 0], [523, 0.16], [523, 0.32], [659, 0.48], [784, 0.72], [659, 0.96], [784, 1.12], [1047, 1.36]].forEach(function (n) {
          tone(n[0], n[1], n[0] === 1047 ? 0.9 : 0.2, 'square', 0.14);
        });
      }
    };
  })();

  // ---------------------------------------------------------------- confetti
  // Plays once each time the winners' podium comes up: two cannons from the
  // bottom corners, then a short shower from the top. It ignores the laptop's
  // reduced motion setting on purpose: it is for the room, not the laptop owner.
  var confetti = (function () {
    var COLORS = ['#F2B43A', '#141414', '#FFFAEB', '#B9A3EC', '#9FD9BF'];
    var canvas = null, ctx = null, parts = [], raf = 0, last = 0, showerUntil = 0, W = 0, Ht = 0;

    function size() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth; Ht = window.innerHeight;
      canvas.width = W * dpr; canvas.height = Ht * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function add(x, y, angle, spread, speed) {
      var a = angle + (Math.random() - 0.5) * spread;
      var v = speed * (0.55 + Math.random() * 0.6);
      var s = Ht * (0.008 + Math.random() * 0.008);
      parts.push({
        x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        w: s, h: s * (0.4 + Math.random() * 0.5),
        rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3,
        tilt: Math.random() * 6.28, vt: 0.05 + Math.random() * 0.12,
        c: COLORS[Math.floor(Math.random() * COLORS.length)]
      });
    }
    function frame(now) {
      var dt = Math.min((now - last) / 16.7, 3), g = Ht * 0.0006, drag = Math.pow(0.985, dt);
      last = now;
      if (now < showerUntil) for (var k = 0; k < 3; k++) add(Math.random() * W, -20, Math.PI / 2, 1, Ht * 0.004);
      ctx.clearRect(0, 0, W, Ht);
      parts = parts.filter(function (p) {
        p.vx *= drag; p.vy = p.vy * drag + g * dt;
        p.tilt += p.vt * dt; p.rot += p.vr * dt;
        p.x += (p.vx + Math.sin(p.tilt) * 0.6) * dt; p.y += p.vy * dt;
        if (p.y > Ht + 30) return false;
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(1, Math.cos(p.tilt));
        ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
        return true;
      });
      if (parts.length || now < showerUntil) raf = requestAnimationFrame(frame); else stop();
    }
    function start() {
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.className = 'confetti'; canvas.setAttribute('aria-hidden', 'true');
        ctx = canvas.getContext('2d');
        window.addEventListener('resize', function () { if (raf) size(); });
      }
      stop();
      document.body.appendChild(canvas);
      size();
      for (var i = 0; i < 140; i++) {
        add(0, Ht, -Math.PI / 3, 0.6, Ht * 0.034);
        add(W, Ht, -2 * Math.PI / 3, 0.6, Ht * 0.034);
      }
      last = performance.now(); showerUntil = last + 3500;
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0; parts = []; showerUntil = 0;
      if (canvas && canvas.parentNode) { ctx.clearRect(0, 0, W, Ht); canvas.parentNode.removeChild(canvas); }
    }
    return { start: start, stop: stop };
  })();

  function render() {
    var g = game();
    var html;
    if (!g) html = '<section><p class="kicker">Loading the game...</p></section>';
    else if (g.status === 'lobby') html = viewLobby();
    else if (g.status === 'question' || g.status === 'reveal') html = viewQuestion(g);
    else if (g.status === 'leaderboard') html = viewLeaderboard(g);
    else html = viewFinal();
    if (html !== H.lastHtml) { stage.innerHTML = html; H.lastHtml = html; }
    typewriter(g);
    countUp(g);
    Q.tint(g && (g.status === 'question' || g.status === 'reveal') ? g.category : null);
    voice.players(players(), !!g && g.status === 'lobby');
    var key = g ? g.status + ':' + g.current_index : '';
    if (H.unlocked && H.lastKey && key !== H.lastKey) {
      voice.step(g);
      if (g.status === 'question') sfx.whoosh();
      else if (g.status === 'reveal') sfx.reveal();
      else if (g.status === 'final') sfx.fanfare();
    }
    H.lastKey = key;
    var podium = !!g && g.status === 'final' && H.finalStep === 0;
    if (podium && !H.podiumShown) confetti.start();
    else if (!podium && H.podiumShown) confetti.stop();
    H.podiumShown = podium;
    renderControls();
    renderChips();
    tick();
  }

  function renderChips() {
    var chip = $('connChip');
    chip.className = 'chip ' + (H.online ? 'live' : 'off');
    chip.lastChild.textContent = H.online ? 'Live' : (Q.configured ? 'Offline' : 'Not set up');
    $('cardChip').hidden = !cardOn();
  }

  function renderControls() {
    var g = game();
    var s = g ? g.status : 'lobby';
    var next = $('nextBtn');
    var labels = { lobby: 'Start quiz', question: 'Reveal', reveal: 'Leaderboard' };
    if (s === 'leaderboard') next.textContent = g.current_index + 1 < g.total_questions ? 'Next question' : 'Final results';
    else if (s === 'final') next.textContent = H.finalStep === 0 ? 'Top players' : 'Finished';
    else next.textContent = labels[s];
    next.disabled = H.busy || !g || (s === 'final' && H.finalStep === 1);
    var p = $('pauseBtn');
    p.disabled = H.busy || s !== 'question';
    p.textContent = g && g.paused_at && s === 'question' ? 'Resume' : 'Pause';
    var now = Date.now();
    $('endBtn').textContent = H.armed.end > now ? 'Click again to end' : 'End quiz';
    $('endBtn').className = H.armed.end > now ? 'arm' : '';
    $('endBtn').disabled = H.busy || !g || s === 'final';
    $('resetBtn').textContent = H.armed.reset > now ? 'Click again to reset' : 'Reset game';
    $('resetBtn').className = H.armed.reset > now ? 'arm' : '';
    $('manageBtn').hidden = s !== 'lobby';
    $('manageBtn').setAttribute('aria-pressed', String(H.manage));
    $('cardToggle').checked = cardOn();
  }

  // Timer ring, status line and auto-reveal at time up (after the 1 second grace).
  function tick() {
    var g = game();
    if (!g || g.status !== 'question') { Q.sun(1); return; }
    var left = Q.remaining(g);
    Q.sun.question(1 - left / (g.duration_s || 20));
    var t = $('ringT'), prog = $('ringProg'), st = $('qStatus');
    var shown = Math.max(0, Math.ceil(left));
    if (t) {
      t.textContent = g.paused_at ? 'Paused' : String(shown);
      t.className = 't' + (g.paused_at ? ' small' : '');
      t.parentNode.className = 'ring' + (!g.paused_at && shown > 0 && shown <= 5 ? ' low' : '');
    }
    if (!g.paused_at && shown !== H.lastShown) {
      if (shown > 0 && shown <= 5) sfx.tick(shown);
      else if (shown === 0 && H.lastShown === 1) sfx.buzz();
      H.lastShown = shown;
    }
    if (prog) prog.setAttribute('stroke-dashoffset', String(276.46 * (1 - Math.max(0, Math.min(1, left / (g.duration_s || 20))))));
    if (st) {
      var all = !g.card_mode && players().length > 0 && H.view && H.view.answers_in >= players().length;
      st.textContent = g.paused_at ? 'Timer paused' : left <= 0 ? (g.card_mode ? 'Time\'s up. Cards up!' : 'Time\'s up')
        : all ? 'Everyone has answered' : '';
    }
    if (!g.card_mode && !g.paused_at && left <= -1 && !H.autoRevealed[g.current_index] && !H.busy) {
      H.autoRevealed[g.current_index] = true;
      act('host_reveal', { p_index: g.current_index });
    }
  }

  var toastTimer;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3800);
  }

  // ---------------------------------------------------------------- PIN gate
  function sha(text) {
    try {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(CODE + ':' + text)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      });
    } catch (e) { return Promise.resolve(null); }
  }

  function relock(reason) {
    H.unlocked = false;
    H.pin = null;
    Q.session.del(K.pin);
    $('gate').hidden = false;
    $('gateError').textContent = reason === 'pin_not_set'
      ? 'No host PIN is set yet. Run set_host_pin in the Supabase SQL editor.'
      : 'Wrong PIN. Try again.';
    $('pin').focus();
  }

  function unlocked() {
    H.unlocked = true;
    $('pin').blur();
    $('gate').hidden = true;
    render();
  }

  function tryUnlock(pin) {
    var btn = $('gateBtn'), err = $('gateError');
    err.textContent = '';
    if (!Q.configured) {
      err.textContent = 'Add the Supabase URL and anon key to config.js first.';
      offlineOption(pin);
      return;
    }
    btn.disabled = true; btn.textContent = 'Checking...';
    H.pin = pin;
    var sent = Date.now();
    Q.rpc('host_login', { p_code: CODE, p_pin: pin }, 10000).then(function (r) {
      btn.disabled = false; btn.textContent = 'Unlock';
      if (r.network) {
        setOnline(false);
        err.textContent = 'No connection to Supabase.';
        offlineOption(pin);
        return;
      }
      if (r.error) {
        H.pin = null; Q.session.del(K.pin);
        err.textContent = {
          bad_pin: 'Wrong PIN. Try again.',
          locked: 'Too many wrong PINs. Wait a minute and try again.',
          pin_not_set: 'No host PIN is set yet. Run set_host_pin in the Supabase SQL editor.',
          game_not_found: 'No game called ' + CODE + '. Run supabase.sql first.'
        }[r.error] || ('Error: ' + r.error);
        return;
      }
      setOnline(true);
      Q.session.set(K.pin, pin);
      sha(pin).then(function (h) { if (h) Q.local.set(K.pinHash, h); });
      Q.syncClock(r.data.server_now, sent, Date.now());
      // A reset elsewhere wipes local card state that no longer matches.
      if (H.view && H.view.game && r.data.game.id !== H.view.game.id) { H.card = null; Q.local.del(K.card); }
      H.view = null;
      applyView(r.data);
      loadQuestions();
      if (cardOn()) push();
      unlocked();
      if (!r.data.game.total_questions) toast('No questions loaded. Run questions.local.sql in Supabase.');
    });
  }

  // Offline start: only with cached questions and the PIN that last worked here.
  function offlineOption(pin) {
    var b = $('offlineBtn');
    if (!H.questions) { b.hidden = true; return; }
    sha(pin).then(function (h) {
      var known = Q.local.get(K.pinHash);
      var match = !!(h && known && h === known);
      b.hidden = !match;
      if (match && cardOn()) startOffline(); // reload during a card round: carry on
    });
  }

  function startOffline() {
    H.pin = $('pin').value || H.pin;
    Q.session.set(K.pin, H.pin);
    if (!cardOn()) setCardMode(true);
    unlocked();
    toast('Offline. Card mode is on. Scores sync when the internet is back.');
  }

  // ---------------------------------------------------------------- wiring
  $('controls').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]');
    if (!b || !H.unlocked) return;
    b.blur();
    var a = b.getAttribute('data-act');
    if (a === 'next') next();
    else if (a === 'back') back();
    else if (a === 'pause') pause();
    else if (a === 'end') end();
    else if (a === 'reset') reset();
    else if (a === 'manage') { H.manage = !H.manage; render(); }
    else if (a === 'voice') { voice.toggle(); labelSwitches(); }
    else if (a === 'scores') { H.hideScores = !H.hideScores; Q.local.set('tnbq_hide_scores', H.hideScores ? 'on' : 'off'); labelSwitches(); render(); }
    else if (a === 'sound') { sfx.toggle(); b.setAttribute('aria-pressed', String(sfx.on())); b.textContent = sfx.on() ? 'Sound on' : 'Sound off'; }
    else if (a === 'fullscreen') {
      try {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
      } catch (err) {}
    }
  });
  $('cardToggle').addEventListener('change', function (e) {
    e.target.blur();
    if (!H.unlocked) { e.target.checked = cardOn(); return; }
    setCardMode(e.target.checked);
  });
  stage.addEventListener('click', function (e) {
    var aw = e.target.closest('[data-award]');
    if (aw) return toggleAward(aw.getAttribute('data-award'));
    var rm = e.target.closest('[data-remove]');
    if (rm) return removePlayer(rm.getAttribute('data-remove'), rm.getAttribute('data-name'));
  });
  document.addEventListener('keydown', function (e) {
    if (!H.unlocked || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target;
    if (t && ((t.tagName === 'INPUT' && t.type !== 'checkbox') || t.tagName === 'TEXTAREA')) return;
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); back(); }
  });
  $('gateForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var pin = $('pin').value.trim();
    sfx.unlock();
    if (pin) tryUnlock(pin);
  });
  $('offlineBtn').addEventListener('click', startOffline);
  window.addEventListener('online', function () { if (H.unlocked) call('host_state').then(render); });

  $('soundBtn').setAttribute('aria-pressed', String(sfx.on()));
  $('soundBtn').textContent = sfx.on() ? 'Sound on' : 'Sound off';
  function labelSwitches() {
    $('voiceBtn').setAttribute('aria-pressed', String(voice.on()));
    $('voiceBtn').textContent = voice.on() ? 'Voice on' : 'Voice off';
    $('scoresBtn').setAttribute('aria-pressed', String(H.hideScores));
    $('scoresBtn').textContent = H.hideScores ? 'Scores hidden' : 'Scores shown';
  }
  labelSwitches();
  setInterval(tick, 100);
  render();
  if (H.pin) { $('pin').value = H.pin; tryUnlock(H.pin); } else { $('pin').focus(); }
  setTimeout(poll, 1000);

  // Keep the host page available offline for card mode after a reload.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
