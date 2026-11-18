#!/usr/bin/env python3
"""Customise the generated Capacitor Android projects (icons, splash, version, signing).

Run from the repo root after `npx cap add android`:  python3 apps/scripts/android_setup.py
Safe to run again.
"""
import json, os, re
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # apps/
MARK = Image.open(os.path.join(ROOT, '../assets/logo-mark-src.png')).convert('RGBA')  # the red A (icons)
WORD = Image.open(os.path.join(ROOT, 'web/public/logo.png')).convert('RGBA')  # full wordmark (splash)
MARK = MARK.crop(MARK.getbbox())


def mark(s):
    """The A fitted in an s x s square, centred."""
    m = MARK.copy()
    m.thumbnail((s, s), Image.LANCZOS)
    out = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    out.alpha_composite(m, ((s - m.width) // 2, (s - m.height) // 2))
    return out
RED = (198, 32, 50, 255)
DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'


def font(size):
    try:
        return ImageFont.truetype(FONT, size)
    except OSError:
        return ImageFont.load_default()


def badge(img, label, fill=RED):
    """Red ribbon with a word at the bottom of a square icon (admin app only)."""
    if not label:
        return img
    w, h = img.size
    d = ImageDraw.Draw(img)
    bh = int(h * 0.24)
    y0 = int(h * 0.70)
    d.rounded_rectangle([int(w * 0.12), y0, int(w * 0.88), y0 + bh], radius=bh // 2, fill=fill)
    f = font(int(bh * 0.62))
    tw = d.textlength(label, font=f)
    d.text(((w - tw) / 2, y0 + bh * 0.16), label, font=f, fill=(255, 255, 255, 255))
    return img


BAG_RED0, BAG_RED1 = (245, 40, 45, 255), (185, 12, 25, 255)
INK = (28, 28, 34, 255)


def red_fill(size):
    g = Image.new('RGBA', (1, size[1]))
    for y in range(size[1]):
        t = y / max(1, size[1] - 1)
        g.putpixel((0, y), tuple(int(BAG_RED0[i] * (1 - t) + BAG_RED1[i] * t) for i in range(4)))
    return g.resize(size)


def bag_art(W, label):
    """White shopping bag with the red A, drawn on a transparent W x W canvas (icon design 1)."""
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    up = 0.06 if label else 0.0
    x0, y0, x1, y1 = W * 0.22, W * (0.33 - up), W * 0.78, W * (0.84 - up)
    w = x1 - x0
    sh = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([x0, y0 + W * 0.02, x1, y1 + W * 0.02], radius=int(W * 0.04), fill=(0, 0, 0, 70))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(W * 0.02)))
    d = ImageDraw.Draw(img)
    hh = (y1 - y0) * 0.32
    d.arc([x0 + w * 0.28, y0 - hh, x1 - w * 0.28, y0 + hh], 180, 360, fill=(255, 255, 255, 255), width=max(1, int(W * 0.035)))
    m = Image.new('L', (W, W), 0)
    dm = ImageDraw.Draw(m)
    dm.polygon([(x0 + w * 0.06, y0), (x1 - w * 0.06, y0), (x1, y1 - w * 0.08), (x0, y1 - w * 0.08)], fill=255)
    dm.rounded_rectangle([x0, y1 - w * 0.2, x1, y1], radius=int(w * 0.08), fill=255)
    img.paste(Image.new('RGBA', (W, W), (255, 255, 255, 255)), (0, 0), m)
    d.line([(x0 + w * 0.07, y0 + w * 0.07), (x1 - w * 0.07, y0 + w * 0.07)], fill=(220, 220, 224, 255), width=max(1, int(w * 0.012)))
    s = int(W * 0.34)
    k = s / max(MARK.size)
    a = MARK.resize((max(1, int(MARK.width * k)), max(1, int(MARK.height * k))), Image.LANCZOS)
    img.alpha_composite(a, (int(W * 0.5 - a.width / 2), int(W * (0.6 - up) - a.height / 2)))
    return img


def legacy_icon(px, label, round_):
    W = px * 4
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    m = Image.new('L', (W, W), 0)
    ImageDraw.Draw(m).ellipse([0, 0, W - 1, W - 1], fill=255) if round_ else ImageDraw.Draw(m).rounded_rectangle([0, 0, W - 1, W - 1], radius=W // 5, fill=255)
    img.paste(red_fill((W, W)), (0, 0), m)
    img.alpha_composite(bag_art(W, label))
    img = img.resize((px, px), Image.LANCZOS)
    return badge(img, label, INK)


def foreground(px, label):
    # adaptive icon: 108dp canvas, safe zone is the middle 66dp; the red comes from the background layer
    W = px * 4
    inner = int(W * 0.8)
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    img.alpha_composite(bag_art(inner, label), ((W - inner) // 2, (W - inner) // 2))
    img = img.resize((px, px), Image.LANCZOS)
    if label:
        o = int(px * 0.17)
        piece = img.crop((o, o, px - o, px - o))
        img.paste(badge(piece, label, INK), (o, o))
    return img


def splash(w, h):
    img = Image.new('RGBA', (w, h), (255, 255, 255, 255))
    lw = int(min(w, h) * 0.62)
    lh = int(lw * WORD.height / WORD.width)
    img.alpha_composite(WORD.resize((lw, lh), Image.LANCZOS), ((w - lw) // 2, (h - lh) // 2))
    return img.convert('RGB')


def setup(app, label):
    res = os.path.join(ROOT, app, 'android/app/src/main/res')
    for name, k in DENS.items():
        d = os.path.join(res, f'mipmap-{name}')
        os.makedirs(d, exist_ok=True)
        legacy_icon(int(48 * k), label, False).save(os.path.join(d, 'ic_launcher.png'))
        legacy_icon(int(48 * k), label, True).save(os.path.join(d, 'ic_launcher_round.png'))
        foreground(int(108 * k), label).save(os.path.join(d, 'ic_launcher_foreground.png'))
    # splash images (pre Android 12)
    for folder in os.listdir(res):
        p = os.path.join(res, folder, 'splash.png')
        if os.path.exists(p):
            w, h = Image.open(p).size
            splash(w, h).save(p)
    bgx = os.path.join(res, 'values/ic_launcher_background.xml')
    open(bgx, 'w').write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#D81420</color>\n</resources>\n')
    # Android 12+ splash: white background with the logo, then the web splash animation takes over
    sp = os.path.join(res, 'values/styles.xml')
    s = open(sp).read()
    s = re.sub(r'<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">.*?</style>',
               '<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">\n'
               '        <item name="android:background">@drawable/splash</item>\n'
               '        <item name="windowSplashScreenBackground">#FFFFFF</item>\n'
               '        <item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>\n'
               '        <item name="windowSplashScreenIconBackgroundColor">#D81420</item>\n'
               '        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>\n'
               '    </style>', s, flags=re.S)
    s = s.replace('<item name="android:background">@null</item>', '<item name="android:background">@null</item>\n        <item name="android:statusBarColor">#FFFFFF</item>\n        <item name="android:windowLightStatusBar">true</item>\n        <item name="android:navigationBarColor">#FFFFFF</item>')
    s = re.sub(r'(<item name="android:statusBarColor">#FFFFFF</item>\s*)+', '<item name="android:statusBarColor">#FFFFFF</item>\n        ', s)
    s = re.sub(r'(<item name="android:windowLightStatusBar">true</item>\s*)+', '<item name="android:windowLightStatusBar">true</item>\n        ', s)
    s = re.sub(r'(<item name="android:navigationBarColor">#FFFFFF</item>\s*)+', '<item name="android:navigationBarColor">#FFFFFF</item>\n    ', s)
    open(sp, 'w').write(s)

    # version + signing
    gp = os.path.join(ROOT, app, 'android/app/build.gradle')
    g = open(gp).read()
    if 'afford-version' not in g:
        g = g.replace("apply plugin: 'com.android.application'\n", """apply plugin: 'com.android.application'
import groovy.json.JsonSlurper

// afford-version: version comes from apps/version.json, build number from CI
def affordVersion = new JsonSlurper().parse(file('../../../version.json'))
def affordParts = affordVersion.version.tokenize('.').collect { it as int }
def affordCode = affordParts[0] * 10000 + affordParts[1] * 100 + affordParts[2]
def affordKeystore = System.getenv('AFFORD_KEYSTORE') ?: '../../../signing/afford-release.p12'
""")
        g = re.sub(r'versionCode \d+', 'versionCode affordCode', g)
        g = re.sub(r'versionName "[^"]*"', 'versionName affordVersion.version', g)
        g = g.replace("    buildTypes {\n        release {\n", """    signingConfigs {
        release {
            storeFile file(affordKeystore)
            storePassword System.getenv('AFFORD_KEYSTORE_PASSWORD')
            keyAlias System.getenv('AFFORD_KEY_ALIAS') ?: 'afford'
            keyPassword System.getenv('AFFORD_KEYSTORE_PASSWORD')
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
""")
        open(gp, 'w').write(g)

    # manifest: no backups of tokens, no cleartext traffic
    mp = os.path.join(ROOT, app, 'android/app/src/main/AndroidManifest.xml')
    m = open(mp).read()
    m = m.replace('android:allowBackup="true"', 'android:allowBackup="false"\n        android:usesCleartextTraffic="false"')
    open(mp, 'w').write(m)
    print('customised', app)


if __name__ == '__main__':
    setup('admin', 'ADMIN')
    setup('employee', '')
