// Printable documents (salary statement, reports) with the logo, in English or Urdu.
// Print uses Android's own print dialog (which also offers "Save as PDF"); Share builds a PDF file.
import { AffordDevice } from 'afford-device';
import { t, getLang, statusLabel, moneyLabel } from './i18n.js';
import { fmtMoney, fmtMoney2, fmtTime, fmtDate, fmtMonth, fmtDur, fmtDateTime } from './format.js';
import { amountWords } from './words.js';

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

// ---------------------------------------------------------------- payslip: design 3B "Afford red official"
const SLIP_CSS = (rtl) => `
.ps{color:#1d1e22;font-size:12.5px}
.ps .frame{border:2px solid #C62032;min-height:1051px;display:flex;flex-direction:column}
.ps .phd{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:4px solid #C62032}
.ps .phd img{height:54px;width:auto}
.ps .phd .r{text-align:end}.ps .phd h1{margin:0;font-size:${rtl ? 24 : 23}px;color:#C62032;letter-spacing:${rtl ? 0 : 3}px}.ps .phd .r div{font-size:12px;color:#555}
.ps .strip{display:flex;justify-content:space-between;gap:10px;background:#1d1e22;color:#fff;font-size:11.5px;padding:6px 18px}
.ps .idc{display:flex;margin:14px 18px 0;border:1px solid #e3c4c8;border-radius:10px;overflow:hidden}
.ps .idc .p{background:#FBEFF0;padding:12px 14px;display:flex;flex-direction:column;align-items:center;gap:6px;font-size:11px;color:#C62032;font-weight:700;flex:none}
.ps .ph{width:84px;height:84px;border-radius:50%;border:3px solid #C62032;padding:3px;background:#fff}
.ps .ph img,.ps .ph div{width:100%;height:100%;border-radius:50%;object-fit:cover;display:flex;align-items:center;justify-content:center;background:#C62032;color:#fff;font-size:26px;font-weight:700;font-family:system-ui,Arial,sans-serif}
.ps .idc table{flex:1}.ps .idc td{border:0;border-bottom:1px solid #f0e2e4;padding:7px 10px}.ps .idc tr:last-child td{border-bottom:0}
.ps .k{color:#888;width:20%}.ps .v{font-weight:600}
.ps .att{display:grid;grid-template-columns:repeat(6,1fr);border:1px solid #e1d3d5;margin:12px 18px 0}
.ps .att div{text-align:center;padding:7px 4px;font-size:11px;color:#666;border-inline-end:1px solid #e1d3d5}.ps .att div:last-child{border:0}
.ps .att b{display:block;font-size:16px;color:#1d1e22;font-family:system-ui,Arial,sans-serif}
.ps .tw{margin:12px 18px 0}
.ps .pt th,.ps .pt td{border:1px solid #e1d3d5;padding:6px 9px}
.ps .pt th{background:#C62032;color:#fff;font-size:11px;letter-spacing:${rtl ? 0 : 1}px;text-transform:uppercase}
.ps .pt .tot td{font-weight:800;background:#FBEFF0}
.ps .net{margin:12px 18px 0;display:flex;border:2px solid #C62032}
.ps .net .l{padding:9px 14px;flex:1}.ps .net .l div{font-weight:800;color:#C62032;letter-spacing:${rtl ? 0 : 1.5}px;font-size:12px}.ps .net i{font-size:12px;color:#444}
.ps .net b{background:#C62032;color:#fff;font-size:25px;padding:0 22px;display:flex;align-items:center;font-family:system-ui,Arial,sans-serif;white-space:nowrap}
.ps .lines{margin:8px 18px 0;font-size:11.5px;color:#444}.ps .lines div{padding:2px 0}
.ps .warn{margin:8px 18px 0;background:#FFF1D6;color:#7a4a00;padding:6px 10px;font-size:11.5px;font-weight:600}
.ps .grow{flex:1;min-height:20px}
.ps .pfoot{padding:16px 18px;display:flex;justify-content:space-between;align-items:flex-end;font-size:11px;color:#555}
.ps .sigbox{width:190px;text-align:center}.ps .sig{border-top:1px solid #1d1e22;padding-top:5px;width:auto}
.ps .seal{width:100px;height:100px;border-radius:50%;border:3px double #C62032;color:#C62032;display:flex;align-items:center;justify-content:center;text-align:center;transform:rotate(-12deg);flex:none}
.ps .seal small{display:block;font-size:6.5px;font-weight:700;letter-spacing:.5px;max-width:74px;margin:0 auto;font-family:system-ui,Arial,sans-serif}
.ps .seal b{display:block;font-size:${rtl ? 16 : 19}px;letter-spacing:${rtl ? 0 : 3}px;margin:3px 0;border-top:1.5px solid #C62032;border-bottom:1.5px solid #C62032}
.ps .seal.due{border-color:#999;color:#888}.ps .seal.due b{border-color:#999}
.ps .cg{text-align:center;font-size:10.5px;color:#777;padding-top:5px}
.ps .daily{margin-top:72px}.ps .daily h2{margin:0 0 8px}
@media print{.ps .frame{min-height:1000px}.ps .daily{margin-top:0;break-before:page}}
`;

export async function statementDoc(st) {
  const a = await assets();
  const rtl = getLang() === 'ur';
  const e = st.employee;
  const cur = st.currency || 'Rs.';
  const c = st.counts;
  const name = (rtl && e.nameUr) || e.name;
  const role = (rtl && e.roleUr) || e.role || '';
  const neg = (v) => fmtMoney(v, cur);
  // earnings and deductions, only the lines that apply (salary, absent and late are always shown)
  const earn = [
    [t('Monthly salary'), st.salary],
    st.bonus ? [t('Bonus'), st.bonus] : null,
    st.commission ? [t('Commission'), st.commission] : null,
    st.holidayPay ? [t('Holiday work pay ({n} days)', { n: c.holidayWorked }), st.holidayPay] : null,
    st.overtime?.pay ? [t('Overtime ({m} min × {r})', { m: st.overtime.min, r: st.overtime.rate }), st.overtime.pay] : null,
  ].filter(Boolean);
  const ded = [
    [t('Absent cut'), st.cuts.absent, true],
    [t('Unpaid leave cut'), st.cuts.leaveUnpaid],
    [t('Before joining'), st.cuts.notJoined],
    [t('After leaving'), st.cuts.left],
    [t('Late cut'), st.cuts.late, true],
    [t('Early leave cut'), st.cuts.early],
    [t('Late break cut'), st.cuts.breakLate],
    [t('Short leave cut ({n}×)', { n: c.shortLeaveOver || 0 }), st.cuts.shortLeave],
    [t('Advances'), st.advances],
    [t('Security deposit cut'), st.depositCut],
    [t('Fines'), st.fines],
  ].filter(([, v, always]) => always || v);
  const gross = earn.reduce((s, x) => s + (Number(x[1]) || 0), 0);
  const dtot = ded.reduce((s, x) => s + (Number(x[1]) || 0), 0);
  const n = Math.max(earn.length, ded.length);
  const rowsED = Array.from({ length: n }, (_, i) => `<tr><td>${esc(earn[i]?.[0] || '')}</td><td class="n">${earn[i] ? esc(fmtMoney(earn[i][1], cur)) : ''}</td><td>${esc(ded[i]?.[0] || '')}</td><td class="n">${ded[i] ? esc(neg(ded[i][1])) : ''}</td></tr>`).join('');

  const ini = String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const photo = e.photo && /^data:image\/(png|jpeg|webp);base64,/.test(e.photo) ? `<img src="${e.photo}" alt="">` : `<div>${esc(ini)}</div>`;
  const kvRow = (k1, v1, k2, v2) => `<tr><td class="k">${esc(k1)}</td><td class="v">${esc(v1)}</td><td class="k">${esc(k2)}</td><td class="v">${esc(v2)}</td></tr>`;
  const att = [
    [t('Present'), c.present], [t('Late'), c.lateMin ? `${c.late} (${c.lateMin} ${t('min')})` : c.late], [t('Absent'), c.absent],
    [t('Leave'), st.leave.paid + st.leave.unpaid], [t('Off days'), c.off + c.holiday], st.overtime?.min ? [t('Overtime'), `${st.overtime.min} ${t('min')}`] : [t('Out-of-town duty'), c.duty],
  ];
  const paid = (st.payments || []).length > 0;
  const extras = (st.money || []).filter((m) => ['bonus', 'commission', 'fine'].includes(m.kind) && m.note);
  const status = st.complete ? '' : t('Month in progress (so far)');
  const dailyRows = st.days.filter((d) => d.status !== 'future').map((d) => `<tr>
    <td>${esc(fmtDate(d.date))}</td><td><span class="st st-${d.status}">${esc(statusLabel(d.status))}</span></td>
    <td class="n">${d.checkIn ? esc(fmtTime(d.checkIn)) : ''}</td><td class="n">${d.checkOut ? esc(fmtTime(d.checkOut)) : ''}</td>
    <td class="n">${d.workedMin ? esc(fmtDur(d.workedMin)) : ''}</td><td class="n">${d.lateMin || ''}</td><td class="n">${d.earlyMin || ''}</td>
    <td class="n">${d.cut ? esc(fmtMoney2(d.cut, '')) : ''}</td></tr>`).join('');

  const body = `<div class="doc ps"><div class="frame">
  <div class="phd"><img src="${a.logo}" alt=""><div class="r"><h1>${esc(t('SALARY SLIP'))}</h1><div>${esc(fmtMonth(st.month))}</div></div></div>
  <div class="strip"><span>${esc([st.storeName, st.storeAddress, st.storePhone].filter(Boolean).join(' · '))}</span><span>${esc(t('Payslip no.'))} <b>${esc(st.slipNo || '')}</b></span></div>
  <div class="idc"><div class="p"><div class="ph">${photo}</div>${esc(e.code)}</div><table>
    ${kvRow(t('Employee'), name, t('Designation'), role)}
    ${kvRow(t('Shift'), e.shift ? `${e.shift.name} ${e.shift.start}–${e.shift.end}` : '', t('Joining date'), e.joinDate ? fmtDate(e.joinDate) : '—')}
    ${kvRow(t('Days basis'), `${st.basisDays} (${fmtMoney2(st.rates.daily, cur)} / ${t('day')})`, t('Blood group'), e.bloodGroup || '—')}
  </table></div>
  <div class="att">${att.map(([k, v]) => `<div><b>${esc(v)}</b>${esc(k)}</div>`).join('')}</div>
  <div class="tw"><table class="pt"><thead><tr><th>${esc(t('Earnings'))}</th><th class="n">${esc(t('Amount'))}</th><th>${esc(t('Deductions'))}</th><th class="n">${esc(t('Amount'))}</th></tr></thead><tbody>${rowsED}
  <tr class="tot"><td>${esc(t('Gross earnings'))}</td><td class="n">${esc(fmtMoney(gross, cur))}</td><td>${esc(t('Total deductions'))}</td><td class="n">${esc(neg(dtot))}</td></tr></tbody></table></div>
  <div class="net"><div class="l"><div>${esc(t('NET SALARY PAYABLE'))}</div><i>${esc(amountWords(st.net, rtl))}</i></div><b>${esc(fmtMoney(st.net, cur))}</b></div>
  ${status ? `<div class="warn">${esc(status)}</div>` : ''}
  <div class="lines">
    ${(st.payments || []).map((p) => `<div>${esc(t('Paid by'))}: <b>${esc(t({ cash: 'Cash', bank: 'Bank transfer', other: 'Other' }[p.method] || p.method))} · ${esc(fmtDateTime(p.ts))}</b> · ${esc(fmtMoney(p.amount, cur))}</div>`).join('')}
    ${extras.map((m) => `<div>${esc(moneyLabel(m.kind))} · ${esc(m.note)}: <b>${m.kind === 'fine' ? '− ' : '+ '}${esc(fmtMoney(m.amount, cur))}</b></div>`).join('')}
    ${st.depositBalance ? `<div>${esc(t('Security deposit balance'))}: <b>${esc(fmtMoney(st.depositBalance, cur))}</b></div>` : ''}
    <div>${esc(t('Generated'))}: ${esc(fmtDateTime(st.generatedAt))}${st.locked ? ` · ${esc(t('Locked. Salary is final.'))}` : ''}</div>
  </div>
  <div class="grow"></div>
  <div class="pfoot">${receivedBy(st)}
    <div class="seal${paid ? '' : ' due'}"><div><small>${esc(String(st.storeName || '').toUpperCase())}</small><b>${esc(paid ? t('PAID') : t('NOT PAID'))}</b><small>${esc(fmtMonth(st.month).toUpperCase())}</small></div></div>
    ${authorisedBy(st)}</div>
  </div>
  <div class="cg">${esc(t('This is a computer generated payslip.'))}</div>
  <div class="daily"><h2>${esc(t('Daily record'))} · ${esc(fmtMonth(st.month))}</h2>
  <table><thead><tr><th>${esc(t('Date'))}</th><th>${esc(t('Status'))}</th><th class="n">${esc(t('In'))}</th><th class="n">${esc(t('Out'))}</th><th class="n">${esc(t('Hours'))}</th><th class="n">${esc(t('Late'))}</th><th class="n">${esc(t('Early'))}</th><th class="n">${esc(t('Cut'))}</th></tr></thead><tbody>${dailyRows}</tbody></table></div>
  </div>`;
  return { body, css: CSS(a, rtl) + SLIP_CSS(rtl), title: `${e.name} ${st.month}` };
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
export async function shareDocPdf(doc, filename, opts = {}) {
  const b64 = await docPdfBase64(doc);
  return AffordDevice.shareFile({ filename, base64: b64, mime: 'application/pdf', title: t('Share PDF'), ...opts });
}

/** The document as a PDF file (base64). */
export async function docPdfBase64(doc) {
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
    return pdf.output('datauristring').split(',')[1];
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
