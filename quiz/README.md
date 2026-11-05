# Teams & Banter Live Quiz

Live team trivia for Teams & Banter (Saturday 7 November 2026, 4 PM). 15 questions, 20 seconds each, phones answer and the projector runs the show.

Built on the Arc PH quiz engine (`../arc-ph/quiz`), with a new theme copied from @teamsnbanter: mustard and cream rays, black speech bubbles, chunky outlined type (Luckiest Guy + Outfit).

- Players: `index.html` (phones)
- Host: `host.html` (projector)
- Theme preview with fake data, no Supabase needed: `preview.html?s=lobby` (also `question`, `reveal`, `leaderboard`, `podium`, `join`, `wait`, `answer`, `good`, `bad`, `final`)

Plain HTML, CSS and JavaScript. No build step. Supabase does the database and realtime.

## Still to do before Saturday

- [x] The 15 questions are in `questions.local.sql` (4 are True/False with two options)
- [x] 11 teams: Rumuola, Rumuokoro, Mile 1, Mile 2, Slaughter, Eleme, Airforce, Agip, Waterlines, Rumukurushi, Artillery. To change them, edit `common.js`, `supabase.sql` (three places) and `loadtest/loadtest.mjs`, then run `supabase.sql` again
- [x] Logo: `tnb-logo.png` (official logo, background made transparent)
- [x] Supabase project `teams-n-banter-quiz` (ymyjsxkjgajbefbvfpgl), schema and 15 questions loaded, `config.js` filled
- [x] Hosted on GitHub Pages: https://simdopev.github.io/teams-n-banter/quiz/ (host: host.html)
- [ ] Set the host PIN (README step 3)
- [ ] Rehearse with 10 phones (section 7)

## What is new compared with Arc PH

- Theme: `quiz.css` (tokens at the top) and `host.css`
- "Teams" instead of "groups" in everything players and the room see
- A line of banter under each phone result (`BANTER` in `player.js`)
- Game-show sounds on the host laptop: countdown ticks for the last 5 seconds, a buzzer at time up, a sting on reveal and a fanfare on the podium. Made with Web Audio, so no files and they work offline. **Sound on/off** button in the controls bar.
- Moving sunrise background: the sun rises when a page opens, and at every question it dips below the edge and climbs back up over the 20 seconds, like a second timer. The rays brighten as it rises and slowly turn. Phones keep it softer and stop it if the phone asks for reduced motion. Tune it with `--ray`, `--sun-y` and `--turn` in `quiz.css` (phones) and `host.css` (projector)
- Questions can have 2 options (True/False shows two big tiles) as well as 4
- Timer ring pulses for the last 5 seconds, the correct tile gets a tick, the podium blocks rise

## Files

| File | What it is |
| --- | --- |
| `index.html`, `player.js` | Player page (phones) |
| `host.html`, `host.js`, `host.css` | Host page (projector) |
| `quiz.css`, `common.js` | Shared theme and helpers. Team names are in `common.js` |
| `preview.html` | Static mock-ups of every screen, for checking the theme |
| `config.js` | Supabase URL and anon key |
| `sw.js` | Lets the host page reload offline for card mode |
| `supabase.sql` | Tables, security and functions (no questions). Creates game `TNB` |
| `questions.local.sql` | The 15 questions and answers. Git-ignored, so it never reaches GitHub. Keep a private copy. |
| `loadtest/` | 100-player load test (Node) |

## 1. Create the Supabase project

1. Sign in at https://supabase.com and create a **new** project on the Free plan (do not reuse the Arc PH one: running `supabase.sql` there would wipe it). Pick the region closest to Nigeria (for example West EU, London).
2. Wait for it to finish setting up.

## 2. Run the SQL

1. Open **SQL Editor**, start a new query, paste all of `supabase.sql` and click **Run**. It creates the tables, row level security, the functions and the game `TNB`, and adds the `games` table to realtime.
2. Start another new query, paste all of `questions.local.sql` and click **Run**. It loads the 15 questions and answers and should print `questions_loaded: 15`.

`questions.local.sql` is listed in `quiz/.gitignore`, so git never picks it up and GitHub Pages never serves it. It only exists on your computer, so keep a private copy (for example in a private Google Drive folder).

Running `supabase.sql` again wipes the game (players, answers, questions and the PIN), so run `questions.local.sql` and set the PIN again afterwards. Do that before the event, never during. Running `questions.local.sql` again on its own is safe: it only replaces the questions.

If you forget the questions file, the host page says "No questions loaded" and the quiz will not start.

## 3. Set the host PIN

In a **new** query, run this once with your own PIN (at least 6 characters, letters and numbers are best):

```sql
select public.set_host_pin('TNB', 'your-pin-here');
```

Do not save that query or put the PIN in any file. The database only stores a bcrypt hash. Ten wrong PINs in a row lock host actions for 60 seconds.

## 4. Add the URL and key to `config.js`

Also set `PLAYER_URL` to the public address of `index.html` (the QR code points there).

In Supabase open **Project Settings > API** (or **API Keys**) and copy:

- the **Project URL** into `SUPABASE_URL`
- the **anon public** key (or the **publishable** key) into `SUPABASE_ANON_KEY`

Never use the `service_role` or **secret** key anywhere in this repo.

## 5. Add the logo

Save the logo as `tnb-logo.png` in this `quiz/` folder. Until it is there, the pages show a text wordmark.

Commit and push to `main`. GitHub Pages serves the pages a minute later.

## 6. On the day

1. On the host laptop, open the host page in Chrome **while online**, at least once before the quiz. This caches the questions and the page for card mode.
2. Enter the PIN. Press **Full screen**.
3. The lobby shows the QR code and how many players joined each team. Click **Players** to remove someone (click their name twice).
4. Run the quiz with the keyboard:

| Key | What it does |
| --- | --- |
| Space or Enter (or a clicker's next button) | Next step: Start, Reveal, Leaderboard, Next question, Final results, Top players |
| Left arrow (or a clicker's back button) | Back |

Buttons at the bottom of the screen (they brighten when the mouse is over them): Back, Pause, the next step, End quiz, Reset game, Players, Card mode, Sound, Full screen. Plug the laptop into the room speakers for the sounds. End quiz and Reset game need two clicks.

How a question runs: 20 seconds on the ring timer, "Answers in: 63 / 88" below it. It reveals by itself one second after time runs out, or when you press Space. Back during an open question cancels it (and deletes its answers, after a second press). A reveal cannot be undone.

If the host page reloads, it picks up where the game is in the database.

### Card mode (if the internet fails)

Tick **Card mode**. Phone answers turn off. Teams hold up A, B, C or D cards. After you reveal, click each team that held up the right card for 100 points. Card points are added to the team's average.

Card mode keeps working with no internet at all: it runs from the questions cached in step 1, and if you reload the page offline it continues where you were. When the internet comes back, the host page sends its position and card points to Supabase, and phones catch up. Turn card mode off once you are back online to let phones answer again.

## 7. Rehearsal with 10 phones

Do this a day or two before the event, on the real Supabase project and the real GitHub Pages URL, with the laptop and projector you will use. Hand out 10 phones (a mix of Android and iPhone, some on mobile data, some on wifi) and cover several teams.

Phone mode:

1. Host page on the projector, PIN entered, full screen. Everyone scans the QR code from the back of the room.
2. Join with a few edge cases: two people with the same name (the leaderboard should show "Ada (2)"), a 20-character name, and one rude name (it should be refused).
3. In the lobby, remove one player with **Players** (two clicks). Their phone should ask them to join again.
4. Start. Check every phone shows the question, the four buttons and the countdown within a second or two of the projector.
5. During questions: one phone answers instantly (close to 1000 points), one at about 10 seconds (about 750), one answers wrong, one does not answer.
6. One phone reloads the page mid-question: it should come back to the same question with its answer still locked.
7. One phone turns on airplane mode for 10 seconds: it should show "Reconnecting...", then catch up when it comes back.
8. One new phone joins at question 3: it should start on the current question with 0 points.
9. Press **Pause**, check the phones show "Paused", then resume.
10. Let one question run out (it reveals by itself) and reveal another early with Space.
11. Check each reveal: right answer highlighted, answer bars, explanation, team scores. Then the leaderboard.

Card mode (the backup):

12. Tick **Card mode** in the middle of a question. Phones should say "Card round. Hold up your team's card." and stop taking answers.
13. Turn the laptop's wifi off. Reveal, click the teams that held up the right card, go to the leaderboard and on to the next question. The chip should say Offline.
14. Still offline, reload the host page. It should come back to the same card round. (This needs the host page to have been opened online earlier, see step 1 of "On the day". Do it in Chrome, which keeps an offline copy of the page.)
15. Turn wifi back on. Within a few seconds the chip says Live and the phones jump to the same question. Untick **Card mode**: phones can answer again.

Finish:

16. **End quiz** (two clicks). Check the team podium, then Space for the top 5 players. Each phone shows its total, its rank and its team's rank.
17. **Reset game** (two clicks). The lobby should show 0 players.

Note anything that looked wrong, with the phone model and the question number.

## 8. Reset after the event (or after a rehearsal)

Press **Reset game** twice. This deletes all players, answers and card points and goes back to the lobby. The questions and PIN stay.

## Scoring

- Correct: `500 + round(500 * (1 - seconds / 20))`, so 1000 for an instant answer and at least 500. Wrong or no answer: 0.
- Time is measured with the database clock, not the phone's.
- One answer per player per question. Answers after 21 seconds (20 plus 1 second grace) or after the reveal are rejected.
- Team score = average of the members' totals (players who never answered count as 0) + 100 per card-mode award. Ties go to the team with more correct answers.

## How the answers stay secret

- `questions` has row level security and no grants for the browser roles, so the correct index cannot be read.
- Phones read only the `games` row, which has no correct index until the host reveals.
- `submit_answer` scores on the server and returns only `{"ok": true}`.
- Results come from `player_sync`, which only returns a result once the question is revealed.

- The questions and answers are only in `questions.local.sql`, which is git-ignored, so they are not in this public repo or on GitHub Pages.

## Load test

Run it before the event, never during. It deletes all players and answers in the game.

```bash
cd quiz/loadtest
npm install
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=your-anon-key HOST_PIN=your-pin node loadtest.mjs --yes
```

On Windows PowerShell set the variables first with `$env:SUPABASE_URL="..."` and so on.

It joins 100 simulated players, each with its own realtime connection, runs all the questions with answers at random times inside the 20 seconds, and reports joins, realtime subscriptions, accepted and rejected answers, realtime events received and dropped, event latency, answer leaks and score mismatches. It takes about 7 minutes. Add `--fast` to reveal as soon as everyone has answered.

## Free plan limits

Supabase Free allows 200 concurrent realtime connections and 100 realtime messages per second (https://supabase.com/docs/guides/realtime/limits). Each phone opens one channel and listens to one row. Each host step sends one update, which fans out to about 100 phones once. Countdowns run on the phones. Phones also check in every 15 seconds (every 3 seconds while realtime is down), so a missed message is caught up quickly.
