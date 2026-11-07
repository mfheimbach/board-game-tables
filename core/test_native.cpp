// Randomized check of the solver against brute force.  g++ -O2 -std=c++17 test_native.cpp
#include "tables.hpp"
#include <cstdio>
#include <functional>
#include <map>
#include <climits>
#include <cmath>
#include <random>
using namespace tables;

struct BT { int g; Mask m; long long key; int dur; };

int main() {
  std::mt19937 rng(42);
  int fails = 0, runs = 0;
  for (int it = 0; it < 4000; ++it) {
    int nP = 3 + rng() % 7, nG = 1 + rng() % 7;
    Options o;
    o.maxTables = 1 + rng() % 8; o.minRating = rng() % 3; o.blankAsZero = rng() % 2;
    o.needExplainer = rng() % 2; o.minPerTable = 1 + rng() % 2;
    if (rng() % 3 == 0) o.maxGap = 15 + rng() % 200;
    std::vector<Game> G(nG);
    for (auto& g : G) {
      g.counts = 0;
      for (int k = 1; k <= 6; ++k) if (rng() % 2) g.counts |= 1u << k;
      g.explainers = rng() & ((1u << nP) - 1);
      if (rng() % 2) g.banned = rng() & rng() & ((1u << nP) - 1);
      if (rng() % 2) g.known = rng() & ((1u << nP) - 1);
      int nd = rng() % 4 == 0 ? 0 : 3 + rng() % 8;   // sometimes no data, sometimes short vector
      for (int k = 0; k < nd; ++k) {
        g.durNew.push_back(rng() % 5 == 0 ? 0 : 30 + rng() % 300);
        g.durKnown.push_back(rng() % 5 == 0 ? 0 : 20 + rng() % 200);
      }
      g.rating.resize(nP);
      for (auto& r : g.rating) r = (int8_t)((int)(rng() % 4) - 1);
    }
    Mask att = rng() & ((1u << nP) - 1);
    if (!att) att = 1;
    std::vector<int> excl;
    if (rng() % 3 == 0) excl.push_back(rng() % nG);
    std::vector<Frozen> fz;
    if (rng() % 3 == 0) {
      int g = rng() % nG;
      bool exact = rng() % 2;
      Mask req = att & (Mask)(rng() & ((1u << nP) - 1));
      if (exact && !req) exact = false;
      fz.push_back({g, req, exact});
    }

    // brute-force candidates
    std::vector<BT> cand;
    auto gen = [&](int g, const Frozen* f, bool relaxed) {
      size_t before = cand.size();
      int team = f ? __builtin_popcountll(f->req) : 0;
      for (Mask m = att; m; m = (m - 1) & att) {
        int k = __builtin_popcountll(m);
        long long sc = 0, gu = 0; bool ok = true;
        for (int p = 0; p < nP; ++p) if (m >> p & 1) {
          int r = G[g].rating[p], eff = r < 0 ? (o.blankAsZero ? 0 : 1) : r;
          bool forced = f && (f->req >> p & 1);
          if (!forced && (eff < o.minRating || (G[g].banned >> p & 1))) ok = false;
          sc += eff; gu += r < 0;
        }
        if (f && f->exact) { if (m != f->req) continue; }
        else {
          if (!ok) continue;
          if (relaxed) { if (k < team) continue; }
          else {
            if (k < o.minPerTable || !(G[g].counts >> k & 1)) continue;
            if (o.needExplainer && !(m & G[g].explainers)) continue;
          }
          if (f && (m & f->req) != f->req) continue;
        }
        size_t kk = (size_t)k;
        const auto& dv = (m & ~G[g].known) == 0 ? G[g].durKnown : G[g].durNew;
        cand.push_back({g, m, sc * 128 - gu, kk < dv.size() ? (int)dv[kk] : 0});
      }
      return cand.size() > before;
    };
    for (int g = 0; g < nG; ++g) {
      bool isEx = std::find(excl.begin(), excl.end(), g) != excl.end();
      const Frozen* f = nullptr;
      for (auto& x : fz) if (x.game == g) f = &x;
      if (isEx && !f) continue;
      if (!gen(g, f, false) && f && !f->exact && (f->req & att)) gen(g, f, true);
    }
    // brute-force seatings
    std::map<std::vector<int>, long long> bestBySet;
    long long count = 0;
    std::vector<int> pick;
    std::function<void(size_t, Mask, long long)> go = [&](size_t s, Mask used, long long key) {
      if (used == att) {
        std::vector<int> gs; for (int t : pick) gs.push_back(cand[t].g);
        std::sort(gs.begin(), gs.end());
        for (auto& f : fz) if (!std::binary_search(gs.begin(), gs.end(), f.game)) return;
        int lo = INT_MAX, hi = 0;
        for (int t : pick) if (cand[t].dur > 0) { lo = std::min(lo, cand[t].dur); hi = std::max(hi, cand[t].dur); }
        if (o.maxGap > 0 && hi > 0 && lo < INT_MAX && hi - lo > o.maxGap) return;
        long long pen = (hi > 0 && lo < hi) ? std::min(1023LL, (long long)std::lround(std::log((double)hi / lo) * 400.0)) : 0;
        key = key * 1024 - pen;
        ++count;
        auto it = bestBySet.find(gs);
        if (it == bestBySet.end() || it->second < key) bestBySet[gs] = key;
        return;
      }
      if ((int)pick.size() == o.maxTables) return;
      for (size_t t = s; t < cand.size(); ++t) {
        if (cand[t].m & used) continue;
        bool dup = false; for (int q : pick) if (cand[q].g == cand[t].g) dup = true;
        if (dup) continue;
        pick.push_back(t); go(t + 1, used | cand[t].m, key + cand[t].key); pick.pop_back();
      }
    };
    go(0, 0, 0);
    std::vector<long long> bestKeys;
    for (auto& kv : bestBySet) bestKeys.push_back(kv.second);
    std::sort(bestKeys.rbegin(), bestKeys.rend());

    // solver: full enumeration (no pruning) must match the count exactly
    Options full = o; full.keepCombos = 1 << 30;
    Result rf = solve(G, nP, att, excl, fz, full);
    // solver with top-3 + bound must return the 3 best game sets' scores
    Options top = o; top.keepCombos = 3;
    Result rt = solve(G, nP, att, excl, fz, top);
    std::vector<long long> got;
    for (auto& c : rt.combos) got.push_back(c.best);
    std::vector<long long> want(bestKeys.begin(), bestKeys.begin() + std::min<size_t>(3, bestKeys.size()));
    ++runs;
    if (rf.seatings != count || (long long)rf.combos.size() != (long long)bestBySet.size() || got != want) {
      if (++fails <= 5)
        printf("FAIL it=%d count %lld vs %lld, sets %zu vs %zu, top %zu vs %zu\n", it,
               rf.seatings, count, rf.combos.size(), bestBySet.size(), got.size(), want.size());
    }
  }
  printf("%d/%d randomized cases match brute force\n", runs - fails, runs);
  return fails != 0;
}
