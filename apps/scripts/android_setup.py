#!/usr/bin/env python3
"""Customise the generated Capacitor Android projects (icons, splash, version, signing).

Run from the repo root after `npx cap add android`:  python3 apps/scripts/android_setup.py
Safe to run again.
"""
import json, os, re
from PIL import Image, ImageDraw, ImageFont

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


def badge(img, label):
    """Red ribbon with a word at the bottom of a square icon (admin app only)."""
    if not label:
        return img
    w, h = img.size
    d = ImageDraw.Draw(img)
    bh = int(h * 0.24)
    y0 = int(h * 0.70)
    d.rounded_rectangle([int(w * 0.12), y0, int(w * 0.88), y0 + bh], radius=bh // 2, fill=RED)
    f = font(int(bh * 0.62))
    tw = d.textlength(label, font=f)
    d.text(((w - tw) / 2, y0 + bh * 0.16), label, font=f, fill=(255, 255, 255, 255))
    return img


def legacy_icon(px, label, round_):
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    m = Image.new('L', (px, px), 0)
    ImageDraw.Draw(m).ellipse([0, 0, px - 1, px - 1], fill=255) if round_ else ImageDraw.Draw(m).rounded_rectangle([0, 0, px - 1, px - 1], radius=px // 5, fill=255)
    bg = Image.new('RGBA', (px, px), (255, 255, 255, 255))
    img.paste(bg, (0, 0), m)
    s = int(px * (0.56 if label else 0.66))
    y = int(px * 0.10) if label else (px - s) // 2
    img.alpha_composite(mark(s), ((px - s) // 2, y))
    return badge(img, label)


def foreground(px, label):
    # adaptive icon: 108dp canvas, safe zone is the middle 66dp
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    s = int(px * (0.40 if label else 0.46))
    y = int(px * 0.24) if label else (px - s) // 2
    img.alpha_composite(mark(s), ((px - s) // 2, y))
    if label:
        inner = img.crop((int(px * 0.17), int(px * 0.17), int(px * 0.83), int(px * 0.83)))
        inner = badge(inner, label)
        img.paste(inner, (int(px * 0.17), int(px * 0.17)))
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
    # Android 12+ splash: white background with the logo, then the web splash animation takes over
    sp = os.path.join(res, 'values/styles.xml')
    s = open(sp).read()
    s = re.sub(r'<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">.*?</style>',
               '<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">\n'
               '        <item name="android:background">@drawable/splash</item>\n'
               '        <item name="windowSplashScreenBackground">#FFFFFF</item>\n'
               '        <item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>\n'
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
