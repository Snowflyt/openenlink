#!/bin/sh
# Rebuilds tcpip.wasm from tcpip.js 0.4.0 with lwip-glue.patch applied.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
work="$here/../../.cache/tcpip-build"
mkdir -p "$work"
cd "$work"

if [ ! -x wasi-sdk/bin/clang ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) platform=arm64-macos ;;
    Darwin-x86_64) platform=x86_64-macos ;;
    Linux-x86_64) platform=x86_64-linux ;;
    Linux-aarch64) platform=arm64-linux ;;
    *) echo "No wasi-sdk 24 build for this platform" >&2 && exit 1 ;;
  esac
  curl -fsSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-24/wasi-sdk-24.0-$platform.tar.gz" | tar -xz
  mv "wasi-sdk-24.0-$platform" wasi-sdk
fi

[ -d tcpip.js ] || git clone https://github.com/chipmk/tcpip.js.git
cd tcpip.js
git checkout -q --detach tcpip-v0.4.0
git checkout -q -- packages/tcpip/wasm
git apply --directory=packages/tcpip "$here/lwip-glue.patch"
cd packages/tcpip
# lwipopts.h changes lwIP itself, so rebuild every object.
make -s -i clean clean-vendor >/dev/null 2>&1
make -s CC="$work/wasi-sdk/bin/clang" AR="$work/wasi-sdk/bin/llvm-ar" build
cp tcpip.wasm "$here/tcpip.wasm"
