// elektrik_guvence.js — Sözleşme başına tarihli güvence bedeli (depozito / teminat) geçmişi
//
// Ayar dosyasında (elektrik_firma_ayar.json): guvenceGecmis: { sozlesmeNo: [{ tarih, tutar, not }] }
//   tarih: 'YYYY-MM-DD' geçerlilik başlangıcı · null: başlangıçtan beri (tarihi bilinmeyen ilk yatırılan)
// Eski biçim (guvence: { sozlesmeNo: tutar }) tarihsiz tek kayıt sayılır.
// Bir fatura dönemine (YYYY-MM) o ayın son gününe kadar başlamış EN SON kayıt uygulanır.

// Türkçe (12.500,50) ve noktalı ondalık (12500.50) yazımı okunur; tutar kuruşa (2 hane) yuvarlanır
function sayi(t) {
  if (typeof t === 'number') return Math.round(t * 100) / 100;
  const s = String(t == null ? '' : t).trim().replace(/\s|TL/gi, '');
  if (!s) return NaN;
  const n = s.includes(',') ? parseFloat(s.split('.').join('').replace(',', '.')) : /^-?\d+\.\d{1,2}$/.test(s) ? parseFloat(s) : parseFloat(s.split('.').join(''));
  return Math.round(n * 100) / 100;
}

function liste(ayar, no) {
  const l = ((ayar && ayar.guvenceGecmis) || {})[no]
    || (((ayar && ayar.guvence) || {})[no] != null ? [{ tarih: null, tutar: +ayar.guvence[no] }] : []);
  return l.map(g => ({ ...g, tutar: sayi(g.tutar) })).sort((x, y) => String(x.tarih || '').localeCompare(String(y.tarih || '')));
}
const guncel = l => l.length ? l[l.length - 1].tutar : null;
function donemde(l, donem) {
  let t = null;
  for (const g of l) if (!g.tarih || g.tarih <= donem + '-31') t = g.tutar;
  return t;
}
// Arayüzden gelen listeyi temizler: geçersiz tutarlı satır atılır, aynı tarih bir kez tutulur (son yazılan)
function temizle(l) {
  const m = new Map();
  for (const g of Array.isArray(l) ? l : []) {
    const tutar = sayi(g && g.tutar);
    if (!isFinite(tutar)) continue;
    const tarih = /^\d{4}-\d{2}-\d{2}$/.test(String(g.tarih || '')) ? g.tarih : null;
    const not = String((g && g.not) || '').trim();
    m.set(tarih, { tarih, tutar, ...(not ? { not } : {}) });
  }
  return [...m.values()].sort((x, y) => String(x.tarih || '').localeCompare(String(y.tarih || '')));
}
const bicimle = l => l.map(g => (g.tarih ? g.tarih.split('-').reverse().join('.') : 'başlangıçtan') + ': ' + Number(g.tutar).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })).join(' · ');

module.exports = { liste, guncel, donemde, temizle, bicimle, sayi };
