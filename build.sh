#!/usr/bin/env bash
# Builds web/tables.js (WASM embedded) from the C++ core. Needs Emscripten (em++).
set -euo pipefail
cd "$(dirname "$0")"
em++ -O3 -std=c++17 core/wasm_api.cpp -o web/tables.js \
  -sMODULARIZE=1 -sEXPORT_NAME=createTables -sSINGLE_FILE=1 \
  -sALLOW_MEMORY_GROWTH=1 -sENVIRONMENT=web,worker,node \
  -sEXPORTED_FUNCTIONS=_solve_buf -sEXPORTED_RUNTIME_METHODS=ccall
echo "built web/tables.js ($(wc -c < web/tables.js) bytes)"
