import { registerPlugin, Capacitor } from '@capacitor/core';

// Browser fallback so the apps can be tested in a normal browser.
const web = {
  async getInfo() {
    let id = localStorage.getItem('afford.webDeviceId');
    if (!id) {
      id = `web-${crypto.randomUUID()}`;
      localStorage.setItem('afford.webDeviceId', id);
    }
    return { deviceId: id, model: navigator.userAgent.slice(0, 40), manufacturer: 'browser', osVersion: '', platform: 'web' };
  },
  async getLocation({ timeoutMs = 15000 } = {}) {
    const fake = localStorage.getItem('afford.fakeLocation');
    if (fake) return JSON.parse(fake);
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('NO_GPS'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, mock: false, time: p.timestamp }),
        (e) => reject(new Error(e.code === 1 ? 'PERMISSION_DENIED' : 'NO_FIX')),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10000 },
      );
    });
  },
  async ensureGps() { return { enabled: true }; },
  async biometricAvailable() { return { available: localStorage.getItem('afford.fakeBiometric') === '1', reason: 'web' }; },
  async biometricAuth() { return { ok: localStorage.getItem('afford.fakeBiometric') === '1' }; },
  async secureSet({ key, value }) { localStorage.setItem(`afford.secure.${key}`, value); },
  async secureGet({ key }) { return { value: localStorage.getItem(`afford.secure.${key}`) }; },
  async secureRemove({ key }) { localStorage.removeItem(`afford.secure.${key}`); },
  async shareFile({ filename, base64, text, mime }) {
    const blob = text != null ? new Blob([text], { type: mime }) : new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  async printHtml({ html }) {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 400);
  },
  async openUrl({ url }) { window.open(url, '_blank'); },
  async keepAwake() {},
  async requestCamera() { return { granted: true }; },
  async openAppSettings() {},
  async minimize() {},
  async saveDownload({ filename, text, mime = 'application/json' }) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return { path: `Downloads/${filename}` };
  },
  async pruneDownloads() { return { removed: 0 }; },
  async requestNotifications() { return { granted: true }; },
  async startBackgroundCheck() {},
  async downloadUpdate({ url }) { window.open(url, '_blank'); return { path: null, web: true }; },
  async installUpdate() { return { needsPermission: false }; },
  async stopBackgroundCheck() {},
  async addListener() { return { remove: async () => {} }; },
};

export const AffordDevice = registerPlugin('AffordDevice', { web: () => web });
export const isNative = () => Capacitor.isNativePlatform();
