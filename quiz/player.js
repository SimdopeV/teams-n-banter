// Player page: join, answer, see results. Listens to one games row.
(function () {
  var Q = window.Quiz;
  var $screen = document.getElementById('screen');
  var $banner = document.getElementById('banner');
  var $who = document.getElementById('who');
  var KEY = 'tnbq_player_' + (Q.cfg.GAME_CODE || 'TNB');

  var st = {
    playerId: Q.local.get(KEY),
    player: null,
    game: null,
    choice: null, choiceIdx: null,
    lock: null,          // 'sending' | 'locked' | 'late' for question choiceIdx
    sendError: '',
    result: null,
    total: 0,
    final: null,
    channel: null, chanStatus: null, everSubscribed: false, channelAt: 0,
    netOk: true,
    joinGroup: null, joinError: '', joining: false,
    note: ''
  };
  var screenKey = '';
  var syncTimer = null;
  var syncing = false;

  function letter(i) { return Q.LETTERS[i] || '?'; }
  function opts(g) {
    var o = g && g.options;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { o = null; } }
    return Array.isArray(o) ? o : [];
  }

  // ---------------------------------------------------------------- server
  function sync() {
    if (!st.playerId || syncing) return Promise.resolve();
    syncing = true;
    var sent = Date.now();
    return Q.rpc('player_sync', { p_player: st.playerId }).then(function (r) {
      syncing = false;
      if (r.network) { st.netOk = false; updateBanner(); return; }
      st.netOk = true;
      var d = r.data || {};
      Q.syncClock(d.server_now, sent, Date.now());
      if (!d.player) {
        Q.local.del(KEY);
        st.playerId = null; st.player = null;
        st.note = 'You were removed or the game was reset. Join again.';
        render(); updateBanner();
        return;
      }
      st.player = d.player;
      takeGame(d.game, true);
      if (d.choice != null && st.game) {
        st.choice = d.choice; st.choiceIdx = st.game.current_index; st.lock = 'locked';
      }
      if (d.total != null) st.total = d.total;
      st.result = d.result || st.result;
      st.final = d.final || null;
      ensureChannel(st.game.id);
      render(); updateBanner();
    });
  }

  function scheduleSync(maxJitter) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, Math.random() * (maxJitter || 0));
  }

  // Accept a games row unless it is older than the one we have.
  function takeGame(row, fromSync) {
    if (!row) return false;
    if (st.game && Q.ts(row.updated_at) < Q.ts(st.game.updated_at)) return false;
    var prev = st.game;
    st.game = row;
    if (row.current_index !== st.choiceIdx) {
      st.choice = null; st.choiceIdx = null; st.lock = null; st.sendError = '';
    }
    if (fromSync) return true;
    var s = row.status;
    var idx = row.current_index;
    if ((s === 'reveal' || s === 'leaderboard') && (!st.result || st.result.question_idx !== idx)) scheduleSync(1500);
    if (s === 'final' && !st.final) scheduleSync(2500);
    if (s === 'lobby' && prev && prev.status !== 'lobby') scheduleSync(3000); // reset: check we still exist
    return true;
  }

  function onRow(row) {
    if (takeGame(row, false)) render();
  }

  function ensureChannel(gameId) {
    if (st.channel || !gameId) return;
    st.channelAt = Date.now();
    st.channel = Q.subscribeGame(gameId, onRow, function (status) {
      var was = st.chanStatus;
      st.chanStatus = status;
      if (status === 'SUBSCRIBED') {
        // Catch up on anything missed while the socket was down.
        if (st.everSubscribed || was !== 'SUBSCRIBED') scheduleSync(st.everSubscribed ? 1500 : 0);
        st.everSubscribed = true;
      }
      updateBanner();
    });
  }

  // Safety net: a slow poll while realtime is up, a fast one while it is down.
  function pollLoop() {
    var live = st.chanStatus === 'SUBSCRIBED' && st.netOk;
    if (st.playerId) sync();
    setTimeout(pollLoop, live ? 15000 : 3000);
  }

  function updateBanner() {
    var down = false;
    if (st.playerId) {
      if (!st.netOk || navigator.onLine === false) down = true;
      else if (st.channel && st.everSubscribed && st.chanStatus !== 'SUBSCRIBED') down = true;
      else if (st.channel && !st.everSubscribed && Date.now() - st.channelAt > 6000) down = true;
    }
    $banner.hidden = !down;
  }

  // ---------------------------------------------------------------- actions
  function join() {
    var input = document.getElementById('name');
    var name = (input ? input.value : '').replace(/\s+/g, ' ').trim();
    if (!name) return showJoinError('Type your name first.');
    if (name.length > 20) return showJoinError('Use 20 characters or fewer.');
    if (Q.nameBlocked(name)) return showJoinError('Please pick a different name.');
    if (!st.joinGroup) return showJoinError('Tap your team.');
    st.joining = true; updateJoinButton(); showJoinError('');
    wakeLock();
    Q.rpc('player_join', { p_code: Q.cfg.GAME_CODE, p_name: name, p_group: st.joinGroup }).then(function (r) {
      st.joining = false;
      if (r.error) {
        updateJoinButton();
        var msg = {
          name_blocked: 'Please pick a different name.',
          name_required: 'Type your name first.',
          name_too_long: 'Use 20 characters or fewer.',
          bad_group: 'Tap your team.',
          game_not_found: 'The quiz is not open yet.',
          game_full: 'The quiz is full.'
        }[r.error] || (r.network ? 'No connection. Try again.' : 'Something went wrong. Try again.');
        return showJoinError(msg);
      }
      st.playerId = r.data.player_id;
      st.note = '';
      Q.local.set(KEY, st.playerId);
      st.player = { id: r.data.player_id, name: r.data.name, group: r.data.group };
      sync();
    });
  }

  function answer(i) {
    var g = st.game;
    if (!g || g.status !== 'question' || st.lock === 'sending' || st.lock === 'locked') return;
    var idx = g.current_index;
    st.choice = i; st.choiceIdx = idx; st.lock = 'sending'; st.sendError = '';
    wakeLock();
    render();
    var tries = 0;
    (function send() {
      tries++;
      Q.rpc('submit_answer', { p_player: st.playerId, p_question_idx: idx, p_choice: i }, 6000).then(function (r) {
        if (!st.game || st.game.current_index !== idx) return;
        if (!r.error || r.error === 'duplicate') { st.lock = 'locked'; st.netOk = true; }
        else if (r.network && tries < 4) { setTimeout(send, 400 * tries); return; }
        else if (r.network) { st.lock = null; st.choice = null; st.sendError = 'Could not send. Tap again.'; st.netOk = false; }
        else if (r.error === 'player_not_found') { Q.local.del(KEY); st.playerId = null; st.player = null; }
        else if (r.error === 'card_mode') { st.lock = null; st.choice = null; }
        else { st.lock = 'late'; }
        render(); updateBanner();
      });
    })();
  }

  var lock = null;
  function wakeLock() {
    try {
      if (navigator.wakeLock && !lock && document.visibilityState === 'visible') {
        navigator.wakeLock.request('screen').then(function (l) {
          lock = l; l.addEventListener('release', function () { lock = null; });
        }, function () {});
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------- views
  function keyFor() {
    if (!Q.configured) return 'nocfg';
    if (!st.playerId) return 'join';
    var g = st.game;
    if (!st.player || !g) return 'loading';
    var idx = g.current_index;
    if (g.status === 'lobby') return 'lobby';
    if (g.status === 'question') {
      if (g.card_mode) return 'card:' + idx;
      if (st.choiceIdx === idx && st.lock === 'locked') return 'locked:' + idx + ':' + st.choice;
      if (st.choiceIdx === idx && st.lock === 'sending') return 'sending:' + idx + ':' + st.choice;
      if (st.lock === 'late' || Q.remaining(g) <= 0) return 'late:' + idx;
      return 'open:' + idx + ':' + st.sendError;
    }
    if (g.status === 'reveal' || g.status === 'leaderboard') {
      var have = st.result && st.result.question_idx === idx ? 'y' : 'n';
      return 'res:' + idx + ':' + g.status + ':' + have + ':' + g.card_mode;
    }
    if (g.status === 'final') return 'final:' + (st.final ? 'y' : 'n');
    return 'loading';
  }

  function render() {
    $who.textContent = st.player ? st.player.name + ' · ' + st.player.group : '';
    var key = keyFor();
    if (key === screenKey) { tick(); return; }
    screenKey = key;
    var kind = key.split(':')[0];
    var html = {
      nocfg: viewNoConfig, join: viewJoin, loading: viewLoading, lobby: viewLobby,
      open: viewQuestion, sending: viewQuestion, locked: viewQuestion, late: viewQuestion, card: viewQuestion,
      res: viewResult, final: viewFinal
    }[kind]();
    $screen.innerHTML = html;
    bind(kind);
    tick();
  }

  function viewNoConfig() {
    return '<h1>Quiz not set up yet</h1><p class="lede">The host still needs to add the Supabase settings.</p>';
  }
  function viewLoading() { return '<p class="lede">Loading...</p>'; }

  function viewJoin() {
    var groups = Q.GROUPS.map(function (g) {
      return '<button type="button" class="group-btn" data-group="' + g + '" aria-pressed="' + (st.joinGroup === g) + '">' + g + '</button>';
    }).join('');
    return '' +
      '<h1>Join the <span class="grad-text">banter</span></h1>' +
      (st.note ? '<p class="lede">' + Q.esc(st.note) + '</p>' : '<p class="lede">The ultimate team trivia challenge for friends. Fifteen questions. Fastest right answer scores most.</p>') +
      '<form id="joinForm" class="screen" novalidate autocomplete="off">' +
      '  <div class="field"><p class="label"><label for="name">Your name</label></p>' +
      '    <input id="name" name="name" maxlength="20" enterkeyhint="done" autocapitalize="words" spellcheck="false" required>' +
      '    <div class="count" id="count">0 / 20</div></div>' +
      '  <div><p class="label">Your team</p><div class="groups" role="group" aria-label="Your team">' + groups + '</div></div>' +
      '  <p class="error" id="joinError" role="alert"></p>' +
      '  <button class="primary" id="joinBtn" type="submit">Join</button>' +
      '</form>';
  }

  function viewLobby() {
    return '<div class="card big-wait">' +
      '<h1>You\'re in, <span class="name">' + Q.esc(st.player.name) + '</span>.</h1>' +
      '<p class="lede" style="margin-top:10px">' + Q.esc(st.player.group) + '. Eyes on the big screen.</p>' +
      '</div>' +
      '<p class="lede">The first question pops up here. Keep this page open and your banter ready.</p>';
  }

  function viewQuestion() {
    var g = st.game, idx = g.current_index;
    var o = opts(g);
    var locked = st.choiceIdx === idx && (st.lock === 'locked' || st.lock === 'sending');
    var late = !locked && (st.lock === 'late' || Q.remaining(g) <= 0);
    var cls = g.card_mode ? 'static' : (locked || late ? 'locked' : '');
    var buttons = o.map(function (text, i) {
      var picked = locked && st.choice === i ? ' picked' : '';
      var dis = g.card_mode || locked || late ? ' disabled' : '';
      return '<button type="button" class="answer tile t' + i + picked + '" data-choice="' + i + '"' + dis + '>' +
        '<span class="badge">' + letter(i) + '</span><span>' + Q.esc(text) + '</span></button>';
    }).join('');
    var status = '';
    if (g.card_mode) status = '<p class="status-line">Card round. Hold up your team\'s card.</p>';
    else if (st.lock === 'sending' && locked) status = '<p class="status-line">Sending...</p>';
    else if (locked) status = '<p class="status-line">Answer locked. Waiting for everyone.</p>';
    else if (late) status = '<p class="status-line">Time\'s up.</p>';
    else if (st.sendError) status = '<p class="status-line error">' + Q.esc(st.sendError) + '</p>';
    return '' +
      '<div class="qhead"><span class="qmeta">Question ' + (idx + 1) + ' of ' + g.total_questions +
      (g.category ? ' · ' + Q.esc(g.category) : '') + '</span><span class="timer" id="timer"></span></div>' +
      '<div class="bar"><i id="bar"></i></div>' +
      '<p class="qtext">' + Q.esc(g.question_text) + '</p>' +
      '<div class="answers ' + cls + '">' + buttons + '</div>' + status;
  }

  // A line of banter under each result. Picked by question number so it stays put when the screen redraws.
  var BANTER = {
    good: ['Big brain energy.', 'Your team owes you a drink.', 'Say it with your chest!', 'Clean. No notes.', 'Somebody\'s been studying.'],
    bad: ['The banter was strong. The answer was not.', 'Blame it on your teammates.', 'Shake it off. Next one is yours.', 'Confidence: 100. Accuracy: 0.', 'We move!'],
    none: ['Too busy bantering?', 'Thumbs were on airplane mode.', 'Silence is not an answer, boss.']
  };
  function banter(kind, idx) {
    var list = BANTER[kind];
    var name = (st.player && st.player.name) || '';
    return Q.esc(list[(idx + name.length) % list.length]);
  }

  function revealedBox(g) {
    var o = opts(g), r = g.revealed_index;
    if (r == null || !o[r]) return '';
    return '<div><p class="label">Right answer</p>' +
      '<div class="reveal-answer tile t' + r + '"><span class="badge">' + letter(r) + '</span><span>' + Q.esc(o[r]) + '</span></div></div>' +
      (g.explanation ? '<p class="explain">' + Q.esc(g.explanation) + '</p>' : '');
  }

  function viewResult() {
    var g = st.game, idx = g.current_index;
    var res = st.result && st.result.question_idx === idx ? st.result : null;
    var top;
    if (g.card_mode && !(res && res.answered)) {
      top = '<div class="card result"><p class="verdict">Card round</p><p class="total">Your total ' + Q.num(st.total) + '</p></div>';
    } else if (!res) {
      top = '<div class="card result"><p class="lede">Checking your answer...</p></div>';
    } else if (!res.answered) {
      top = '<div class="card result bad pop"><p class="verdict">No answer</p><p class="banter">' + banter('none', idx) + '</p><p class="points">+0 points</p>' +
        '<p class="total">Total ' + Q.num(st.total) + '</p></div>';
    } else {
      top = '<div class="card result pop ' + (res.is_correct ? 'good' : 'bad') + '">' +
        '<p class="verdict">' + (res.is_correct ? 'Correct!' : 'Not quite') + '</p>' +
        '<p class="banter">' + banter(res.is_correct ? 'good' : 'bad', idx) + '</p>' +
        '<p class="points">+' + Q.num(res.points) + ' points</p>' +
        '<p class="total">Total ' + Q.num(st.total) + '</p></div>';
    }
    var foot = g.status === 'leaderboard' ? '<p class="status-line">Leaderboard is on the big screen.</p>' : '';
    return '<p class="qmeta">Question ' + (idx + 1) + ' of ' + g.total_questions + '</p>' + top + revealedBox(g) + foot;
  }

  function viewFinal() {
    var f = st.final;
    if (!f) return '<h1>That\'s a wrap</h1><p class="lede">Loading your results...</p>';
    return '' +
      '<h1>That\'s a <span class="grad-text">wrap</span></h1>' +
      '<div class="card"><p class="label">Your score</p><p class="final-num">' + Q.num(st.total) + '</p></div>' +
      '<div class="card">' +
      '<div class="final-row" style="border-top:0"><span>Your rank</span><b>' + Q.ordinal(f.rank) + ' of ' + f.players + '</b></div>' +
      '<div class="final-row"><span>' + Q.esc(st.player.group) + '</span><b>' + Q.ordinal(f.group_rank) + ' of ' + f.groups + '</b></div>' +
      '<div class="final-row"><span>Team score</span><b>' + Q.num(f.group_score) + '</b></div>' +
      '</div>' +
      '<p class="lede">GG! Thanks for bringing the banter. See you at the next one.</p>';
  }

  // ---------------------------------------------------------------- events
  function showJoinError(msg) {
    st.joinError = msg;
    var el = document.getElementById('joinError');
    if (el) el.textContent = msg;
  }
  function updateJoinButton() {
    var b = document.getElementById('joinBtn');
    if (b) { b.disabled = st.joining; b.textContent = st.joining ? 'Joining...' : 'Join'; }
  }

  function bind(kind) {
    if (kind === 'join') {
      var form = document.getElementById('joinForm');
      var input = document.getElementById('name');
      var count = document.getElementById('count');
      input.addEventListener('input', function () { count.textContent = input.value.length + ' / 20'; });
      form.addEventListener('submit', function (e) { e.preventDefault(); join(); });
      Array.prototype.forEach.call(document.querySelectorAll('.group-btn'), function (b) {
        b.addEventListener('click', function () {
          st.joinGroup = b.getAttribute('data-group');
          Array.prototype.forEach.call(document.querySelectorAll('.group-btn'), function (x) {
            x.setAttribute('aria-pressed', String(x === b));
          });
          showJoinError('');
        });
      });
    }
    if (kind === 'open') {
      Array.prototype.forEach.call(document.querySelectorAll('.answer'), function (b) {
        b.addEventListener('click', function () { answer(Number(b.getAttribute('data-choice'))); });
      });
    }
  }

  // Countdown runs locally from started_at plus the server clock offset.
  function tick() {
    var g = st.game;
    var t = document.getElementById('timer');
    if (!g || g.status !== 'question') Q.sun(1);
    else Q.sun.question(1 - Q.remaining(g) / (g.duration_s || 20));
    if (!t || !g || g.status !== 'question') return;
    var left = Q.remaining(g);
    var shown = Math.max(0, Math.ceil(left));
    t.textContent = g.paused_at ? 'Paused' : String(shown);
    t.className = 'timer' + (shown <= 5 ? ' low' : '');
    var bar = document.getElementById('bar');
    if (bar) bar.style.transform = 'scaleX(' + Math.max(0, Math.min(1, left / (g.duration_s || 20))) + ')';
    if (keyFor() !== screenKey) render();
  }

  setInterval(tick, 250);
  setInterval(updateBanner, 2000);
  window.addEventListener('online', function () { sync(); updateBanner(); });
  window.addEventListener('offline', updateBanner);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { sync(); wakeLock(); }
  });

  render();
  if (st.playerId) sync();
  setTimeout(pollLoop, 15000);
})();
