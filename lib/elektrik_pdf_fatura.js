// elektrik_pdf_fatura.js — CK Akdeniz e-fatura PDF'inden gerçek fatura değerlerini okur (pdf-parse metni).
//
// Satır biçimleri (pdf-parse sütunları boşluksuz birleştirir, ondalık hane sayısı ayırt eder):
//   Fatura detayı:  "<Kalem><miktar ,3 hane><birim ,6 hane><bedel ,2 hane>"  ör. "Güç Bedeli2.000,00089,147520178.295,04"
//   Diğer kalemler: "<Kalem><miktar ,2 hane><tutar ,2 hane>"                  ör. "Güvence Bedeli0,00181.315,22"
//   Özet:           "Fatura Tutarı   412.129,34TL" · "KDV (Matrah 343.442,92)68.688,58" · "Elekt Ver. Hvgz Tük. Ver6.323,76"
// Eksi miktarlı / eksi tutarlı kalemler (ör. "Enerji Bedeli (Ek) -496,860 kWh", "Dağıtım Bedeli -1.063,77") faturadan
// düşülen kalemlerdir; GES tesislerinde mahsup edilen enerji burada görünür.
const sayi = s => s == null ? null : +String(s).replace(/\./g, '').replace(',', '.');
const yuv = v => v == null ? null : Math.round(v * 100) / 100;

function cozumle(metin) {
  // PDF'teki boşluklar bölünemez boşluk (U+00A0); normal boşluğa çevrilir
  const S = String(metin || '').replace(/ /g, ' ').split('\n').map(x => x.trim()).filter(Boolean);
  const bul = re => { for (const x of S) { const m = re.exec(x); if (m) return m; } return null; };
  const r = { kalemler: [], diger: [] };
  let m;
  if ((m = bul(/^Fatura Sıra No:\s*(\S+)/))) r.faturaNo = m[1];
  if ((m = bul(/^Fatura Dönemi:.*?(\d{2})-(\d{4})\s*$/))) r.donem = m[2] + '-' + m[1];
  if ((m = bul(/^Okuma Günü(\d{2}-\d{2}-\d{4})(\d{2}-\d{2}-\d{4})(\d+)$/))) { r.ilkOkuma = m[1]; r.sonOkuma = m[2]; r.gun = +m[3]; }
  const i = S.findIndex(x => /^Fatura Detayı/.test(x)), j = S.findIndex((x, k) => k > i && /^Okuma Bilgisi/.test(x));
  // Kalem adı bazen iki satıra bölünür ("Enerji Bedeli-Yüksek" / "Kademe" / "4.076,9865,934055…"): sayısız satırlar
  // bir sonraki sayı satırının adına eklenir. Sayılar rakamla başlamalı ("4.076,986" → "4" + "76,986" diye bölünmesin).
  let bekleyen = '';
  if (i >= 0) for (const x of S.slice(i + 2, j < 0 ? i + 30 : j)) {
    const k = /^(.*?)(-?\d[\d.]*,\d{3})(-?\d[\d.]*,\d{6})(-?\d[\d.]*,\d{2})$/.exec(x);
    if (k) {
      const ad = (bekleyen + ' ' + k[1]).trim() || 'Enerji Bedeli';
      bekleyen = '';
      r.kalemler.push({ ad, miktar: sayi(k[2]), birim: sayi(k[3]), tutar: sayi(k[4]), birimi: /güç/i.test(ad) ? 'kW' : 'kWh' });
    } else if (!/\d,\d/.test(x)) bekleyen = (bekleyen + ' ' + x).trim();
  }
  // Sayaç okuması: "Tek Zamanlı<ilk endeks><son endeks><fark kWh>" (üçü de 3 ondalıklı; fark çarpanla çarpılmış kWh)
  if ((m = bul(/^Tek Zamanlı(\d+\.\d{3})(\d+\.\d{3})(\d+\.\d{3})$/))) { r.ilkEndeks = +m[1]; r.sonEndeks = +m[2]; r.okumaKwh = +m[3]; }
  const a = S.findIndex(x => /^Toplam Enerji Bedeli/.test(x)), b = S.findIndex((x, k) => k > a && /^Diğer Bilgiler/.test(x));
  if (a >= 0) for (const x of S.slice(a + 1, b < 0 ? a + 15 : b)) {
    let k = /^(Güncel|Önceki) Yuvarlama(-?[\d.]+)$/.exec(x);
    if (k) { r.diger.push({ ad: k[1] + ' yuvarlama', tutar: +k[2] }); continue; }
    k = /^(.+?)(-?[\d.]*\d,\d{2})(-?[\d.]*\d,\d{2})$/.exec(x);
    if (k) r.diger.push({ ad: k[1].trim(), miktar: sayi(k[2]), tutar: sayi(k[3]) });
  }
  if ((m = bul(/^Fatura Tutarı\s+(-?[\d.]+,\d{2})\s*TL/))) r.faturaTutari = sayi(m[1]);
  else {
    // Tutar 1 milyonu geçince rakam bir alt satıra kayar: "Fatura Tutarı" / "1.299.401,00TL"
    const t = S.findIndex(x => /^Fatura Tutarı$/.test(x)), k = t >= 0 && /^(-?[\d.]+,\d{2})\s*TL$/.exec(S[t + 1] || '');
    if (k) r.faturaTutari = sayi(k[1]);
  }
  if ((m = bul(/^Elekt Ver\..*?Ver(-?[\d.]+,\d{2})$/))) r.etv = sayi(m[1]);
  if ((m = bul(/^KDV \(Matrah (-?[\d.]+,\d{2})\)(-?[\d.]+,\d{2})$/))) { r.kdvMatrah = sayi(m[1]); r.kdv = sayi(m[2]); }
  const o = S.findIndex(x => /^Ödenecek/.test(x));
  if (o >= 0) for (const x of S.slice(o + 1, o + 4)) { const k = /^(-?[\d.]+,\d{2})$/.exec(x); if (k) { r.odenecek = sayi(k[1]); break; } }
  if ((m = bul(/^Sözleşme Hesap No:\s*(\d+)/))) r.sozlesme = m[1];
  if ((m = bul(/^Tüketici Grubu:\s*(.+)$/))) r.tuketiciGrubu = m[1].trim();
  if ((m = bul(/^Tüketici Sınıfı:\s*(.+)$/))) r.tuketiciSinifi = m[1].trim();
  if ((m = bul(/^Çarpan\/Demand\/Anl\.Gücü([\d.]+)\/([\d.]+)\/([\d.]+)/))) { r.carpan = +m[1]; r.demand = +m[2]; r.anlasmaGucu = +m[3]; }
  // Tüketim: pozitif enerji kalemleri (trafo kaybı hariç)
  const enerji = r.kalemler.filter(k => /Enerji Bedeli/i.test(k.ad) && k.miktar > 0);
  r.tuketimKwh = enerji.length ? yuv(enerji.reduce((t, k) => t + k.miktar, 0)) : null;
  // Düşülen kalemler: eksi miktar / eksi tutar ya da adında mahsup / veriş / ihtiyaç fazlası geçenler (yuvarlama hariç)
  r.dusulen = [...r.kalemler, ...r.diger].filter(k => !/yuvarlama/i.test(k.ad) && (k.tutar < 0 || k.miktar < 0 || /mahsup|veriş|ihtiyaç fazlası/i.test(k.ad)));
  r.dusulenKwh = yuv(r.kalemler.filter(k => k.miktar < 0 && k.birimi === 'kWh').reduce((t, k) => t + k.miktar, 0)) || null;
  r.dusulenTL = yuv(r.dusulen.reduce((t, k) => t + (k.tutar || 0), 0)) || null;
  // Uygulamanın hesabında olmayan kalemler: güvence bedeli (KDV'siz), güç bedeli ve trafo kaybı (KDV'li)
  const top = re => yuv([...r.kalemler, ...r.diger].filter(k => re.test(k.ad)).reduce((t, k) => t + (k.tutar || 0), 0)) || 0;
  r.guvence = top(/güvence/i); r.gucBedeli = top(/güç bedeli/i); r.trafoKaybi = top(/trafo kayb/i);
  r.okundu = !!(r.faturaTutari || r.odenecek);
  return r;
}

module.exports = { cozumle };
