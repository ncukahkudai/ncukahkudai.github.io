#!/bin/sh
# Builds CatatanLapangan.apk from ../app.html with the Ubuntu Android tools
# (apt install aapt android-sdk-platform-23 dalvik-exchange apksigner zipalign).
set -eu
cd "$(dirname "$0")"
SDK=/usr/lib/android-sdk
JAR=$SDK/platforms/android-23/android.jar
VERSION_CODE=${VERSION_CODE:-1}
VERSION_NAME=${VERSION_NAME:-1.0}

python3 ../build.py >/dev/null
rm -rf build && mkdir -p build/gen build/classes build/assets/www
for f in index.html app.css app.js jszip.min.js manifest.webmanifest icon-192.png icon-512.png; do cp ../pwa/$f build/assets/www/; done

if [ ! -f release.keystore ]; then
  head -c 24 /dev/urandom | base64 | tr -d '/+=' > keystore-password.txt
  keytool -genkeypair -keystore release.keystore -alias catatan -keyalg RSA -keysize 3072 -validity 11000 \
    -dname "CN=Catatan Lapangan" -storepass "$(cat keystore-password.txt)" -keypass "$(cat keystore-password.txt)" 2>/dev/null
fi

aapt2 compile --dir res -o build/res.zip
aapt2 link -o build/base.apk -I "$JAR" --manifest AndroidManifest.xml --java build/gen -A build/assets \
  --min-sdk-version 21 --target-sdk-version 34 --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" build/res.zip
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$JAR" -d build/classes \
  $(find src build/gen -name '*.java')
$SDK/build-tools/*/dx --dex --min-sdk-version=21 --output=build/classes.dex build/classes
cp build/base.apk build/unaligned.apk
(cd build && zip -q unaligned.apk classes.dex)
zipalign -f -p 4 build/unaligned.apk build/aligned.apk
apksigner sign --ks release.keystore --ks-key-alias catatan --ks-pass file:keystore-password.txt \
  --min-sdk-version 21 --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false --out ../CatatanLapangan.apk build/aligned.apk
apksigner verify --min-sdk-version 21 ../CatatanLapangan.apk
echo "built ../CatatanLapangan.apk"
