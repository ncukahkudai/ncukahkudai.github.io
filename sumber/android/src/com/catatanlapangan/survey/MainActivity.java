package com.catatanlapangan.survey;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Base64;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Runs the Catatan Lapangan web app from the APK's own assets.
 * The page is served at https://appassets.androidplatform.net (a secure origin, so GPS and
 * IndexedDB work); every request to any other host is refused.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String HOME = "https://" + HOST + "/index.html";
    static final int REQ_FILE = 1, REQ_LOCATION = 2, REQ_STORAGE = 3;
    static final long MAX_FILE = 1024L * 1024 * 1024;

    WebView web;
    ValueCallback<Uri[]> fileCallback;
    Uri cameraUri;
    GeolocationPermissions.Callback geoCallback;
    String geoOrigin;
    final Map<String, Pending> pending = new HashMap<String, Pending>();

    static class Pending {
        String name, mime;
        File file;
        OutputStream out;
        long size;
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        installCrashLog();
        if (showLastCrash()) return;
        clearDir(FileShareProvider.dir(this, FileShareProvider.SHARE));

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSaveFormData(false);
        web.addJavascriptInterface(new Bridge(), "AndroidApp");
        web.setWebViewClient(new LocalClient());
        web.setWebChromeClient(new Chrome());

        if (state != null) web.restoreState(state);
        if (web.getUrl() == null) web.loadUrl(HOME);
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); if (web != null) web.saveState(out); }
    @Override protected void onPause() { if (web != null) web.onPause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() { if (web != null) web.destroy(); super.onDestroy(); }

    /* ---------- crash report: if the app closes itself, the next launch shows why ---------- */

    File crashFile() { return new File(getFilesDir(), "crash.txt"); }

    void installCrashLog() {
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override public void uncaughtException(Thread t, Throwable e) {
                try {
                    java.io.StringWriter sw = new java.io.StringWriter();
                    e.printStackTrace(new java.io.PrintWriter(sw));
                    String info = "Catatan Lapangan " + versionName() + " | Android " + Build.VERSION.RELEASE
                            + " (API " + Build.VERSION.SDK_INT + ") | " + Build.MANUFACTURER + " " + Build.MODEL + "\n\n" + sw;
                    FileOutputStream out = new FileOutputStream(crashFile());
                    out.write(info.getBytes("UTF-8"));
                    out.close();
                } catch (Throwable ignored) { }
                if (previous != null) previous.uncaughtException(t, e);
            }
        });
    }

    String versionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    boolean showLastCrash() {
        File f = crashFile();
        if (!f.isFile()) return false;
        String text;
        try {
            byte[] b = new byte[(int) Math.min(f.length(), 20000)];
            FileInputStream in = new FileInputStream(f);
            int n = in.read(b);
            in.close();
            text = new String(b, 0, Math.max(n, 0), "UTF-8");
        } catch (IOException e) {
            text = String.valueOf(e);
        }
        f.delete();
        final String report = text;

        android.widget.LinearLayout box = new android.widget.LinearLayout(this);
        box.setOrientation(android.widget.LinearLayout.VERTICAL);
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad, pad, pad);
        android.widget.TextView head = new android.widget.TextView(this);
        head.setText("Aplikasi sempat tertutup karena error. Salin teks di bawah dan kirim ke pembuat aplikasi, lalu tekan Lanjutkan.");
        head.setTextSize(16);
        android.widget.Button copy = new android.widget.Button(this);
        copy.setText("Salin laporan error");
        copy.setOnClickListener(new android.view.View.OnClickListener() {
            @Override public void onClick(android.view.View v) {
                android.content.ClipboardManager cm = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("error", report));
                android.widget.Toast.makeText(MainActivity.this, "Laporan disalin", android.widget.Toast.LENGTH_SHORT).show();
            }
        });
        android.widget.Button go = new android.widget.Button(this);
        go.setText("Lanjutkan");
        go.setOnClickListener(new android.view.View.OnClickListener() {
            @Override public void onClick(android.view.View v) { recreate(); }
        });
        android.widget.TextView body = new android.widget.TextView(this);
        body.setText(report);
        body.setTextIsSelectable(true);
        body.setTypeface(android.graphics.Typeface.MONOSPACE);
        body.setTextSize(11);
        android.widget.ScrollView scroll = new android.widget.ScrollView(this);
        scroll.addView(body);
        box.addView(head);
        box.addView(copy);
        box.addView(go);
        box.addView(scroll);
        setContentView(box);
        return true;
    }

    @Override
    public void onBackPressed() {
        if (web == null) { finish(); return; }
        web.evaluateJavascript("window.__clBack ? window.__clBack() : false", new ValueCallback<String>() {
            @Override public void onReceiveValue(String handled) {
                if (!"true".equals(handled)) finish();
            }
        });
    }

    /* ---------- serving the app and blocking everything else ---------- */

    class LocalClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!"https".equals(u.getScheme()) || !HOST.equals(u.getHost())) return blocked();
            String path = u.getPath() == null ? "" : u.getPath().replaceFirst("^/+", "");
            if (path.isEmpty()) path = "index.html";
            if (path.contains("..") || path.contains("\\")) return blocked();
            try {
                InputStream in = getAssets().open("www/" + path);
                Map<String, String> h = new HashMap<String, String>();
                h.put("X-Content-Type-Options", "nosniff");
                h.put("Referrer-Policy", "no-referrer");
                h.put("Cache-Control", "no-store");
                return new WebResourceResponse(mime(path), "utf-8", 200, "OK", h, in);
            } catch (IOException e) {
                return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
            }
        }

        // The request-object overload is API 24+; on those versions it calls this one by default.
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            Uri u = Uri.parse(url);
            if ("https".equals(u.getScheme()) && HOST.equals(u.getHost())) return false;
            // "Buka di Google Earth" / "Google Maps" open in those apps or the browser; nothing else leaves the app.
            if ("https".equals(u.getScheme()) && ("earth.google.com".equals(u.getHost()) || "www.google.com".equals(u.getHost()))) {
                try { startActivity(new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE)); } catch (Exception ignored) { }
            }
            return true;
        }
    }

    static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    static String mime(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        return "application/octet-stream";
    }

    /** Before Android 6 every permission is granted at install time. */
    boolean has(String permission) {
        return Build.VERSION.SDK_INT < 23 || checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    /* ---------- GPS and camera ---------- */

    class Chrome extends WebChromeClient {
        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
            if (!origin.startsWith("https://" + HOST)) { cb.invoke(origin, false, false); return; }
            if (has(Manifest.permission.ACCESS_FINE_LOCATION)) {
                cb.invoke(origin, true, false);
                return;
            }
            geoCallback = cb;
            geoOrigin = origin;
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = cb;
            cameraUri = null;
            Intent intent;
            if (params.isCaptureEnabled()) {
                File dir = FileShareProvider.dir(MainActivity.this, FileShareProvider.CAMERA);
                clearDir(dir);
                File photo = new File(dir, "foto-" + System.currentTimeMillis() + ".jpg");
                cameraUri = FileShareProvider.uriFor(FileShareProvider.CAMERA, photo.getName());
                intent = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
                intent.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, cameraUri);
                intent.setClipData(ClipData.newRawUri("", cameraUri));
                intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } else {
                intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("image/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            }
            try {
                startActivityForResult(intent, REQ_FILE);
            } catch (Exception e) {
                fileCallback.onReceiveValue(null);
                fileCallback = null;
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILE || fileCallback == null) { super.onActivityResult(requestCode, resultCode, data); return; }
        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            if (cameraUri != null) {
                File f = FileShareProvider.fileFor(this, cameraUri);
                if (f != null && f.length() > 0) result = new Uri[]{cameraUri};
            } else if (data != null && data.getClipData() != null) {
                ClipData c = data.getClipData();
                result = new Uri[c.getItemCount()];
                for (int i = 0; i < c.getItemCount(); i++) result[i] = c.getItemAt(i).getUri();
            } else if (data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] perms, int[] results) {
        if (requestCode == REQ_LOCATION && geoCallback != null) {
            boolean ok = false;
            for (int r : results) ok |= r == PackageManager.PERMISSION_GRANTED;
            geoCallback.invoke(geoOrigin, ok, false);
            geoCallback = null;
        }
    }

    /* ---------- saving files (bridge for the page) ---------- */

    static String safeName(String name) {
        String n = name == null ? "" : name.replaceAll("[^A-Za-z0-9._-]", "_");
        if (n.length() > 80) n = n.substring(n.length() - 80);
        String lower = n.toLowerCase();
        if (!(lower.endsWith(".kmz") || lower.endsWith(".jpg") || lower.endsWith(".zip"))) n = n + ".bin";
        if (n.startsWith(".")) n = "file" + n;
        return n;
    }

    static String safeMime(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".kmz")) return "application/vnd.google-earth.kmz";
        if (n.endsWith(".jpg")) return "image/jpeg";
        if (n.endsWith(".zip")) return "application/zip";
        return "application/octet-stream";
    }

    class Bridge {
        @JavascriptInterface
        public String begin(String name, String ignoredMime) {
            synchronized (pending) {
                try {
                    Pending p = new Pending();
                    p.name = safeName(name);
                    p.mime = safeMime(p.name);
                    File dir = FileShareProvider.dir(MainActivity.this, FileShareProvider.SHARE);
                    p.file = new File(dir, p.name);
                    p.out = new FileOutputStream(p.file);
                    String id = UUID.randomUUID().toString();
                    pending.put(id, p);
                    return id;
                } catch (IOException e) {
                    return "";
                }
            }
        }

        @JavascriptInterface
        public boolean append(String id, String base64) {
            synchronized (pending) {
                Pending p = pending.get(id);
                if (p == null) return false;
                try {
                    byte[] b = Base64.decode(base64, Base64.DEFAULT);
                    p.size += b.length;
                    if (p.size > MAX_FILE) throw new IOException("too large");
                    p.out.write(b);
                    return true;
                } catch (Exception e) {
                    try { p.out.close(); } catch (IOException ignored) { }
                    p.file.delete();
                    pending.remove(id);
                    return false;
                }
            }
        }

        @JavascriptInterface
        public String finish(String id, boolean open) {
            final Pending p;
            synchronized (pending) { p = pending.remove(id); }
            if (p == null) return "err:file tidak ditemukan";
            try {
                p.out.close();
                String where = saveToDownloads(p);
                if (open) runOnUiThread(new Runnable() { public void run() { openOrShare(p); } });
                return "ok:" + where;
            } catch (Exception e) {
                return "err:" + e.getMessage();
            }
        }
    }

    String saveToDownloads(Pending p) throws IOException {
        String folder = "Catatan Lapangan";
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put("_display_name", p.name);
            v.put("mime_type", p.mime);
            v.put("relative_path", Environment.DIRECTORY_DOWNLOADS + "/" + folder);
            Uri target = getContentResolver().insert(Uri.parse("content://media/external/downloads"), v);
            if (target == null) throw new IOException("folder Download tidak bisa dibuka");
            OutputStream out = getContentResolver().openOutputStream(target);
            if (out == null) throw new IOException("folder Download tidak bisa dibuka");
            copy(p.file, out);
        } else {
            if (!has(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
                runOnUiThread(new Runnable() { public void run() {
                    requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
                } });
                throw new IOException("izinkan akses penyimpanan, lalu ulangi");
            }
            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), folder);
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("folder Download tidak bisa dibuat");
            copy(p.file, new FileOutputStream(new File(dir, p.name)));
        }
        return "Download/" + folder + "/" + p.name;
    }

    void openOrShare(Pending p) {
        Uri uri = FileShareProvider.uriFor(FileShareProvider.SHARE, p.file.getName());
        Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, p.mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent send = new Intent(Intent.ACTION_SEND).setType(p.mime).putExtra(Intent.EXTRA_STREAM, uri);
        send.setClipData(ClipData.newRawUri("", uri));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, "Buka atau kirim " + p.name);
        chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{view});
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivity(chooser); } catch (Exception ignored) { }
    }

    static void copy(File from, OutputStream out) throws IOException {
        InputStream in = new FileInputStream(from);
        try {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            in.close();
            out.close();
        }
    }

    static void clearDir(File dir) {
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) f.delete();
    }
}
