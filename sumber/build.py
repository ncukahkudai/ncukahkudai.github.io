"""Builds the installable app in pwa/ from app.html (the claude.ai version).

The installable version is locked down: no code or fonts from other servers,
a strict Content-Security-Policy, and security headers for Netlify.
"""
import re, pathlib, zipfile

root = pathlib.Path(__file__).parent
src = (root / "app.html").read_text()
out = root / "pwa"
out.mkdir(exist_ok=True)

title = re.search(r"<title>.*?</title>", src).group(0)
css = re.search(r"<style>\n(.*?)</style>", src, re.S).group(1)
js = re.search(r"<script>\n(.*?)</script>", src, re.S).group(1)
body = src[src.index("</style>") + len("</style>"):src.index("<script>\n")]

# Without Google Fonts the app uses the phone's own fonts (the CSS already lists fallbacks).
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; "
       "connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; "
       "form-action 'none'; object-src 'none'")

html = f"""<!doctype html>
<html lang="id"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="{CSP}">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#d9531a">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Lapangan">
{title}
<link rel="stylesheet" href="app.css">
</head><body>
{body.strip()}
<script src="jszip.min.js"></script>
<script src="app.js"></script>
</body></html>
"""
base_css = (":root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}"
            "body{margin:0}img{max-width:100%}[hidden]{display:none!important}\n")

(out / "index.html").write_text(html)
(out / "app.css").write_text(base_css + css)
(out / "app.js").write_text(js)
(out / "jszip.min.js").write_bytes((root / "vendor/jszip.min.js").read_bytes())
(out / "_headers").write_text(f"""/*
  Content-Security-Policy: {CSP}; frame-ancestors 'none'
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=(), usb=(), bluetooth=(), interest-cohort=()
  Strict-Transport-Security: max-age=31536000

/sw.js
  Cache-Control: no-cache
""")

files = ["index.html", "app.css", "app.js", "jszip.min.js", "sw.js", "manifest.webmanifest", "_headers",
         "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]
with zipfile.ZipFile(root / "catatan-lapangan.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(out / f, f"catatan-lapangan/{f}")
print("built", len(files), "files")
