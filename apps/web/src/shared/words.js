// Amounts in words for payslips, Pakistani style (thousand, lakh, crore), in English or Urdu.

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

// Urdu has its own word for every number from 1 to 99
const UR99 = ('ایک دو تین چار پانچ چھ سات آٹھ نو دس گیارہ بارہ تیرہ چودہ پندرہ سولہ سترہ اٹھارہ انیس بیس '
  + 'اکیس بائیس تئیس چوبیس پچیس چھبیس ستائیس اٹھائیس انتیس تیس اکتیس بتیس تینتیس چونتیس پینتیس چھتیس سینتیس اڑتیس انتالیس چالیس '
  + 'اکتالیس بیالیس تینتالیس چوالیس پینتالیس چھیالیس سینتالیس اڑتالیس انچاس پچاس اکاون باون ترپن چون پچپن چھپن ستاون اٹھاون انسٹھ ساٹھ '
  + 'اکسٹھ باسٹھ ترسٹھ چونسٹھ پینسٹھ چھیاسٹھ سڑسٹھ اڑسٹھ انہتر ستر اکہتر بہتر تہتر چوہتر پچھتر چھہتر ستتر اٹھہتر اناسی اسی '
  + 'اکیاسی بیاسی تراسی چوراسی پچاسی چھیاسی ستاسی اٹھاسی نواسی نوے اکانوے بانوے ترانوے چورانوے پچانوے چھیانوے ستانوے اٹھانوے ننانوے').split(' ');

const en99 = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));
const ur99 = (n) => UR99[n - 1] || '';

function spell(n, ur) {
  const w99 = ur ? ur99 : en99;
  const parts = [];
  const unit = [[10000000, ur ? 'کروڑ' : 'crore'], [100000, ur ? 'لاکھ' : 'lakh'], [1000, ur ? 'ہزار' : 'thousand'], [100, ur ? 'سو' : 'hundred']];
  for (const [size, name] of unit) {
    const q = Math.floor(n / size);
    if (q) { parts.push(`${size === 10000000 && q > 99 ? spell(q, ur) : w99(q)} ${name}`); n %= size; }
  }
  if (n) parts.push(w99(n));
  return parts.join(' ');
}

/** 24502 → "Twenty-four thousand five hundred two rupees only" / "چوبیس ہزار پانچ سو دو روپے" */
export function amountWords(amount, ur = false) {
  const n = Math.round(Math.abs(Number(amount) || 0));
  if (!n) return ur ? 'صفر روپے' : 'Zero rupees';
  const s = spell(n, ur);
  return ur ? `صرف ${s} روپے` : `${s.charAt(0).toUpperCase()}${s.slice(1)} rupees only`;
}
