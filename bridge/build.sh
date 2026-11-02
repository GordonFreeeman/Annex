#!/bin/sh
set -e
cd "$(dirname "$0")"
# Optional rebuild of the on-phone Wi-Fi bridge. The result is committed in bridge/prebuilt/,
# so you only need this if you change AnnexBridge.java / AppList.java.
# Requires: JDK 11+, python3 + enjarify (pip), zip, and
#   D8_JAR      a JVM-runnable R8/D8 jar (e.g. from the Android SDK build-tools: lib/d8.jar)
#   APKTOOL_JAR apktool 2.4.x jar (provides smali/baksmali)
: "${D8_JAR:?set D8_JAR}"; : "${APKTOOL_JAR:?set APKTOOL_JAR}"
rm -rf out && mkdir -p out/cls
mkdir -p out/stubs
javac --release 8 -nowarn -d out/stubs $(find stubs -name '*.java') 2>&1 | grep -v JAVA_TOOL || true
javac --release 8 -nowarn -cp out/stubs -d out/cls AnnexBridge.java AppList.java 2>&1 | grep -v JAVA_TOOL || true
(cd out/cls && jar cf ../bridge.jar annex)
java -XX:+UnlockDiagnosticVMOptions -XX:-BytecodeVerificationRemote -XX:-BytecodeVerificationLocal -Xmx2g \
  -cp "$D8_JAR" com.android.tools.r8.D8 --release --min-api 21 --output out out/bridge.jar 2>&1 | grep -v JAVA_TOOL || true
# Re-assemble through baksmali/smali (dexlib2): canonical pools + correct checksum and SHA-1 signature.
mkdir -p out/rs && javac -nowarn -cp "$APKTOOL_JAR" -d out/rs tools/Resmali.java 2>&1 | grep -v JAVA_TOOL || true
rm -rf out/smali out/z && mkdir -p out/z && cp out/classes.dex out/z/ && (cd out/z && rm -f ../d8.zip && zip -q ../d8.zip classes.dex)
java -cp "$APKTOOL_JAR:out/rs" Resmali out/d8.zip out/smali out/classes.dex 2>&1 | grep -v JAVA_TOOL
python3 -c "
import zlib,hashlib,struct,sys
d=open('out/classes.dex','rb').read()
ok=d[:4]==b'dex\n' and struct.unpack('<I',d[8:12])[0]==zlib.adler32(d[12:]) and d[12:32]==hashlib.sha1(d[32:]).digest() and struct.unpack('<I',d[32:36])[0]==len(d)
print('dex header/checksum/signature:', 'OK' if ok else 'BAD'); sys.exit(0 if ok else 1)"
# Package like scrcpy-server: a jar (zip) holding classes.dex — the loading path app_process uses for scrcpy.
(cd out && rm -f annex-bridge.jar && zip -q -X annex-bridge.jar classes.dex)
ls -la out/classes.dex out/annex-bridge.jar
# round-trip: dex -> jvm classes, so tests exercise the exact dex we ship
python3 -m enjarify.main out/classes.dex -o out/roundtrip.jar -f -q >/dev/null 2>&1
ls -la out/roundtrip.jar
mkdir -p prebuilt && cp out/annex-bridge.jar out/roundtrip.jar prebuilt/
echo "updated bridge/prebuilt/"
