// Load test: 100 simulated phones play all the questions while this script runs the host.
//
//   cd quiz/loadtest && npm install
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=... HOST_PIN=... node loadtest.mjs --yes
//
// Flags: --players 100  --code TNB  --fast (reveal as soon as everyone answered)
//        --keep (do not reset the game at the end)  --yes (allow the reset at the start)
//
// It RESETS the game (deletes all players and answers) before and after. Never run it during the event.
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

const URL_ = opt('url', process.env.SUPABASE_URL);
const KEY = opt('key', process.env.SUPABASE_ANON_KEY);
const PIN = opt('pin', process.env.HOST_PIN);
const CODE = opt('code', 'TNB');
const N = Number(opt('players', 100));
const FAST = flag('fast');
const GROUPS = ['Rumuola', 'Rumuokoro', 'Mile 1', 'Mile 2', 'Slaughter', 'Eleme', 'Airforce', 'Agip', 'Waterlines', 'Rumukurushi', 'Artillery']; // keep in sync with common.js

if (!URL_ || !KEY || !PIN) {
  console.error('Set SUPABASE_URL, SUPABASE_ANON_KEY and HOST_PIN (or pass --url --key --pin).');
  process.exit(2);
}
if (!flag('yes')) {
  console.error('This deletes every player and answer in game ' + CODE + '. Re-run with --yes to continue.');
  process.exit(2);
}

const mk = () => createClient(URL_, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket, params: { eventsPerSecond: 2 } }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = (s) => Date.parse(String(s).replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'));
const pct = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p / 100 * a.length))]; };

const R = {
  joinOk: 0, joinFail: [], subOk: 0, subFail: [], subscribeMs: [],
  answers: 0, accepted: 0, rejected: {}, rpcErrors: [],
  expectedEvents: 0, receivedEvents: 0, missing: [], duplicates: 0, latencyMs: [],
  pollRecoveries: 0, leaks: [], scoreMismatch: [], channelErrors: 0, finalOk: 0, finalMissing: 0
};

// ---------------------------------------------------------------- host
const host = mk();
let offset = 0;
async function hostCall(fn, extra = {}) {
  const t0 = Date.now();
  const { data, error } = await host.rpc(fn, { p_code: CODE, p_pin: PIN, ...extra });
  if (error) throw new Error(fn + ': ' + error.message);
  if (data && data.error) throw new Error(fn + ': ' + data.error);
  if (data && data.server_now) offset = ts(data.server_now) - (t0 + Date.now()) / 2;
  return data;
}

console.log(`Teams & Banter quiz load test: ${N} players against ${URL_}`);
await hostCall('host_login');
const questions = (await hostCall('host_questions')).questions;
await hostCall('host_reset');
const gameId = (await hostCall('host_state')).game.id;
console.log(`Game ${CODE} reset. ${questions.length} questions.`);

// ---------------------------------------------------------------- players
class Phone {
  constructor(i) {
    this.i = i;
    this.name = 'Load ' + String(i + 1).padStart(3, '0');
    this.group = GROUPS[i % GROUPS.length];
    this.client = mk();
    this.seen = new Set();
    this.answered = new Map(); // idx -> { choice, correct, sentAt, startedAt }
    this.results = new Map();
    this.game = null;
  }
  async join() {
    const { data, error } = await this.client.rpc('player_join', { p_code: CODE, p_name: this.name, p_group: this.group });
    if (error || data.error) throw new Error((error && error.message) || data.error);
    this.id = data.player_id;
  }
  subscribe() {
    const t0 = Date.now();
    return new Promise((resolve) => {
      let done = false;
      this.channel = this.client.channel('game-' + gameId)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: 'id=eq.' + gameId },
          (p) => this.onRow(p.new))
        .subscribe((status, err) => {
          if (status === 'SUBSCRIBED' && !done) { done = true; R.subOk++; R.subscribeMs.push(Date.now() - t0); resolve(true); }
          else if (status !== 'SUBSCRIBED') {
            R.channelErrors++;
            if (!done) { done = true; R.subFail.push(this.name + ': ' + status + (err ? ' ' + err.message : '')); resolve(false); }
          }
        });
      setTimeout(() => { if (!done) { done = true; R.subFail.push(this.name + ': timeout'); resolve(false); } }, 20000);
    });
  }
  onRow(row) {
    const key = row.status + ':' + row.current_index;
    if (this.seen.has(key)) { R.duplicates++; return; }
    this.seen.add(key);
    R.receivedEvents++;
    R.latencyMs.push(Date.now() + offset - ts(row.updated_at));
    if (row.status === 'question' && (row.revealed_index !== null || row.explanation !== null)) R.leaks.push(this.name + ' got the answer during question ' + row.current_index);
    if (row.status === 'question') this.scheduleAnswer(row);
    if (row.status === 'reveal') setTimeout(() => this.checkResult(row.current_index), Math.random() * 1500);
    if (row.status === 'final') setTimeout(() => this.checkFinal(), Math.random() * 2500);
  }
  scheduleAnswer(row) {
    const q = questions[row.current_index];
    const startedAt = ts(row.started_at);
    const at = startedAt + 300 + Math.random() * 13700; // inside the 15 seconds
    const n = (q.options && q.options.length) || 4;
    const choice = Math.random() < 0.6 ? q.correct_index : (q.correct_index + 1 + Math.floor(Math.random() * (n - 1))) % n;
    setTimeout(() => this.answer(row.current_index, choice, startedAt), Math.max(0, at - (Date.now() + offset)));
  }
  async answer(idx, choice, startedAt) {
    R.answers++;
    const sentAt = Date.now() + offset;
    const { data, error } = await this.client.rpc('submit_answer', { p_player: this.id, p_question_idx: idx, p_choice: choice });
    if (error) { R.rpcErrors.push(this.name + ' submit: ' + error.message); return; }
    if (data.ok) { R.accepted++; this.answered.set(idx, { choice, startedAt, sentAt }); }
    else R.rejected[data.error] = (R.rejected[data.error] || 0) + 1;
  }
  async sync() {
    const { data, error } = await this.client.rpc('player_sync', { p_player: this.id });
    if (error) { R.rpcErrors.push(this.name + ' sync: ' + error.message); return null; }
    return data;
  }
  async checkResult(idx) {
    const d = await this.sync();
    if (!d || !d.result) return;
    const a = this.answered.get(idx);
    const q = questions[idx];
    if (!a) { if (d.result.answered) R.scoreMismatch.push(`${this.name} q${idx}: answered on server only`); return; }
    const correct = a.choice === q.correct_index;
    if (d.result.is_correct !== correct) R.scoreMismatch.push(`${this.name} q${idx}: is_correct ${d.result.is_correct}`);
    if (!correct && d.result.points !== 0) R.scoreMismatch.push(`${this.name} q${idx}: wrong answer scored ${d.result.points}`);
    if (correct) {
      const est = 500 + Math.round(500 * (1 - Math.min(15, Math.max(0, (a.sentAt - a.startedAt) / 1000)) / 15));
      if (d.result.points < 500 || d.result.points > 1000 || Math.abs(d.result.points - est) > 40)
        R.scoreMismatch.push(`${this.name} q${idx}: ${d.result.points} points, expected about ${est}`);
    }
  }
  async checkFinal() {
    const d = await this.sync();
    if (d && d.final && d.final.rank >= 1 && d.final.group_rank >= 1) R.finalOk++; else R.finalMissing++;
  }
  // What a real phone does when realtime misses an event: poll player_sync.
  async recover(status, idx) {
    const key = status + ':' + idx;
    if (this.seen.has(key)) return;
    R.missing.push(this.name + ' ' + key);
    const d = await this.sync();
    if (d && d.game && d.game.status === status && d.game.current_index === idx) {
      R.pollRecoveries++;
      this.seen.add(key);
      if (status === 'question') this.scheduleAnswer(d.game);
    }
  }
}

const phones = Array.from({ length: N }, (_, i) => new Phone(i));
let t = Date.now();
await Promise.all(phones.map(async (p) => {
  try { await p.join(); R.joinOk++; } catch (e) { R.joinFail.push(p.name + ': ' + e.message); }
}));
console.log(`Joined ${R.joinOk}/${N} in ${Date.now() - t} ms.`);
const live = phones.filter((p) => p.id);
t = Date.now();
await Promise.all(live.map((p) => p.subscribe()));
console.log(`Realtime subscribed ${R.subOk}/${live.length} in ${Date.now() - t} ms.`);
await sleep(1500);

async function step(fn, extra, status, idx) {
  const before = Date.now();
  await hostCall(fn, extra);
  R.expectedEvents += live.length;
  await sleep(3000);
  await Promise.all(live.map((p) => p.recover(status, idx)));
  return before;
}

// ---------------------------------------------------------------- run the quiz
for (let i = 0; i < questions.length; i++) {
  if (i === 0) await step('host_start', {}, 'question', 0);
  else await step('host_next', { p_from_status: 'leaderboard', p_from_index: i - 1 }, 'question', i);
  const start = Date.now();
  while (Date.now() - start < 21500) {
    await sleep(1000);
    if (FAST) {
      const s = await hostCall('host_state');
      if (s.answers_in >= live.length) break;
    }
  }
  const s = await hostCall('host_state');
  process.stdout.write(`Q${i + 1}: ${s.answers_in}/${live.length} answers. `);
  await step('host_reveal', { p_index: i }, 'reveal', i);
  await step('host_next', { p_from_status: 'reveal', p_from_index: i }, 'leaderboard', i);
  console.log(`events ${R.receivedEvents}/${R.expectedEvents}`);
}
await step('host_next', { p_from_status: 'leaderboard', p_from_index: questions.length - 1 }, 'final', questions.length - 1);
await sleep(3000);

const final = await hostCall('host_state');
const sumTotals = final.players.reduce((a, p) => a + p.total, 0);
const groupLine = final.groups.map((g) => `${g.name} ${Math.round(g.score)}`).join(', ');

// ---------------------------------------------------------------- report
console.log('\n================ RESULTS ================');
console.log(`Players joined           ${R.joinOk}/${N}` + (R.joinFail.length ? `  failures: ${R.joinFail.slice(0, 5).join('; ')}` : ''));
console.log(`Realtime subscribed      ${R.subOk}/${live.length}  (p50 ${pct(R.subscribeMs, 50)} ms, max ${Math.max(0, ...R.subscribeMs)} ms)` + (R.subFail.length ? `  failures: ${R.subFail.slice(0, 5).join('; ')}` : ''));
console.log(`Answers sent             ${R.answers}`);
console.log(`Answers accepted         ${R.accepted}`);
console.log(`Answers rejected         ${Object.values(R.rejected).reduce((a, b) => a + b, 0)}  ${JSON.stringify(R.rejected)}`);
console.log(`RPC errors               ${R.rpcErrors.length}` + (R.rpcErrors.length ? `  e.g. ${R.rpcErrors.slice(0, 3).join('; ')}` : ''));
console.log(`Realtime events          ${R.receivedEvents}/${R.expectedEvents} received by realtime`);
console.log(`Realtime events dropped  ${R.missing.length}` + (R.missing.length ? `  (recovered by polling: ${R.pollRecoveries})  e.g. ${R.missing.slice(0, 3).join('; ')}` : ''));
console.log(`Duplicate events         ${R.duplicates}`);
console.log(`Channel errors           ${R.channelErrors}`);
console.log(`Event latency            p50 ${pct(R.latencyMs, 50)} ms, p95 ${pct(R.latencyMs, 95)} ms, max ${Math.max(0, ...R.latencyMs)} ms`);
console.log(`Answer leaks             ${R.leaks.length}` + (R.leaks.length ? `  ${R.leaks.slice(0, 3).join('; ')}` : ''));
console.log(`Score mismatches         ${R.scoreMismatch.length}` + (R.scoreMismatch.length ? `  e.g. ${R.scoreMismatch.slice(0, 3).join('; ')}` : ''));
console.log(`Final summaries          ${R.finalOk}/${live.length}`);
console.log(`Sum of player totals     ${sumTotals}`);
console.log(`Group scores             ${groupLine}`);
console.log('=========================================');

if (!flag('keep')) { await hostCall('host_reset'); console.log('Game reset.'); }
for (const p of phones) p.client.removeAllChannels();
host.removeAllChannels();
const bad = R.joinFail.length || R.subFail.length || R.rpcErrors.length || R.leaks.length || R.scoreMismatch.length || R.missing.length;
process.exit(bad ? 1 : 0);
