#!/usr/bin/env bash
# 把 apps-script/ 裡的原始頁面複製到 site/demo/，只在 <head> 後面插入一行 mock-gas.js。
# 原始檔案不會被修改。用法：bash scripts/build-demo.sh
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=apps-script
OUT=site/demo
INJECT='  <script src="mock-gas.js"></script><!-- demo: 以瀏覽器模擬 google.script.run -->'
for pair in index.html:pos.html kds_oden.html:kds.html kds_drinks.html:kds-drinks.html ocs.html:ocs.html pickup.html:pickup.html; do
  src="${pair%%:*}"; dst="$OUT/${pair##*:}"
  awk -v inj="$INJECT" '{print} !done && /<head>/ {print inj; done=1}' "$SRC/$src" > "$dst"
  # 確認除了插入的那一行以外，內容與原始檔完全相同
  diff <(grep -vF 'mock-gas.js' "$dst") "$SRC/$src" >/dev/null || { echo "內容不一致：$dst" >&2; exit 1; }
  echo "built $dst"
done
