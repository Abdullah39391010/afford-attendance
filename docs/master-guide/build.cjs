// Builds the master guide PDF: node docs/master-guide/build.cjs [out.pdf]
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..', '..');
const b64 = (f, mime) => `data:${mime};base64,${fs.readFileSync(path.join(root, f)).toString('base64')}`;
(async () => {
  let html = fs.readFileSync(path.join(__dirname, 'guide.html'), 'utf8')
    .replace('{{LOGO}}', b64('assets/logo-2026-original.jpg', 'image/jpeg'))
    .replace('{{FONT400}}', b64('assets/fonts/noto-naskh-arabic-arabic-400-normal.woff2', 'font/woff2'))
    .replace('{{FONT700}}', b64('assets/fonts/noto-naskh-arabic-arabic-700-normal.woff2', 'font/woff2'));
  const out = process.argv[2] || path.join(__dirname, 'Afford-Attendance-Master-Guide.pdf');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: out, format: 'A4', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: '<div style="width:100%;font-size:8px;color:#888;padding:0 15mm;display:flex;justify-content:space-between"><span>Afford Super Store · Attendance &amp; Payroll · Master Guide</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
  });
  await browser.close();
  console.log(out);
})();
