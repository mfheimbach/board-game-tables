# Game Tables

Seats exactly the people who are here at up to N tables, so everyone plays a game they rated highly.
It runs entirely in the browser (C++ core compiled to WebAssembly), so it works on a phone and needs no server.

## How it works
For players: the in-app page **How it works** (`web/help.html`, linked in the footer and settings) explains every rule in plain words.

- **Ratings** load live from the Google Sheet when the page opens. If Google can't be reached, it uses the copy in `web/data/sheet.csv`.
- **Player counts, play time and weight** come from BoardGameGeek. A GitHub Action fetches them with your BGG token, so the token never reaches a browser, and saves them to `web/data/bgg.json`.
- **Search** (`core/tables.hpp`): exact cover by depth-first search over bitmasks. It branches on the lowest unseated player, keeps the 30 best game combinations, and prunes when a branch can't beat the 30th. Typical run: a few milliseconds.

## Setup (once)
1. Push this folder to a GitHub repo, then go to **Settings → Pages → Source: GitHub Actions**.
   - Pages is free for public repos. Note that a public repo also shows the sheet snapshot (names and ratings).
2. Register a BGG application at <https://boardgamegeek.com/using_the_xml_api>, then create a token.
3. Add the token as a repo secret: **Settings → Secrets and variables → Actions → New secret**, name `BGG_TOKEN`.
4. Run **Actions → Update game data → Run workflow**.
   - It also runs daily, so games newly added to the sheet get player counts.
   - It redeploys the page afterwards.
5. Download a "Powered by BGG" logo from BGG's logo page (linked from their XML API terms). Save it as `web/img/powered-by-bgg.svg`; until then a text badge is shown.
   - BGG's terms require the logo, linked to boardgamegeek.com, and naming BGG as the data source.
   - The footer already does both.

## Time estimate
`web/time.js`. Assumes newcomers at every table unless everyone seated has played the game:
- box(n): a BGG time range maps its minimum to the fewest legal players and its maximum to the most; a single number counts as the time at max players, 40% fixed / 60% per player.
- with newcomers: `teach(w) + box(n)·(1 + 0.08·w)`, with `teach(w) = max(10, 10 + 25·(w − 2))` min, w = BGG weight
- everyone knows it: `1.1·box(n)`
- Shown as log-ish bins (¾ h, 1 h, 1½ h, 2 h, 3 h, 4 h, 5 h+); exact minutes via settings.
- Who knows a game: explainers, the optional `*Kennen` column, and per device in the game sheet.
- Time slot (main screen ⏱): only tables whose estimate is at least / at most a given length; a limit includes its whole bin. Pinned games are exempt.
- Ranking: score, then fewer guesses, then smallest log(longest/shortest table) — scale-free, driven by the straggler. Optional filter (slider): all tables finish within ½ h / 1 h / 2 h of each other.

## Weekend planner (organizers)
Settings → "Plan the whole weekend". Plans all rounds at once as an integer program (`web/plan.js`, solved in the browser by [HiGHS](https://highs.dev) via `web/vendor/highs`, MIT, loaded only on that page):
- Who's there when: a person × round grid. People not selected on the main screen start as away.
- Rules: everyone present sits once per round, one copy per game (one table per game per round), nobody plays a game twice, allowed player counts, tables per round, explainer and owner rules per round, left-out games and ✕ picks.
- Order: 1) the worst-off person's average rating per round they're there (switchable), 2) most points = fewest 1s (seats are fixed), 3) fewest guesses, 4) fewest different games = the bring list.
- Phase 1 maximizes the worst-off average; phase 2 keeps everyone at that level and optimizes the rest. Identical consecutive rounds are put in a fixed order to remove equivalent plans. Each phase stops after 30 s; the result says if it's proven best.
- "How essential is each game?": plans again without each game and reports what's lost (worst-off, 1s, extra games).

## Cater to picky players (optional)
Settings switch. Each person's ratings are standardized (z-score, rescaled to the group's mean and spread, like a T-score) and blended 50/50 with the raw rating for ranking only, so a "yes" from someone who rarely says yes counts a bit more. Displayed percentages stay plain ratings.

## Config
`web/config.json` holds only what the sheet can't tell us:
- `sheetId`
- `columns`: the sheet's header names for game, BGG id/link, explainer, owner (`*Bringbär`), and the optional manual columns (player counts, `*Kennen`, `min.time`, `max.time`, `weight`)

Everything else comes from the sheet itself (via the daily action):
- title: the spreadsheet's name
- tabs: every tab that has the game and BGG id columns (others, like a scheduling tab, are skipped)
- header row: detected
- players: every column holding only ratings (0/1/2/blank), including people who haven't rated yet. Columns starting with `*` are ignored.

After restructuring the sheet, run **Actions → Update game data** to pick up the change right away.

## Local development
```
./build.sh                         # needs Emscripten; rebuilds web/tables.js
cd web && python3 -m http.server   # open http://localhost:8000
g++ -O2 -std=c++17 core/test_native.cpp && ./a.out   # brute-force check of the core
BGG_TOKEN=... node scripts/fetch_data.mjs            # refresh data by hand
```

The core is header-only, so an Rcpp wrapper for the Shiny app is a thin file around `tables::solve()`.
