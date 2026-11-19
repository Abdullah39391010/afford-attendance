// Selfie taken with every check-in (rule "Staff take a selfie with every check-in").
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { AffordDevice } from 'afford-device';
import { t } from '../shared/i18n.js';
import { Icon, Sheet, Spinner, Banner } from '../shared/ui.jsx';

export function SelfieSheet({ onShot, onClose }) {
  const video = useRef(null);
  const stream = useRef(null);
  const [cam, setCam] = useState('starting'); // starting | on | off
  const [count, setCount] = useState(null);
  const [shot, setShot] = useState(null); // photo waiting for Use / Retake

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const p = await AffordDevice.requestCamera().catch(() => ({ granted: true }));
        if (!p.granted) throw new Error('denied');
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
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
    if (!v || !v.videoWidth) return null;
    const w = 360;
    const hgt = Math.round((v.videoHeight / v.videoWidth) * w);
    const c = document.createElement('canvas');
    c.width = w; c.height = hgt;
    const g = c.getContext('2d');
    g.translate(w, 0); g.scale(-1, 1); // mirror like the preview
    g.drawImage(v, 0, 0, w, hgt);
    return c.toDataURL('image/jpeg', 0.65);
  };

  // short 3-2-1 so the person can look at the camera
  const take = () => {
    if (count != null) return;
    let n = 3;
    setCount(n);
    const iv = setInterval(() => {
      n -= 1;
      if (n > 0) { setCount(n); return; }
      clearInterval(iv);
      const photo = snap();
      setCount(null);
      if (photo) setShot(photo);
    }, 650);
  };

  return (
    <Sheet open onClose={onClose} title={t('Selfie for check-in')}>
      <div class="selfie-cam">
        <video ref={video} playsInline muted autoPlay style={cam === 'on' && !shot ? '' : 'display:none'} />
        {shot && <img class="selfie-shot" src={shot} alt="" />}
        {cam === 'starting' && <Spinner />}
        {cam === 'off' && <div class="small muted center"><Icon n="camera" /><br />{t('Camera not available')}</div>}
        {count != null && <div class="selfie-count">{count}</div>}
      </div>
      {cam === 'off' ? (
        <div>
          <Banner kind="err">{t('The camera is needed to check in. Allow camera for this app in phone settings.')}</Banner>
          <button class="btn block ghost" style="margin-top:10px" onClick={() => AffordDevice.openAppSettings()}>{t('Open phone settings')}</button>
        </div>
      ) : shot ? (
        <div>
          <p class="small muted center" style="margin:8px 0 10px">{t('Is your face clear? If not, take it again.')}</p>
          <div style="display:flex;gap:10px">
            <button class="btn ghost big" style="flex:1" onClick={() => setShot(null)}><Icon n="refresh" /> {t('Retake')}</button>
            <button class="btn big" style="flex:1.6" onClick={() => onShot(shot)}><Icon n="check" /> {t('Use photo and check in')}</button>
          </div>
        </div>
      ) : (
        <div>
          <p class="small muted center" style="margin:8px 0 10px">{t('Look at the camera. Your photo is saved with this check-in.')}</p>
          <button class="btn block big" disabled={cam !== 'on' || count != null} onClick={take}><Icon n="camera" /> {t('Take selfie')}</button>
        </div>
      )}
    </Sheet>
  );
}
