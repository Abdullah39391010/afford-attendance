// Camera + PIN sheet used to check in someone else (admin kiosk and the staff app's "check in others").
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { AffordDevice } from 'afford-device';
import { t, nm } from './i18n.js';
import { Icon, Sheet, PinPad, Spinner, Banner, toastErr } from './ui.jsx';

export function PunchSheet({ emp, photoRequired, onClose, onDone, send }) {
  const video = useRef(null);
  const stream = useRef(null);
  const [cam, setCam] = useState('starting'); // starting | on | off
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const p = await AffordDevice.requestCamera().catch(() => ({ granted: true }));
        if (!p.granted) throw new Error('denied');
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 } }, audio: false });
        if (!live) { s.getTracks().forEach((tr) => tr.stop()); return; }
        stream.current = s;
        if (video.current) { video.current.srcObject = s; await video.current.play().catch(() => {}); }
        setCam('on');
      } catch { if (live) setCam('off'); }
    })();
    return () => { live = false; stream.current?.getTracks().forEach((tr) => tr.stop()); };
  }, []);

  const snap = () => {
    const v = video.current;
    if (cam !== 'on' || !v || !v.videoWidth) return null;
    const w = 320;
    const hgt = Math.round((v.videoHeight / v.videoWidth) * w);
    const c = document.createElement('canvas');
    c.width = w; c.height = hgt;
    const g = c.getContext('2d');
    g.translate(w, 0); g.scale(-1, 1); // mirror like the preview
    g.drawImage(v, 0, 0, w, hgt);
    return c.toDataURL('image/jpeg', 0.6);
  };

  const submit = async (pin) => {
    setBusy(true);
    try {
      const type = emp.isIn ? 'out' : 'in';
      const res = await send({ pin, photo: snap(), type });
      onDone({ ...res, name: nm(emp) });
    } catch (e) {
      setErr({ at: Date.now() });
      toastErr(e);
    } finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} title={`${nm(emp)} · ${emp.isIn ? t('Check out') : t('Check in')}`}>
      <div class="kiosk-cam">
        <video ref={video} playsInline muted autoPlay style={cam === 'on' ? '' : 'display:none'} />
        {cam === 'starting' && <Spinner />}
        {cam === 'off' && <div class="small muted center"><Icon n="camera" /><br />{t('Camera not available')}</div>}
      </div>
      {cam === 'off' && photoRequired ? (
        <Banner kind="err">{t('The camera is needed for kiosk check-in. Allow camera for this app in phone settings.')}</Banner>
      ) : (
        <div>
          <div class="center muted small" style="margin-top:8px">{nm(emp)}: {t('Look at the camera and enter your PIN')}</div>
          <PinPad length={4} max={6} onDone={submit} error={err?.at} busy={busy} />
        </div>
      )}
    </Sheet>
  );
}
