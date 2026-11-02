#!/usr/bin/env bash
# Сборка модуля Kilobuzz для Windows (x64) кросс-компилятором mingw-w64 — на macOS/Linux или в MSYS2.
#   brew install mingw-w64     (macOS)
set -euo pipefail
cd "$(dirname "$0")"
CXX=${CXX:-x86_64-w64-mingw32-g++}
OUT=../bin/win
mkdir -p "$OUT"
FLAGS=(-O2 -std=c++17 -static -static-libgcc -static-libstdc++ -DUNICODE -D_UNICODE)
"$CXX" "${FLAGS[@]}" -shared apo.cpp apo.def -o "$OUT/KilobuzzAPO.dll" -lole32 -luuid -ladvapi32
"$CXX" "${FLAGS[@]}" -municode link.cpp -o "$OUT/kilobuzz-link.exe"
"$CXX" "${FLAGS[@]}" -municode setup.cpp -o "$OUT/kilobuzz-apo-setup.exe" -lole32 -luuid -ladvapi32 -lshell32 -lpropsys
echo "готово: $OUT"
ls -la "$OUT"
