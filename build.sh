#!/usr/bin/env bash
# Fiddler Everywhere 8.x 自动补丁脚本
# 输入: 官方安装包 (exe)  输出: 补丁版 zip
# 依赖: 7z (7zz/7z), node + @electron/asar, curl
# 用法: ./build.sh [安装包路径] [版本号]
#       ./build.sh                          # 默认下载 8.0.2
set -euo pipefail

VERSION="${2:-8.0.2}"
INSTALLER="${1:-FiddlerEverywhere-${VERSION}.exe}"
OUTDIR="build"
APPDIR="${OUTDIR}/Fiddler-Everywhere-${VERSION}-Patched"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FE_PORT=5678

# ---- 依赖检查 ----
SEVENZ="$(command -v 7zz || command -v 7z || true)"
[ -z "$SEVENZ" ] && { echo "[!] 未找到 7z/7zz"; exit 1; }
command -v node >/dev/null || { echo "[!] 未找到 node"; exit 1; }
# 依次尝试: 全局 → 本地 → npm install -g (新版 bin 为 asar.mjs, 旧版 asar.js)
ASAR_BIN=""
for _c in "$(npm root -g 2>/dev/null || true)/@electron/asar/bin/asar.mjs" \
          "$(npm root -g 2>/dev/null || true)/@electron/asar/bin/asar.js" \
          "${SCRIPT_DIR}/node_modules/@electron/asar/bin/asar.mjs" \
          "${SCRIPT_DIR}/node_modules/@electron/asar/bin/asar.js"; do
  [ -f "$_c" ] && { ASAR_BIN="$_c"; break; }
done
if [ -z "$ASAR_BIN" ]; then
  npm install -g @electron/asar >/dev/null 2>&1
  for _n in asar.mjs asar.js; do
    _t="$(npm root -g)/@electron/asar/bin/$_n"
    [ -f "$_t" ] && { ASAR_BIN="$_t"; break; }
  done
fi
[ ! -f "$ASAR_BIN" ] && { echo "[!] @electron/asar 安装失败"; exit 1; }

# ---- 下载安装包 (如果本地不存在) ----
if [ ! -f "$INSTALLER" ]; then
  echo "[1/8] 下载 Fiddler Everywhere ${VERSION} ..."
  curl -L -o "$INSTALLER" "https://downloads.getfiddler.com/win/Fiddler%20Everywhere%20${VERSION}.exe"
fi

# ---- 下载 Yui-patch fiddler.dll ----
YUI_VER="v1.1.4"
if [ ! -f "${OUTDIR}/fiddler.dll" ]; then
  echo "[2/8] 下载 Yui-patch fiddler.dll ${YUI_VER} ..."
  mkdir -p "$OUTDIR"
  curl -L -o "${OUTDIR}/fiddler.dll" \
    "https://github.com/project-yui/Yui-patch/releases/download/${YUI_VER}/yui-fiddler-win32-x86_64-${YUI_VER}.dll"
fi

# ---- 解包 ----
echo "[3/8] 解包 NSIS 安装包 ..."
rm -rf "${OUTDIR}/extract" "${APPDIR}"
mkdir -p "${OUTDIR}/extract"
"$SEVENZ" x "$INSTALLER" -o"${OUTDIR}/extract" -y >/dev/null
mkdir -p "${OUTDIR}/extract/app"
"$SEVENZ" x "${OUTDIR}/extract/\$PLUGINSDIR/app-64.7z" -o"${OUTDIR}/extract/app" -y >/dev/null
mv "${OUTDIR}/extract/app" "$APPDIR"
rm -rf "${OUTDIR}/extract"

# ---- asar 提取为目录 ----
echo "[4/8] asar 提取为 app/ 目录 ..."
# 安装包缺少此文件, asar extract 需要
touch "${APPDIR}/resources/app.asar.unpacked/NOTICES-reporter.txt"
node "$ASAR_BIN" extract "${APPDIR}/resources/app.asar" "${APPDIR}/resources/app"
rm -f "${APPDIR}/resources/app.asar"

# ---- main.js 处理: 诊断块 + 补丁服务端 + 原始代码 ----
echo "[5/8] 注入补丁服务端到 main.js ..."
cp "${APPDIR}/resources/app/out/main.js" "${APPDIR}/resources/app/out/main.original.js"
cat > "${OUTDIR}/diag.js" << 'DIAG'
// FE-Patch 诊断块 (纯 Node API, 不碰 Electron)
try {
  const __d_fs = require('fs'), __d_p = require('path');
  const __d_log = __d_p.join(__d_p.dirname(process.execPath), 'fe-patch.log');
  const __d_w = m => { try { __d_fs.appendFileSync(__d_log, '[' + new Date().toISOString() + '] ' + m + '\n'); } catch(e) {} };
  __d_w('=== FE-Patch 启动 ===');
  process.on('exit', c => __d_w('process exit code=' + c));
  process.on('uncaughtException', e => __d_w('uncaughtException: ' + (e && (e.stack || e.message))));
} catch(e) {}
DIAG
cat "${OUTDIR}/diag.js" "${SCRIPT_DIR}/server/index.js" "${SCRIPT_DIR}/server/fe-i18n.js" "${APPDIR}/resources/app/out/main.original.js" \
  > "${APPDIR}/resources/app/out/main.js"
rm -f "${OUTDIR}/diag.js"

# ---- mock 文件 + 汉化语言包 + fiddler.dll ----
echo "[6/8] 复制 mock 响应 + 汉化语言包 + Yui-patch fiddler.dll ..."
cp -r "${SCRIPT_DIR}/server/file" "${APPDIR}/resources/app/out/file"
cp -r "${SCRIPT_DIR}/lang" "${APPDIR}/resources/app/lang"
cp "${OUTDIR}/fiddler.dll" "${APPDIR}/fiddler.dll"

# ---- SDK DLL 预补丁 (运行时还会幂等补一次) ----
echo "[7/8] FiddlerBackendSDK.dll 单字节补丁 (0x16→0x17) ..."
python3 - "${APPDIR}/resources/app/out/WebServer/FiddlerBackendSDK.dll" << 'PYEOF'
import sys
p = sys.argv[1]
d = bytearray(open(p, 'rb').read())
target = bytes.fromhex('162a28b104000a')
pos = d.find(target)
if pos < 0:
    if d.find(bytes.fromhex('172a28b104000a')) >= 0:
        print('  已是补丁状态, 跳过')
        sys.exit(0)
    print('  [!] 未找到目标字节, 该版本可能不兼容, 依赖运行时补丁')
    sys.exit(0)
d[pos:pos+7] = bytes.fromhex('172a28b104000a')
open(p, 'wb').write(d)
print(f'  补丁成功 @ 偏移 {pos}')
PYEOF

# ---- 附属文件 + 打包 ----
echo "[8/8] 附属文件 + 打包 ..."
cp "${SCRIPT_DIR}/assets/hosts-install.bat" "${APPDIR}/安装hosts.bat"
cp "${SCRIPT_DIR}/assets/hosts-remove.bat" "${APPDIR}/卸载hosts.bat"
cp "${SCRIPT_DIR}/assets/使用说明.txt" "${APPDIR}/使用说明.txt"

ZIP="${OUTDIR}/Fiddler-Everywhere-${VERSION}-Patched.zip"
rm -f "$ZIP"
"$SEVENZ" a -tzip "$ZIP" "$APPDIR" -mx=5 >/dev/null
echo ""
echo "============================================"
echo " 完成: ${ZIP}"
echo " 大小: $(du -h "$ZIP" | cut -f1)"
echo "============================================"
echo "使用步骤:"
echo "  1. 任务管理器结束所有 Fiddler Everywher 进程"
echo "  2. 右键管理员运行 安装hosts.bat (只需一次)"
echo "  3. 运行 Fiddler Everywhere.exe, 登录界面点 Google 登录"
