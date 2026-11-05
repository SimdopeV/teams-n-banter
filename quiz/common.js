// Shared helpers for the player and host pages.
(function () {
  var cfg = window.QUIZ_CONFIG || {};
  var Q = (window.Quiz = {});

  Q.cfg = cfg;
  // Team names. Keep this list identical to _groups() and the two checks in supabase.sql.
  Q.GROUPS = ['Rumuola', 'Rumuokoro', 'Mile 1', 'Mile 2', 'Slaughter', 'Eleme', 'Airforce', 'Agip', 'Waterlines', 'Rumukurushi', 'Artillery'];
  Q.LETTERS = ['A', 'B', 'C', 'D'];
  Q.configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    cfg.SUPABASE_URL.indexOf('YOUR-') < 0 && cfg.SUPABASE_ANON_KEY.indexOf('YOUR-') < 0);

  // Storage can be missing or throw (private mode, blocked site data).
  function wrap(kind) {
    return {
      get: function (k) { try { return window[kind].getItem(k); } catch (e) { return null; } },
      set: function (k, v) { try { window[kind].setItem(k, v); } catch (e) {} },
      del: function (k) { try { window[kind].removeItem(k); } catch (e) {} },
      getJSON: function (k) { try { return JSON.parse(window[kind].getItem(k)); } catch (e) { return null; } },
      setJSON: function (k, v) { try { window[kind].setItem(k, JSON.stringify(v)); } catch (e) {} }
    };
  }
  Q.local = wrap('localStorage');
  Q.session = wrap('sessionStorage');

  // Sunrise background. Quiz.sun(1) brings the sun up slowly (page open, between
  // questions). Quiz.sun.question(fraction) follows a question's timer: at a new
  // question the sun first dips below the edge, then climbs as time runs out.
  // Phones that ask for reduced motion just keep the sun up.
  (function () {
    var root = document.documentElement;
    var last = null, holdUntil = 0;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    function still() { return !document.body.classList.contains('host') && !!(reduce && reduce.matches); }
    function set(v, secs, ease) {
      root.style.setProperty('--rise-t', secs + 's');
      root.style.setProperty('--rise-ease', ease);
      root.style.setProperty('--rise', String(v));
      last = v;
    }
    Q.sun = function (v) {
      if (still()) v = 1;
      if (last === v) return;
      holdUntil = 0;
      set(v, still() ? 0 : (last === null ? 7 : 3), 'cubic-bezier(.2, .7, .3, 1)');
    };
    Q.sun.question = function (f) {
      if (still()) return Q.sun(1);
      f = Math.max(0, Math.min(1, f));
      var now = Date.now();
      if (last === null || last - f > 0.25) {
        // New question: drop quickly, then let the timer take over.
        set(0, 0.9, 'cubic-bezier(.5, 0, .75, 0)');
        holdUntil = now + 900;
        return;
      }
      if (now < holdUntil) return;
      if (Math.abs(f - last) < 0.002) return;
      set(f, 0.35, 'linear');
    };
    // Rise once when the page opens.
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      if (last === null) set(1, still() ? 0 : 7, 'cubic-bezier(.2, .7, .3, 1)');
    }); });
  })();

  Q.client = null;
  if (Q.configured && window.supabase) {
    Q.client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 2 } }
    });
  }

  // RPC with a timeout. Resolves { data } or { error, network }.
  Q.rpc = function (fn, args, timeoutMs) {
    if (!Q.client) return Promise.resolve({ error: 'not_configured', network: true });
    var timer;
    var timeout = new Promise(function (resolve) {
      timer = setTimeout(function () { resolve({ error: 'timeout', network: true }); }, timeoutMs || 8000);
    });
    var call = Q.client.rpc(fn, args).then(function (res) {
      if (res.error) {
        var msg = res.error.message || String(res.error);
        var network = !res.error.code || /fetch|network|Failed|Load failed/i.test(msg);
        return { error: msg, network: network };
      }
      if (res.data && res.data.error) return { error: res.data.error, data: res.data };
      return { data: res.data };
    }, function (err) {
      return { error: String(err && err.message || err), network: true };
    });
    return Promise.race([call, timeout]).then(function (r) { clearTimeout(timer); return r; });
  };

  // Server clock. Keep the sample with the shortest round trip.
  var bestRtt = Infinity;
  Q.offset = 0;
  Q.syncClock = function (serverNow, sentAt, gotAt) {
    var server = Q.ts(serverNow);
    if (!server) return;
    var rtt = gotAt - sentAt;
    // Re-sample after a while in case the phone clock was adjusted.
    if (rtt <= bestRtt || rtt < 400) {
      bestRtt = Math.min(rtt, bestRtt);
      Q.offset = server - (sentAt + gotAt) / 2;
    }
  };
  Q.now = function () { return Date.now() + Q.offset; };

  // Postgres timestamps have microseconds; trim to milliseconds for every browser.
  Q.ts = function (s) {
    if (!s) return null;
    if (typeof s === 'number') return s;
    var t = String(s).replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
    if (/[+-]\d\d$/.test(t)) t += ':00';
    var ms = Date.parse(t);
    return isNaN(ms) ? null : ms;
  };

  // Seconds left on the open question (can go negative).
  Q.remaining = function (game, nowMs) {
    if (!game || !game.started_at) return 0;
    var start = Q.ts(game.started_at);
    var end = game.paused_at ? Q.ts(game.paused_at) : (nowMs == null ? Q.now() : nowMs);
    return (game.duration_s || 20) - (end - start) / 1000;
  };

  Q.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  Q.num = function (n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); };
  Q.ordinal = function (n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  // Same rules as public._name_is_blocked in supabase.sql.
  var INSIDE = ['fuck', 'fuk', 'shit', 'cunt', 'nigger', 'nigga', 'bitch', 'whore', 'pussy', 'faggot',
    'fagot', 'motherf', 'asshole', 'bastard', 'wanker', 'retard', 'ashawo', 'pornhub'];
  var WHOLE = ['ass', 'dick', 'cock', 'sex', 'porn', 'rape', 'rapist', 'penis', 'vagina', 'boobs', 'tits',
    'slut', 'hoe', 'fag', 'nude', 'nudes', 'hitler', 'nazi'];
  Q.nameBlocked = function (name) {
    var map = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'i' };
    var n = String(name || '').toLowerCase().replace(/[0134578@$!|]/g, function (c) { return map[c]; });
    var letters = n.replace(/[^a-z]/g, '');
    for (var i = 0; i < INSIDE.length; i++) if (letters.indexOf(INSIDE[i]) >= 0) return true;
    for (var j = 0; j < WHOLE.length; j++) if (new RegExp('(^|[^a-z])' + WHOLE[j] + '([^a-z]|$)').test(n)) return true;
    return false;
  };

  // Listen to UPDATEs on one games row. Returns the channel.
  Q.subscribeGame = function (gameId, onRow, onStatus) {
    if (!Q.client) return null;
    return Q.client
      .channel('game-' + gameId)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'games', filter: 'id=eq.' + gameId },
        function (payload) { if (payload && payload.new) onRow(payload.new); })
      .subscribe(function (status) { if (onStatus) onStatus(status); });
  };

})();
