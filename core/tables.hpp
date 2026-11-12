// Board game table optimizer — core search (header-only, no dependencies).
//
// Problem: seat EXACTLY the attendees at <= maxTables tables, each table one game,
// no game twice, maximizing the sum of ratings (ties: fewer guessed/blank ratings).
// Method: exact cover by depth-first search. Branch on the lowest unseated player,
// so every seating is generated exactly once; bound with "every remaining person gets
// their best possible seat" against the worst result we would still keep.
// Memory: candidate tables + one search path + the kept results.
#pragma once
#include <algorithm>
#include <chrono>
#include <climits>
#include <cmath>
#include <cstdint>
#include <set>
#include <unordered_map>
#include <vector>

namespace tables {

using Mask = uint64_t;  // one bit per player, up to 64 players
constexpr int MAX_TABLES = 8;

// A game set as one number: 12 bits per game (up to 4095 games), up to 10 games.
using SetKey = unsigned __int128;
struct SetKeyHash {
  size_t operator()(SetKey k) const {
    uint64_t x = (uint64_t)k ^ ((uint64_t)(k >> 64) * 0x9E3779B97F4A7C15ULL);
    x ^= x >> 31; x *= 0xBF58476D1CE4E5B9ULL; x ^= x >> 29;
    return (size_t)x;
  }
};

struct Game {
  uint32_t counts = 0;         // bit k set => a table of k players is allowed
  Mask explainers = 0;         // players who can explain the game
  Mask banned = 0;             // players who must never sit at it (beats everything)
  Mask known = 0;              // players who have played it (no teach if a table is all known)
  std::vector<uint16_t> durNew, durKnown;  // minutes by table size k (index k), 0 = unknown
  std::vector<int8_t> rating;  // per player: 0, 1, 2, or -1 = blank
  std::vector<int16_t> value;  // per player: points used for ranking (64 = one rating step); empty = 64 x rating
};

struct Frozen {   // "this game must be played" (+ optionally by these players)
  int game;
  Mask req;       // players that must sit at it
  bool exact;     // exactly these players (a locked table)
};

struct Options {
  int maxTables = 4;          // 1..MAX_TABLES
  int minRating = 1;          // lowest rating that still gets you seated
  int minPerTable = 2;
  bool blankAsZero = false;   // blank rating counts as 0 (else as 1, flagged as a guess)
  bool needExplainer = true;  // someone who can explain must sit at the table
  int keepCombos = 30;        // distinct game sets to return
  int keepSeatings = 1;       // seatings kept per game set
  bool alternates = false;    // all leaves share one game set: rank seatings
  int maxGap = 0;             // >0: all tables end within this many minutes of each other
  int minDur = 0, maxDur = 0; // >0: only tables estimated to last at least / at most this long (unknown passes)
  long long nodeCap = 200000000;
  int timeBudgetMs = 0;        // >0: stop after this long and return the best found
  std::vector<int> fairW;      // per player 0..100: weight of their "yes" in the fairness tie-break
};

struct Table {
  int game;
  Mask mask;
  int score;    // sum of (effective) ratings
  int guesses;  // seats whose rating was blank
  int dur;      // estimated minutes, 0 = unknown
  int val;      // ranking points (sum of values)
  int fair;     // fairness points: weights of seated players who rated it "yes"
  long long key() const { return (long long)val * 128 - guesses; }
};

struct Seating { long long key; std::vector<int> t; };       // t: indices into cands
struct Combo { long long best; long long found; std::vector<Seating> seatings; };

struct Result {
  std::vector<Table> cands;
  std::vector<Combo> combos;  // best first
  std::vector<int> blockedFrozen;  // frozen entries with no possible table
  long long seatings = 0, nodes = 0;
  bool truncated = false;
};

class Solver {
 public:
  Solver(const std::vector<Game>& games, int nPlayers, Mask attendees,
         const std::vector<int>& excluded, const std::vector<Frozen>& frozen,
         const Options& opt)
      : G(games), nP(nPlayers), att(attendees), fz(frozen), o(opt) {
    o.maxTables = std::max(1, std::min(o.maxTables, MAX_TABLES));
    std::vector<char> skip(G.size(), 0);
    for (int e : excluded) if (e >= 0 && e < (int)G.size()) skip[e] = 1;
    for (auto& f : fz) if (f.game >= 0 && f.game < (int)G.size()) skip[f.game] = 1;

    fcands.resize(fz.size());
    for (size_t i = 0; i < fz.size(); ++i) {
      addCandidates(fz[i].game, fz[i].req & att, fz[i].exact, fcands[i]);
      // Forced players win over the rules: if they make the game impossible
      // (no explainer among them and no room for one, too many for the box),
      // relax explainer + player count for this table.
      if (fcands[i].empty() && (fz[i].req & att) && !fz[i].exact)
        addCandidates(fz[i].game, fz[i].req & att, false, fcands[i], true);
      sortByKey(fcands[i]);
      if (fcands[i].empty()) res.blockedFrozen.push_back((int)i);
    }
    std::vector<int> free;
    for (int g = 0; g < (int)G.size(); ++g) if (!skip[g]) addCandidates(g, 0, false, free, false, true);   // pinned games ignore the time filter
    byLow.assign(64, {});
    for (int t : free) byLow[__builtin_ctzll(res.cands[t].mask)].push_back(t);
    for (auto& v : byLow) sortByKey(v);
    chosen.assign(o.maxTables, 0);
    // bound: each unseated person gets at most their best seat among the free tables
    best.assign(64, 0);
    for (int t : free) {
      const Table& T = res.cands[t];
      const Game& gm = G[T.game];
      for (Mask m = T.mask; m; m &= m - 1) {
        int p = __builtin_ctzll(m), r = p < (int)gm.rating.size() ? gm.rating[p] : -1;
        int eff = r < 0 ? (o.blankAsZero ? 0 : 1) : r;
        best[p] = std::max<long long>(best[p], valueOf(gm, p, eff));
      }
    }
    for (int w : o.fairW) fmax = std::max<long long>(fmax, w);
  }

  Result run() {
    deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(o.timeBudgetMs);
    if (res.blockedFrozen.empty() && att != 0 && (int)fz.size() <= o.maxTables)
      recFrozen(0, att, 0, 0, 0, INT_MAX, 0);
    std::vector<std::pair<long long, SetKey>> ord(order.rbegin(), order.rend());
    for (auto& kv : ord) {
      Combo c = combos[kv.second];
      std::sort(c.seatings.begin(), c.seatings.end(),
                [](const Seating& a, const Seating& b) { return a.key > b.key; });
      res.combos.push_back(std::move(c));
    }
    return std::move(res);
  }

 private:
  const std::vector<Game>& G;
  int nP;
  Mask att;
  std::vector<Frozen> fz;
  Options o;
  Result res;
  std::vector<std::vector<int>> fcands, byLow;
  std::vector<int> chosen;
  std::chrono::steady_clock::time_point deadline;
  std::vector<long long> best;      // best possible points per person among free tables (for the bound)
  long long fmax = 0;               // best possible fairness per remaining seat
  std::unordered_map<SetKey, Combo, SetKeyHash> combos;
  std::set<std::pair<long long, SetKey>> order;  // (best key, game-set key)

  void sortByKey(std::vector<int>& v) {
    std::stable_sort(v.begin(), v.end(), [&](int a, int b) {
      return res.cands[a].key() > res.cands[b].key();
    });
  }

  // All tables for game g among attendees. Players in `req` are always eligible
  // (someone deliberately put them there); `exact` = only the table `req` itself;
  // `relaxed` = forced team that broke the rules: any size >= team, no explainer needed.
  void addCandidates(int g, Mask req, bool exact, std::vector<int>& out, bool relaxed = false, bool timed = false) {
    const Game& gm = G[g];
    auto rate = [&](int p, int& eff, bool& guess) {
      int r = p < (int)gm.rating.size() ? gm.rating[p] : -1;
      guess = r < 0;
      eff = guess ? (o.blankAsZero ? 0 : 1) : r;
    };
    if (exact) {
      if (!req) return;
      Table t{g, req, 0, 0, durOf(gm, req), 0, 0};
      for (int p = 0; p < nP; ++p) if (req >> p & 1) {
        int eff; bool guess; rate(p, eff, guess);
        t.score += eff; t.guesses += guess; t.val += valueOf(gm, p, eff); t.fair += fairOf(p, eff);
      }
      out.push_back((int)res.cands.size());
      res.cands.push_back(t);
      return;
    }
    std::vector<int> el, effs, gs, vs, fs;
    for (int p = 0; p < nP; ++p) {
      if (!(att >> p & 1)) continue;
      int eff; bool guess; rate(p, eff, guess);
      if (!(req >> p & 1) && (gm.banned >> p & 1)) continue;
      if ((req >> p & 1) || eff >= o.minRating) {
        el.push_back(p); effs.push_back(eff); gs.push_back(guess); vs.push_back(valueOf(gm, p, eff)); fs.push_back(fairOf(p, eff));
      }
    }
    int n = (int)el.size(), team = __builtin_popcountll(req);
    uint32_t counts = gm.counts;
    if (relaxed) counts |= ~0u << std::min(team, 31);
    for (int k = std::max(relaxed ? team : o.minPerTable, 1); k <= std::min(n, 31); ++k) {
      if (!(counts >> k & 1)) continue;
      std::vector<int> c(k);
      for (int i = 0; i < k; ++i) c[i] = i;
      while (true) {
        Mask m = 0; int sc = 0, gu = 0, va = 0, fa = 0;
        for (int i = 0; i < k; ++i) { int e = c[i]; m |= Mask(1) << el[e]; sc += effs[e]; gu += gs[e]; va += vs[e]; fa += fs[e]; }
        if ((m & req) == req && (relaxed || !o.needExplainer || (m & gm.explainers))) {
          int d = durOf(gm, m);
          bool fits = !timed || d <= 0 || ((!o.minDur || d >= o.minDur) && (!o.maxDur || d <= o.maxDur));
          if (fits) { out.push_back((int)res.cands.size()); res.cands.push_back({g, m, sc, gu, d, va, fa}); }
        }
        int i = k - 1;
        while (i >= 0 && c[i] == n - k + i) --i;
        if (i < 0) break;
        ++c[i];
        for (int j = i + 1; j < k; ++j) c[j] = c[j - 1] + 1;
      }
    }
  }

  int valueOf(const Game& gm, int p, int eff) const {
    return p < (int)gm.value.size() ? gm.value[p] : 64 * eff;
  }
  int fairOf(int p, int eff) const {
    return eff == 2 && p < (int)o.fairW.size() ? o.fairW[p] : 0;
  }

  static int durOf(const Game& gm, Mask m) {
    size_t k = (size_t)__builtin_popcountll(m);
    const auto& v = (m & ~gm.known) == 0 ? gm.durKnown : gm.durNew;
    return k < v.size() ? v[k] : 0;
  }

  // Ranking key: score first, then fewer guesses, then tables ending close together
  // (log of longest/shortest). Scaled by 1024 so the spread never outweighs a guess.
  static long long spreadPen(int dmin, int dmax) {
    if (dmax > 0 && dmin < INT_MAX && dmin < dmax)
      return std::min(1023LL, (long long)std::lround(std::log((double)dmax / dmin) * 400.0));
    return 0;
  }
  // Ranking key, most significant first: points, fewer guesses, fairness to picky
  // players, tables ending close together.  base = val*128 - guesses.
  static constexpr long long G_UNIT = 1LL << 24;   // > max fairness (100 x 64) x 1024
  static long long leafKey(long long base, int fair, int dmin, int dmax) {
    return base * G_UNIT + (long long)fair * 1024 - spreadPen(dmin, dmax);
  }
  bool outOfTime() {
    if (!o.timeBudgetMs || (res.nodes & 4095)) return false;
    return std::chrono::steady_clock::now() > deadline;
  }
  bool tooSpread(int dmin, int dmax) const {
    return o.maxGap > 0 && dmax > 0 && dmin < INT_MAX && dmax - dmin > o.maxGap;
  }
  static void widen(int d, int& dmin, int& dmax) {
    if (d > 0) { dmin = std::min(dmin, d); dmax = std::max(dmax, d); }
  }

  long long threshold() const {
    if (!o.alternates)
      return (int)combos.size() >= o.keepCombos ? order.begin()->first : LLONG_MIN;
    if (combos.empty()) return LLONG_MIN;
    const Combo& c = combos.begin()->second;
    if ((int)c.seatings.size() < o.keepSeatings) return LLONG_MIN;
    long long w = LLONG_MAX;
    for (auto& s : c.seatings) w = std::min(w, s.key);
    return w;
  }

  SetKey gameKey(int depth) const {
    int g[MAX_TABLES];
    for (int d = 0; d < depth; ++d) g[d] = res.cands[chosen[d]].game;
    std::sort(g, g + depth);
    SetKey k = 0;
    for (int d = 0; d < depth; ++d) k = (k << 12) | (SetKey)(g[d] + 1);
    return k;
  }

  void keepSeating(Combo& c, long long key, int depth) {
    if ((int)c.seatings.size() < o.keepSeatings) {
      c.seatings.push_back({key, std::vector<int>(chosen.begin(), chosen.begin() + depth)});
      return;
    }
    auto w = std::min_element(c.seatings.begin(), c.seatings.end(),
                              [](const Seating& a, const Seating& b) { return a.key < b.key; });
    if (key > w->key) *w = {key, std::vector<int>(chosen.begin(), chosen.begin() + depth)};
  }

  void leaf(int depth, long long key) {
    ++res.seatings;
    SetKey gk = gameKey(depth);
    auto it = combos.find(gk);
    if (it != combos.end()) {
      Combo& c = it->second;
      ++c.found;
      keepSeating(c, key, depth);
      if (key > c.best) { order.erase({c.best, gk}); c.best = key; order.insert({key, gk}); }
      return;
    }
    if ((int)combos.size() >= o.keepCombos) {
      auto w = order.begin();
      if (key <= w->first) return;
      combos.erase(w->second);
      order.erase(w);
    }
    Combo c{key, 1, {}};
    keepSeating(c, key, depth);
    combos.emplace(gk, std::move(c));
    order.insert({key, gk});
  }

  void recFrozen(size_t fi, Mask rem, int depth, long long key, int fair, int dmin, int dmax) {
    if (fi == fz.size()) { rec(rem, depth, key, fair, dmin, dmax); return; }
    for (int t : fcands[fi]) {
      const Table& T = res.cands[t];
      if (T.mask & ~rem) continue;
      int lo = dmin, hi = dmax;
      widen(T.dur, lo, hi);
      if (tooSpread(lo, hi)) continue;
      chosen[depth] = t;
      recFrozen(fi + 1, rem ^ T.mask, depth + 1, key + T.key(), fair + T.fair, lo, hi);
      if (res.truncated) return;
    }
  }

  void rec(Mask rem, int depth, long long key, int fair, int dmin, int dmax) {
    if (++res.nodes > o.nodeCap || outOfTime()) { res.truncated = true; return; }
    if (!rem) { leaf(depth, leafKey(key, fair, dmin, dmax)); return; }
    if (depth == o.maxTables) return;
    // upper bound: everyone left gets their best possible seat, spread can only grow
    long long r = __builtin_popcountll(rem), vb = 0;
    for (Mask m = rem; m; m &= m - 1) vb += best[__builtin_ctzll(m)];
    if ((key + 128LL * vb) * G_UNIT + (fair + fmax * r) * 1024 - spreadPen(dmin, dmax) <= threshold()) return;
    for (int t : byLow[__builtin_ctzll(rem)]) {
      const Table& T = res.cands[t];
      if (T.mask & ~rem) continue;
      bool dup = false;
      for (int d = 0; d < depth; ++d)
        if (res.cands[chosen[d]].game == T.game) { dup = true; break; }
      if (dup) continue;
      int lo = dmin, hi = dmax;
      widen(T.dur, lo, hi);
      if (tooSpread(lo, hi)) continue;
      chosen[depth] = t;
      rec(rem ^ T.mask, depth + 1, key + T.key(), fair + T.fair, lo, hi);
      if (res.truncated) return;
    }
  }
};

inline Result solve(const std::vector<Game>& games, int nPlayers, Mask attendees,
                    const std::vector<int>& excluded, const std::vector<Frozen>& frozen,
                    const Options& opt) {
  return Solver(games, nPlayers, attendees, excluded, frozen, opt).run();
}

}  // namespace tables
