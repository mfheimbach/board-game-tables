// Flat int32 interface for WebAssembly (and anything else with a C ABI).
//
// Input layout (int32):
//   nPlayers, nGames, maxTables, minRating, blankAsZero, needExplainer,
//   minPerTable, keepCombos, keepSeatings, alternates, nodeCapMillions,
//   nAttendees, attendee...,
//   per game: countMask, nExplainers, explainer..., rating[nPlayers] (-1 = blank),
//   nExcluded, excludedGame...,
//   nFrozen, per frozen: game, exact, nReq, reqPlayer...
// Output: JSON string, see bottom.
#include "tables.hpp"
#include <string>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

using namespace tables;

static std::string out;

static void maskJson(std::string& s, Mask m) {
  s += '[';
  bool first = true;
  for (int p = 0; p < 64; ++p)
    if (m >> p & 1) { if (!first) s += ','; s += std::to_string(p); first = false; }
  s += ']';
}

extern "C" EXPORT const char* solve_buf(const int32_t* b, int len) {
  int i = 0;
  auto next = [&]() -> int { return i < len ? b[i++] : 0; };
  int nP = next(), nG = next();
  Options o;
  o.maxTables = next(); o.minRating = next(); o.blankAsZero = next();
  o.needExplainer = next(); o.minPerTable = next(); o.keepCombos = next();
  o.keepSeatings = next(); o.alternates = next(); o.nodeCap = (long long)next() * 1000000LL;
  if (nP > 64) nP = 64;

  Mask att = 0;
  for (int n = next(); n > 0; --n) att |= Mask(1) << next();
  std::vector<Game> games(nG);
  for (auto& g : games) {
    g.counts = (uint32_t)next();
    for (int n = next(); n > 0; --n) g.explainers |= Mask(1) << next();
    g.rating.resize(nP);
    for (int p = 0; p < nP; ++p) g.rating[p] = (int8_t)next();
  }
  std::vector<int> excl;
  for (int n = next(); n > 0; --n) excl.push_back(next());
  std::vector<Frozen> fz;
  for (int n = next(); n > 0; --n) {
    Frozen f{next(), 0, next() != 0};
    for (int r = next(); r > 0; --r) f.req |= Mask(1) << next();
    fz.push_back(f);
  }

  Result r = solve(games, nP, att, excl, fz, o);

  // {"nCand":..,"seatings":..,"nodes":..,"truncated":bool,"blocked":[frozen idx],
  //  "combos":[{"found":n,"seatings":[{"score":s,"guesses":q,
  //     "tables":[{"g":game,"p":[players],"s":score,"q":guesses}]}]}]}
  out.clear();
  out += "{\"nCand\":" + std::to_string(r.cands.size());
  out += ",\"seatings\":" + std::to_string(r.seatings);
  out += ",\"nodes\":" + std::to_string(r.nodes);
  out += std::string(",\"truncated\":") + (r.truncated ? "true" : "false");
  out += ",\"blocked\":[";
  for (size_t k = 0; k < r.blockedFrozen.size(); ++k)
    out += (k ? "," : "") + std::to_string(r.blockedFrozen[k]);
  out += "],\"combos\":[";
  for (size_t c = 0; c < r.combos.size(); ++c) {
    const Combo& cb = r.combos[c];
    out += (c ? ",{" : "{");
    out += "\"found\":" + std::to_string(cb.found) + ",\"seatings\":[";
    for (size_t s = 0; s < cb.seatings.size(); ++s) {
      const Seating& st = cb.seatings[s];
      int score = 0, guesses = 0;
      for (int t : st.t) { score += r.cands[t].score; guesses += r.cands[t].guesses; }
      out += (s ? ",{" : "{");
      out += "\"score\":" + std::to_string(score) + ",\"guesses\":" + std::to_string(guesses) + ",\"tables\":[";
      for (size_t k = 0; k < st.t.size(); ++k) {
        const Table& T = r.cands[st.t[k]];
        out += (k ? ",{" : "{");
        out += "\"g\":" + std::to_string(T.game) + ",\"p\":";
        maskJson(out, T.mask);
        out += ",\"s\":" + std::to_string(T.score) + ",\"q\":" + std::to_string(T.guesses) + "}";
      }
      out += "]}";
    }
    out += "]}";
  }
  out += "]}";
  return out.c_str();
}
