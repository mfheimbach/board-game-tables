# Game Tables

Seats exactly the people who are here at up to N tables, so everyone plays a game they rated highly.
It runs entirely in the browser (C++ core compiled to WebAssembly), so it works on a phone and needs no server.

## How it works
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

## Config
Edit `web/config.json` to change:
- sheet id, tab, header row
- column names: game, BGG id/link, explainer, owner (`*Bringbär`)
- optional manual player-count columns, which take precedence over BGG data

Player columns are detected automatically: any column whose cells are only 0/1/2/blank.
Columns starting with `*` are ignored.

## Local development
```
./build.sh                         # needs Emscripten; rebuilds web/tables.js
cd web && python3 -m http.server   # open http://localhost:8000
g++ -O2 -std=c++17 core/test_native.cpp && ./a.out   # brute-force check of the core
BGG_TOKEN=... node scripts/fetch_data.mjs            # refresh data by hand
```

The core is header-only, so an Rcpp wrapper for the Shiny app is a thin file around `tables::solve()`.
