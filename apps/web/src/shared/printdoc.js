// Printable documents (salary statement, reports) with the logo, in English or Urdu.
// Print uses Android's own print dialog (which also offers "Save as PDF"); Share builds a PDF file.
import { AffordDevice } from 'afford-device';
import { t, getLang, statusLabel, moneyLabel } from './i18n.js';
import { fmtMoney, fmtMoney2, fmtTime, fmtDate, fmtMonth, fmtDur, fmtDateTime } from './format.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let assetCache = null;
async function assets() {
  if (assetCache) return assetCache;
  const toData = async (url) => {
    const b = await (await fetch(url)).blob();
    return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
  };
  const [logo, f4, f7] = await Promise.all([toData('./logo.png'), toData('./noto-naskh-arabic-arabic-400-normal.woff2'), toData('./noto-naskh-arabic-arabic-700-normal.woff2')]);
  assetCache = { logo, f4, f7 };
  return assetCache;
}

const CSS = (a, rtl) => `
@font-face{font-family:Naskh;src:url(${a.f4}) format('woff2');font-weight:400}
@font-face{font-family:Naskh;src:url(${a.f7}) format('woff2');font-weight:700}
@page{size:A4;margin:12mm}
.doc{font-family:${rtl ? 'Naskh,' : ''}system-ui,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2023;font-size:12.5px;line-height:${rtl ? 1.7 : 1.45};direction:${rtl ? 'rtl' : 'ltr'};background:#fff}
.doc .hd{display:flex;align-items:center;gap:14px;border-bottom:3px solid #C62032;padding-bottom:10px;margin-bottom:12px}
.doc .hd img{width:110px;height:auto}
.doc .hd h1{font-size:20px;margin:0}
.doc .hd .s{color:#666;font-size:12px}
.doc .hd .r{margin-inline-start:auto;text-align:end;font-size:12px;color:#444}
.doc h2{font-size:14px;margin:14px 0 6px;color:#C62032}
.doc table{width:100%;border-collapse:collapse;font-size:11.5px}
.doc th,.doc td{padding:5px 6px;border-bottom:1px solid #e3e3e6;text-align:start}
.doc th{background:#f4f4f6;font-weight:600}
.doc td.n,.doc th.n{text-align:end;font-family:system-ui,Arial,sans-serif}
.doc .grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px}
.doc .kv{display:flex;justify-content:space-between;border-bottom:1px dashed #ddd;padding:4px 0}
.doc .kv b{font-family:system-ui,Arial,sans-serif}
.doc .net{display:flex;justify-content:space-between;font-size:17px;font-weight:700;border-top:2px solid #1f2023;margin-top:8px;padding-top:8px}
.doc .net b{color:#C62032;font-family:system-ui,Arial,sans-serif}
.doc .foot{margin-top:28px;display:flex;justify-content:space-between;align-items:flex-end;font-size:11px;color:#666}
.doc .sig{border-top:1px solid #999;width:180px;text-align:center;padding-top:4px}
.doc .sigbox{width:180px}.doc .sigimg{display:block;height:64px;width:auto;max-width:180px;margin:0 auto 2px}
.doc .st{display:inline-block;padding:1px 6px;border-radius:8px;font-size:10.5px;font-weight:700}
.doc .st-present{background:#E3F4EA;color:#137043}.doc .st-late{background:#FFF1DC;color:#9a5300}.doc .st-absent{background:#FCE9EB;color:#A3172A}
.doc .st-leave,.doc .st-leave_unpaid{background:#EEE8FB;color:#5a36a8}.doc .st-off,.doc .st-holiday{background:#EEF0F2;color:#5b6168}.doc .st-duty{background:#E8EAF6;color:#3949AB}
.doc .muted{color:#777}
`;

function header(a, storeName, title, right, contact) {
  return `<div class="hd"><img src="${a.logo}"><div><h1>${esc(storeName)}</h1>${contact ? `<div class="s">${esc(contact)}</div>` : ''}<div class="s">${esc(title)}</div></div><div class="r">${right || ''}</div></div>`;
}

// "Received by" box with the employee's hand signature from the latest salary payment, when there is one
const SIG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
function receivedBy(st) {
  const sp = (st.payments || []).filter((p) => p.signature && SIG_RE.test(p.signature)).pop();
  const img = sp ? `<img class="sigimg" src="${sp.signature}" alt="">` : '';
  return `<div class="sigbox">${img}<div class="sig">${esc(t('Received by (employee signature)'))}</div></div>`;
}
function authorisedBy(st) {
  const ok = st.authSignature && SIG_RE.test(st.authSignature) && (st.payments || []).some((p) => p.signature);
  const img = ok ? `<img class="sigimg" src="${st.authSignature}" alt="">` : '';
  return `<div class="sigbox">${img}<div class="sig">${esc(t('Authorised signature'))}</div></div>`;
}

export async function statementDoc(st) {
  const a = await assets();
  const rtl = getLang() === 'ur';
  const e = st.employee;
  const cur = st.currency || 'Rs.';
  const c = st.counts;
  const rows = st.days.filter((d) => d.status !== 'future').map((d) => `<tr>
    <td>${esc(fmtDate(d.date))}</td><td><span class="st st-${d.status}">${esc(statusLabel(d.status))}</span></td>
    <td class="n">${d.checkIn ? esc(fmtTime(d.checkIn)) : ''}</td><td class="n">${d.checkOut ? esc(fmtTime(d.checkOut)) : ''}</td>
    <td class="n">${d.workedMin ? esc(fmtDur(d.workedMin)) : ''}</td><td class="n">${d.lateMin || ''}</td><td class="n">${d.earlyMin || ''}</td>
    <td class="n">${d.cut ? esc(fmtMoney2(d.cut, '')) : ''}</td></tr>`).join('');
  const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
  const body = `<div class="doc">
  ${header(a, st.storeName, `${t('Payslip')} · ${fmtMonth(st.month)}`, `${st.slipNo ? `<b>${esc(t('Payslip no.'))} ${esc(st.slipNo)}</b><br>` : ''}${esc(t('Generated'))}: ${esc(fmtDateTime(st.generatedAt))}${st.complete ? '' : `<br><b>${esc(t('Month in progress (so far)'))}</b>`}${st.locked ? `<br>${esc(t('Locked. Salary is final.'))}` : ''}`, [st.storeAddress, st.storePhone].filter(Boolean).join(' · '))}
  <div class="grid">
    ${kv(t('Employee'), `${e.name} (${e.code})`)}${kv(t('Role'), e.role || '')}
    ${kv(t('Shift'), e.shift ? `${e.shift.name} ${e.shift.start}–${e.shift.end}` : '')}${kv(t('Monthly salary'), fmtMoney(st.salary, cur))}
    ${kv(t('Days basis'), String(st.basisDays))}${kv(t('Daily / hourly rate'), `${fmtMoney2(st.rates.daily, cur)} / ${fmtMoney2(st.rates.hourly, cur)}`)}
  </div>
  <h2>${esc(t('Attendance'))}</h2>
  <div class="grid">
    ${kv(t('Present days'), c.present)}${kv(t('Late days'), `${c.late} (${c.lateMin} ${t('min')})`)}
    ${kv(t('Absent days'), c.absent)}${kv(t('Leave (paid / unpaid)'), `${st.leave.paid} / ${st.leave.unpaid}`)}
    ${kv(t('Off days & holidays'), c.off + c.holiday)}${kv(t('Out-of-town duty'), c.duty)}
    ${kv(t('Early leave minutes'), c.earlyMin)}${kv(t('Late break return (min)'), c.breakLateMin)}
  </div>
  <h2>${esc(t('Pay'))}</h2>
  <div class="grid">
    <div>
      ${kv(t('Monthly salary'), fmtMoney(st.salary, cur))}
      ${kv(t('Absent cut'), `− ${fmtMoney2(st.cuts.absent, cur)}`)}
      ${kv(t('Unpaid leave cut'), `− ${fmtMoney2(st.cuts.leaveUnpaid, cur)}`)}
      ${st.cuts.notJoined ? kv(t('Before joining'), `− ${fmtMoney2(st.cuts.notJoined, cur)}`) : ''}
      ${st.cuts.left ? kv(t('After leaving'), `− ${fmtMoney2(st.cuts.left, cur)}`) : ''}
      ${kv(t('Late cut'), `− ${fmtMoney2(st.cuts.late, cur)}`)}
      ${kv(t('Early leave cut'), `− ${fmtMoney2(st.cuts.early, cur)}`)}
      ${kv(t('Late break cut'), `− ${fmtMoney2(st.cuts.breakLate, cur)}`)}
    </div>
    <div>
      ${kv(t('Advances'), `− ${fmtMoney(st.advances, cur)}`)}
      ${kv(t('Security deposit cut'), `− ${fmtMoney(st.depositCut, cur)}`)}
      ${st.fines ? kv(t('Fines'), `− ${fmtMoney(st.fines, cur)}`) : ''}
      ${kv(t('Bonus'), `+ ${fmtMoney(st.bonus, cur)}`)}
      ${st.commission ? kv(t('Commission'), `+ ${fmtMoney(st.commission, cur)}`) : ''}
      ${st.holidayPay ? kv(t('Holiday work pay ({n} days)', { n: st.counts.holidayWorked }), `+ ${fmtMoney2(st.holidayPay, cur)}`) : ''}
      ${st.overtime?.pay ? kv(t('Overtime ({m} min × {r})', { m: st.overtime.min, r: st.overtime.rate }), `+ ${fmtMoney2(st.overtime.pay, cur)}`) : ''}
      ${kv(t('Security deposit balance'), fmtMoney(st.depositBalance, cur))}
    </div>
  </div>
  <div class="net"><span>${esc(t('Net pay'))}</span><b>${esc(fmtMoney(st.net, cur))}</b></div>
  ${(st.money || []).filter((m) => ['bonus', 'commission', 'fine'].includes(m.kind) && m.note).map((m) => kv(`${moneyLabel(m.kind)} · ${m.note}`, `${m.kind === 'fine' ? '− ' : '+ '}${fmtMoney(m.amount, cur)}`)).join('')}
  ${(st.payments || []).map((p) => kv(`${t('Paid')} · ${t({ cash: 'Cash', bank: 'Bank transfer', other: 'Other' }[p.method] || p.method)} · ${fmtDateTime(p.ts)}`, fmtMoney(p.amount, cur))).join('')}
  <h2>${esc(t('Daily record'))}</h2>
  <table><thead><tr><th>${esc(t('Date'))}</th><th>${esc(t('Status'))}</th><th class="n">${esc(t('In'))}</th><th class="n">${esc(t('Out'))}</th><th class="n">${esc(t('Hours'))}</th><th class="n">${esc(t('Late'))}</th><th class="n">${esc(t('Early'))}</th><th class="n">${esc(t('Cut'))}</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="foot">${receivedBy(st)}${authorisedBy(st)}</div>
  </div>`;
  return { body, css: CSS(a, rtl), title: `${e.name} ${st.month}` };
}

/** Generic table report */
export async function tableDoc({ storeName, title, subtitle, columns, rows }) {
  const a = await assets();
  const rtl = getLang() === 'ur';
  const head = columns.map((c) => `<th${c.num ? ' class="n"' : ''}>${esc(c.label)}</th>`).join('');
  const bodyRows = rows.map((r) => `<tr>${columns.map((c) => `<td${c.num ? ' class="n"' : ''}>${c.html ? c.html(r) : esc(c.get(r))}</td>`).join('')}</tr>`).join('');
  const body = `<div class="doc">${header(a, storeName, title, esc(subtitle || ''))}<table><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
  return { body, css: CSS(a, rtl), title };
}

const fullHtml = (doc) => `<!doctype html><html lang="${getLang()}" dir="${getLang() === 'ur' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>${doc.css}body{margin:0}</style></head><body>${doc.body}</body></html>`;

export async function printDoc(doc) {
  await AffordDevice.printHtml({ html: fullHtml(doc), jobName: doc.title });
}

/** Render to a real PDF file and open the share sheet (WhatsApp, email, etc.). */
export async function shareDocPdf(doc, filename) {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas-pro'), import('jspdf')]);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;background:#fff;padding:36px;';
  host.innerHTML = `<style>${doc.css}</style>${doc.body}`;
  document.body.appendChild(host);
  try {
    await document.fonts.ready;
    await Promise.all([...host.querySelectorAll('img')].map((im) => (im.decode ? im.decode().catch(() => {}) : Promise.resolve())));
    const canvas = await html2canvas(host, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    const pw = pdf.internal.pageSize.getWidth();
    const ph = pdf.internal.pageSize.getHeight();
    const pxPerPt = canvas.width / pw;
    const pageHpx = Math.floor(ph * pxPerPt);
    for (let y = 0, i = 0; y < canvas.height; y += pageHpx, i++) {
      const slice = document.createElement('canvas');
      slice.width = canvas.width;
      slice.height = Math.min(pageHpx, canvas.height - y);
      slice.getContext('2d').drawImage(canvas, 0, y, canvas.width, slice.height, 0, 0, canvas.width, slice.height);
      if (i) pdf.addPage();
      pdf.addImage(slice.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, pw, slice.height / pxPerPt);
    }
    const b64 = pdf.output('datauristring').split(',')[1];
    await AffordDevice.shareFile({ filename, base64: b64, mime: 'application/pdf', title: t('Share PDF') });
  } finally {
    host.remove();
  }
}

export async function shareCsv(text, filename) {
  await AffordDevice.shareFile({ filename, text, mime: 'text/csv', title: t('Share CSV') });
}

/** Final settlement letter */
export async function settlementDoc(x, storeName, currency, contact) {
  const a = await assets();
  const rtl = getLang() === 'ur';
  const st = x.statement;
  const e = st.employee;
  const cur = currency || st.currency || 'Rs.';
  const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
  const body = `<div class="doc">
  ${header(a, storeName, t('Final settlement'), `${esc(t('Date'))}: ${esc(fmtDateTime(st.generatedAt))}`, contact)}
  <div class="grid">${kv(t('Employee'), `${e.name} (${e.code})`)}${kv(t('Role'), e.role || '')}${kv(t('Last working day'), fmtDate(x.lastDay))}${kv(t('Monthly salary'), fmtMoney(st.salary, cur))}</div>
  <h2>${esc(t('Settlement'))}</h2>
  ${kv(t('Salary for {m} (after cuts)', { m: fmtMonth(x.month) }), fmtMoney(st.net, cur))}
  ${x.laterAdvances ? kv(t('Advance installments still due'), `− ${fmtMoney(x.laterAdvances, cur)}`) : ''}
  ${x.alreadyPaid ? kv(t('Already paid for this month'), `− ${fmtMoney(x.alreadyPaid, cur)}`) : ''}
  ${kv(t('Security deposit returned'), `+ ${fmtMoney(x.depositBalance, cur)}`)}
  <div class="net"><span>${esc(x.total >= 0 ? t('Amount to pay the employee') : t('Amount the employee owes'))}</span><b>${esc(fmtMoney(Math.abs(x.total), cur))}</b></div>
  <p class="muted" style="margin-top:14px">${esc(t('All dues between the store and the employee are cleared with this payment.'))}</p>
  <div class="foot">${receivedBy(st)}${authorisedBy(st)}</div>
  </div>`;
  return { body, css: CSS(a, rtl), title: `${e.name} settlement` };
}
