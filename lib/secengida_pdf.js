// secengida_pdf.js — SECENGIDA fatura PDF'lerini okur: türü (CK Akdeniz · Antalya OSB · ANT Trafo) metinden tanır,
// her birini ortak "okunan" özetine çevirir (lib/elektrik_pdf_fatura.js ile aynı alanlar + kaynak, sozlesme, lokasyon, osb).
//
// pdf-parse sütunları boşluksuz birleştirir: "3527,6703487,2603150190906,060…". Sayı dizileri kalıpla (ondalık hane
// sayıları) ve sağlama ile çözülür: bütün olası bölünmeler denenir, sağlamayı geçen ilk çözüm alınır.
const CK = require('./elektrik_pdf_fatura.js');

const sayi = s => s == null ? null : +String(s).replace(/\./g, '').replace(',', '.');
const yuv = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
const AYLAR = { OCAK: 1, 'ŞUBAT': 2, MART: 3, 'NİSAN': 4, 'MAYIS': 5, HAZİRAN: 6, TEMMUZ: 7, 'AĞUSTOS': 8, 'EYLÜL': 9, EKİM: 10, 'KASIM': 11, 'ARALIK': 12 };
const iki = n => String(n).padStart(2, '0');

// Kalıplar: e3 = 3 ondalıklı, d6 = 6 ondalıklı, t2 = binlik noktalı 2 ondalıklı, n = tam sayı. Tümü eksi olabilir.
const KALIP = {
  e3: /^-?\d+,\d{3}/, d6: /^-?\d+,\d{6}/, t2: /^-?\d{1,3}(?:\.\d{3})*,\d{2}/, n: /^\d+/,
};
function bol(metin, kaliplar, sagla) {
  const sonuc = [];
  (function dene(kalan, i, acc) {
    if (sonuc.length) return;
    if (i === kaliplar.length) { if (!kalan && (!sagla || sagla(acc))) sonuc.push(acc); return; }
    const k = kaliplar[i], m = KALIP[k].exec(kalan);
    if (!m) return;
    // Ondalıklı sayının tam kısmı virgüle kadardır (önceki sayının ondalığı sabit olduğundan başı da bellidir).
    // Belirsizlik yalnız tam sayıda (n) doğar: arkasındaki sayının tam kısmına taşabilir, bütün uzunluklar denenir.
    if (k === 'n') { for (let L = m[0].length; L >= 1; L--) dene(kalan.slice(L), i + 1, [...acc, +m[0].slice(0, L)]); return; }
    dene(kalan.slice(m[0].length), i + 1, [...acc, sayi(m[0])]);
  })(metin, 0, []);
  return sonuc[0] || null;
}

// ─── Antalya OSB (elektrik dağıtım + perakende) ─────────────────────────────────────────────────────────
function osbCoz(S) {
  const r = { kaynak: 'OSB', tedarikci: 'Antalya OSB', kalemler: [], diger: [], uyarilar: [] };
  const bul = re => { for (const x of S) { const m = re.exec(x); if (m) return m; } return null; };
  const sonraki = re => { const i = S.findIndex(x => re.test(x)); return i >= 0 ? S[i + 1] : null; };
  let m;
  if ((m = bul(/^(OSB\d{10,16})$/))) r.faturaNo = m[1];
  if ((m = bul(/FATURA DÖNEMİ([A-ZÇĞİÖŞÜ]+)\/(\d{4})/))) r.donem = m[2] + '-' + iki(AYLAR[m[1]]);
  const tarih = re => { const k = bul(re); return k ? k[1].split('.').join('-') : null; };
  r.ilkOkuma = tarih(/İLK OKUMA TARİHİ(\d{2}\.\d{2}\.\d{4})/); r.sonOkuma = tarih(/SON OKUMA TARİHİ(\d{2}\.\d{2}\.\d{4})/);
  r.faturaTarihi = tarih(/FATURA TARIHI(\d{2}\.\d{2}\.\d{4})/); r.sonOdeme = tarih(/SON ÖDEME TARIHI(\d{2}\.\d{2}\.\d{4})/);
  if (r.ilkOkuma && r.sonOkuma) { const g = s => new Date(s.split('-').reverse().join('-') + 'T00:00:00Z'); r.gun = Math.round((g(r.sonOkuma) - g(r.ilkOkuma)) / 864e5); }
  if ((m = bul(/ABONE NO(\d+)/))) r.aboneNo = m[1];
  r.sozlesme = 'AOSB-' + (r.aboneNo || '?');
  if ((m = bul(/ETSO KOD:(\w{16})/))) r.etso = m[1];
  if ((m = bul(/^TARİFE GRUBU(.+?)FATURA NO/))) r.tuketiciGrubu = m[1].trim();
  r.tuketiciSinifi = 'Antalya OSB · ' + ((bul(/^ABONE GRUBU(\S+?)ABONE NO/) || [])[1] || '');
  // Sayaç seri no sağdaki 4 satırda (SÖZ.GUCU / A.TRF / G.TRF / ÇARPAN) değerin hemen arkasında yazılı: ortak sonek
  const sat = ['SÖZ.GUCU.(kW))', 'A.TRF.ORANI', 'G.TRF.ORANI', 'ÇARPAN'].map(a => { const x = S.find(s => s.startsWith(a)); return x ? /^\D+\)*(\d+)/.exec(x.slice(a.length - 1))[1] : ''; });
  let seri = '';
  if (sat.every(Boolean)) { const a = sat[0]; for (let L = 1; L < a.length; L++) { const sf = a.slice(-L); if (sat.every(x => x.endsWith(sf) && x.length > L)) seri = sf; } }
  const deger = i => seri && sat[i] ? +sat[i].slice(0, -seri.length) : null;
  r.sayacSeri = seri || null; r.sozlesmeGucu = deger(0); r.akimTrafo = deger(1); r.gerilimTrafo = deger(2); r.carpan = deger(3);
  r.anlasmaGucu = r.sozlesmeGucu;
  if ((m = bul(/^KUR\.GUC\.\(kVA\)(\d+)/))) r.kuruluKva = +m[1];
  if ((m = bul(/^KUR\.GUC\(kWe\)(\d+)/))) r.uretimKwe = +m[1];
  const C = r.carpan || 1;
  const okuma = (son, ilk) => Math.round((son - ilk) * C * 1000) / 1000;

  // Aktif tüketim: son endeks · ilk endeks · çarpan · tüketim · (+/-) ilave · toplam · birim · tutar
  const ak = sonraki(/^Aktif$/);
  const A = ak && bol(ak, ['e3', 'e3', 'n', 'e3', 'e3', 'e3', 'd6', 't2'], a => a[2] === C && Math.abs(a[5] * a[6] - a[7]) <= Math.max(2, a[7] * 0.001));
  if (A) {
    r.aktif = { sonEndeks: A[0], ilkEndeks: A[1], carpan: A[2], tuketim: A[3], ilave: A[4], toplam: A[5], birim: A[6], tutar: A[7], okuma: okuma(A[0], A[1]) };
    r.kalemler.push({ ad: 'Aktif enerji (SKTT)', miktar: A[5], birim: A[6], tutar: A[7], birimi: 'kWh' });
    r.okumaKwh = r.aktif.okuma;
    if (A[4]) r.uyarilar.push('Sayaçla ölçülemeyen ' + A[4].toLocaleString('tr-TR') + ' kWh tahmini (ilave) tüketim faturaya eklenmiş.');
  }
  r.zaman = {};
  for (const z of ['Gündüz', 'Puant', 'Gece']) {
    const x = S.find(s => s.startsWith(z) && /\d/.test(s));
    const Z = x && bol(x.slice(z.length), ['e3', 'e3', 'n', 'e3', 'e3', 'd6', 't2'], a => a[2] === C);
    if (Z) r.zaman[z] = { sonEndeks: Z[0], ilkEndeks: Z[1], ilave: Z[3], kwh: Z[4], okuma: okuma(Z[0], Z[1]) };
  }
  const satirKalem = (re, ad) => {
    const x = S.find(s => re.test(s)); if (!x) return null;
    const K = bol(x.replace(re, ''), ['e3', 'd6', 't2']);
    if (!K) return null;
    const k = { ad, miktar: K[0], birim: K[1], tutar: K[2], birimi: 'kWh' };
    if (k.tutar) r.kalemler.push(k);
    return k;
  };
  r.fiyatFarki = satirKalem(/^Aktif enerji birim fiyat farkı \(\+\/-\)/, 'Aktif enerji birim fiyat farkı (önceki dönem)');
  r.uretimMahsup = satirKalem(/^Aktif enerji üretim bir önceki dönem \(\+\/-\)/, 'Aktif enerji üretim · bir önceki dönem (mahsup)');
  // Şebekeye veriş (2.8.0): son · ilk · çarpan · ilave · T.kaybı · veriş kWh · birim · tutar
  const ur = sonraki(/^Aktif \(2\.8\.0\)$/);
  const U = ur && bol(ur, ['e3', 'e3', 'n', 'e3', 'e3', 'e3', 'd6', 't2'], a => a[2] === C);
  if (U) r.veris = { sonEndeks: U[0], ilkEndeks: U[1], ilave: U[3], trafoKaybi: U[4], kwh: U[5], birim: U[6], tutar: U[7], okuma: okuma(U[0], U[1]) };
  // Maksimum demand (kW) = okunan değer × çarpan
  const dm = sonraki(/^Maks\. DemandÇarpan/);
  if (dm && /^Demand$/.test(dm)) { const x = S[S.findIndex(s => /^Maks\. DemandÇarpan/.test(s)) + 2]; const d = /^(\d+,\d{3})/.exec(x || ''); if (d) r.demand = Math.round(sayi(d[1]) * C * 100) / 100; }
  // Tüketime uygulanan bedeller: etiket satırı + "miktar · birim · tutar"
  r.bedeller = [];
  const BED = ['PAREKENDE SATIŞ HİZMET BEDELİ', 'İLETİM BEDELİ (TÜKETİM)', 'İLETİM BEDELİ SABİT (kW)', 'İLETİM BEDELİ (ÜRETİM)', 'İLETİM BEDELİ SABİT (kWe)', 'DAĞITIM SİSTEM KULLANIM BEDELİ (TÜKETİM)', 'DAĞITIM SİSTEM KULLANIM BEDELİ (ÜRETİM)', 'EMRE AMADE KAPASİTE BEDELİ'];
  for (const ad of BED) {
    const i = S.lastIndexOf(ad); if (i < 0) continue;
    const K = bol(S[i + 1] || '', ['e3', 'd6', 't2']);
    const b = { ad: ad.replace('PAREKENDE', 'PERAKENDE'), miktar: K ? K[0] : 0, birim: K ? K[1] : 0, tutar: K ? K[2] : 0, birimi: /SABİT \(kW\)/.test(ad) ? 'kW' : /kWe/.test(ad) ? 'kWe' : /EMRE/.test(ad) ? 'kVA' : 'kWh' };
    r.bedeller.push(b);
    if (b.tutar) r.kalemler.push(b);
  }
  // Reaktif: son · ilk · çarpan · ilave · T.kaybı · kVArh · birim · tutar
  r.reaktif = {};
  for (const [ad, re] of [['endüktif', /^ENDÜKTİF$/], ['kapasitif', /^KAPASİTİF$/]]) {
    const x = sonraki(re); const R = x && bol(x, ['e3', 'e3', 'n', 'e3', 'e3', 'e3', 'd6', 't2'], a => a[2] === C);
    if (R) { r.reaktif[ad] = { kvarh: R[5], okuma: okuma(R[0], R[1]), birim: R[6], tutar: R[7] }; if (R[7]) r.kalemler.push({ ad: 'Reaktif ' + ad, miktar: R[5], birim: R[6], tutar: R[7], birimi: 'kVArh' }); }
  }
  // Toplamlar: ilk TOPLAM enerji ara toplamı, ikinci TOPLAM KDV matrahı
  const toplamlar = S.map(s => /^TOPLAM([\d.]+,\d{2})$/.exec(s)).filter(Boolean).map(k => sayi(k[1]));
  r.enerjiAraToplam = toplamlar[0] ?? null; r.kdvMatrah = toplamlar[1] ?? toplamlar[0] ?? null;
  const tek = re => { const k = bul(re); return k ? sayi(k[1]) : 0; };
  r.etv = tek(/^E\.T\.V\.(-?[\d.]+,\d{2})$/); r.trtPayi = tek(/^TRT PAYI(-?[\d.]+,\d{2})$/); r.enerjiFonu = tek(/^ENERJI FONU(-?[\d.]+,\d{2})$/);
  r.gecikme = tek(/GECİKME BEDELİ(-?[\d.]+,\d{2})$/); r.indirim = tek(/^MUHTELİF İLAVE İNDİRİM(-?[\d.]+,\d{2})$/); r.baglanti = tek(/^BAĞLANTI BEDELİ(-?[\d.]+,\d{2})$/);
  for (const [ad, v] of [['Gecikme bedeli', r.gecikme], ['Muhtelif ilave indirim', r.indirim], ['Bağlantı bedeli', r.baglanti], ['TRT payı', r.trtPayi], ['Enerji fonu', r.enerjiFonu]]) if (v) r.diger.push({ ad, tutar: v });
  r.kdv = tek(/^K\.D\.V\.([\d.]+,\d{2})$/);
  r.faturaTutari = tek(/^FATURA TUTARI([\d.]+,\d{2})$/); r.odenecek = tek(/^ÖDENECEK TUTAR\(TL\)([\d.]+,\d{2})$/) || r.faturaTutari;
  // Önemli notlar (ör. "Gerilim Trafosu hasarı nedeniyle ölçülemeyen Tüketimi …")
  const n1 = S.findIndex(s => /^ÖNEMLI NOTLAR/.test(s)), n2 = S.findIndex((s, i) => i > n1 && /^KESME BAĞLAMA/.test(s));
  if (n1 >= 0 && n2 > n1) { const t = S.slice(n1 + 1, n2).join(' ').trim(); if (t) r.not = t; }

  r.tuketimKwh = r.aktif ? r.aktif.toplam : null;
  r.dusulen = r.uretimMahsup && r.uretimMahsup.tutar ? [r.uretimMahsup] : [];
  r.dusulenKwh = r.uretimMahsup && r.uretimMahsup.tutar ? -Math.abs(r.uretimMahsup.miktar) : null;
  r.dusulenTL = r.uretimMahsup && r.uretimMahsup.tutar ? r.uretimMahsup.tutar : null;
  r.guvence = 0; r.gucBedeli = 0; r.trafoKaybi = 0;
  r.kontrol = osbAritmetik(r);
  r.okundu = !!(r.faturaNo && r.odenecek && r.aktif);
  return r;
}
// Faturanın kendi içindeki sağlama: kalem tutarları, ara toplamlar, KDV %20, fatura tutarı
function osbAritmetik(r) {
  const k = [], ekle = (ad, beklenen, faturada, tol = 1) => k.push({ ad, beklenen: yuv(beklenen), faturada: yuv(faturada), fark: yuv(faturada - beklenen), tamam: Math.abs(faturada - beklenen) <= tol });
  if (r.aktif) {
    ekle('Aktif enerji = kWh × birim fiyat', r.aktif.toplam * r.aktif.birim, r.aktif.tutar, Math.max(1, r.aktif.tutar * 1e-5));
    ekle('Faturalanan kWh = endeks farkı × çarpan + ilave', r.aktif.okuma + r.aktif.ilave, r.aktif.toplam, Math.max(5, r.aktif.toplam * 0.002));
    const zt = Object.values(r.zaman || {}).reduce((s, z) => s + z.kwh, 0);
    if (zt) ekle('Gündüz + puant + gece = ölçülen kWh', zt, r.aktif.okuma, Math.max(5, zt * 0.002));
  }
  for (const b of [...(r.bedeller || []), r.fiyatFarki, r.uretimMahsup].filter(x => x && x.tutar)) ekle(b.ad + ' = miktar × birim', b.miktar * b.birim, b.tutar, Math.max(1, Math.abs(b.tutar) * 1e-5));
  const enerji = (r.aktif ? r.aktif.tutar : 0) + (r.fiyatFarki ? r.fiyatFarki.tutar : 0) + (r.uretimMahsup ? r.uretimMahsup.tutar : 0);
  if (r.enerjiAraToplam != null) ekle('Enerji ara toplamı', enerji, r.enerjiAraToplam);
  const bed = (r.bedeller || []).reduce((s, b) => s + b.tutar, 0) + Object.values(r.reaktif || {}).reduce((s, x) => s + x.tutar, 0);
  const diger = (r.diger || []).reduce((s, x) => s + x.tutar, 0);
  if (r.kdvMatrah != null) ekle('KDV matrahı = enerji + bedeller + vergiler', enerji + bed + (r.etv || 0) + diger, r.kdvMatrah);
  if (r.kdvMatrah != null) ekle('KDV %20', r.kdvMatrah * 0.2, r.kdv);
  if (r.kdvMatrah != null) ekle('Fatura tutarı = matrah + KDV', r.kdvMatrah + r.kdv, r.faturaTutari);
  return k;
}

// ─── ANT Trafo (trafo işletme sorumluluğu hizmeti) ──────────────────────────────────────────────────────
function antCoz(S, metin) {
  const r = { kaynak: 'ANT', tedarikci: 'ANT Trafo Elektrik Mühendislik A.Ş.', kalemler: [], diger: [], uyarilar: [] };
  const bul = re => { for (const x of S) { const m = re.exec(x); if (m) return m; } return null; };
  let m;
  if ((m = bul(/^Fatura No:\s*(ANT\d+)/))) r.faturaNo = m[1];
  if ((m = bul(/^Fatura Tarihi:\s*(\d{2})-(\d{2})-(\d{4})/))) { r.faturaTarihi = m[1] + '-' + m[2] + '-' + m[3]; r.donem = m[3] + '-' + m[2]; }
  // Hizmet açıklaması: "AĞUSTOS TRAFO İŞLETME SORUMLULUĞU AOSB 1.KISIM 2500 kVA BİNA" (satırlara bölünmüş olabilir)
  const tek = String(metin).replace(/ /g, ' ').replace(/\s+/g, ' ');
  if ((m = /Yalnız[^#]*#\s*([A-ZÇĞİÖŞÜ]+) (TRAFO[^\n]*?BİNA)/.exec(tek) || /([A-ZÇĞİÖŞÜ]+) (TRAFO İŞLETME[^.]*?BİNA)/.exec(tek))) {
    r.hizmet = (m[1] + ' ' + m[2]).trim();
    if (AYLAR[m[1]] && r.donem) r.donem = r.donem.slice(0, 4) + '-' + iki(AYLAR[m[1]]);
  }
  if ((m = /(\d+)\s*kVA/.exec(r.hizmet || tek))) r.kuruluKva = +m[1];
  r.sozlesme = 'ANT-TRAFO' + (r.kuruluKva ? '-' + r.kuruluKva : '');
  const tl = re => { const k = re.exec(tek); return k ? sayi(k[1]) : null; };
  r.kdvMatrah = tl(/Mal Hizmet Toplam Tutarı\s*([\d.]+,\d{2}) TL/);
  r.kdv = tl(/Hesaplanan KDV\(%\d+\)\s*([\d.]+,\d{2}) TL/);
  r.kdvOranYazili = (/Hesaplanan KDV\(%(\d+)\)/.exec(tek) || [])[1] ? +(/Hesaplanan KDV\(%(\d+)\)/.exec(tek))[1] / 100 : null;
  r.faturaTutari = tl(/Vergiler Dahil Toplam Tutar\s*([\d.]+,\d{2}) TL/);
  r.odenecek = tl(/Ödenecek Tutar\s*([\d.]+,\d{2}) TL/) || r.faturaTutari;
  if (r.kdvMatrah != null) r.kalemler.push({ ad: 'Trafo işletme sorumluluğu hizmet bedeli', miktar: 1, birim: r.kdvMatrah, tutar: r.kdvMatrah, birimi: 'ay' });
  r.tuketiciGrubu = 'Hizmet (trafo işletme sorumluluğu)'; r.tuketiciSinifi = 'kWh içermez';
  r.tuketimKwh = 0; r.etv = 0; r.guvence = 0; r.gucBedeli = 0; r.trafoKaybi = 0; r.dusulen = []; r.dusulenKwh = null; r.dusulenTL = null;
  r.kontrol = [];
  if (r.kdvMatrah != null && r.kdv != null) r.kontrol.push({ ad: 'KDV %20', beklenen: yuv(r.kdvMatrah * 0.2), faturada: r.kdv, fark: yuv(r.kdv - r.kdvMatrah * 0.2), tamam: Math.abs(r.kdv - r.kdvMatrah * 0.2) <= 0.05 });
  if (r.kdvMatrah != null && r.faturaTutari != null) r.kontrol.push({ ad: 'Toplam = matrah + KDV', beklenen: yuv(r.kdvMatrah + r.kdv), faturada: r.faturaTutari, fark: yuv(r.faturaTutari - r.kdvMatrah - r.kdv), tamam: Math.abs(r.faturaTutari - r.kdvMatrah - r.kdv) <= 0.05 });
  r.okundu = !!(r.faturaNo && r.odenecek);
  return r;
}

// ─── CK Akdeniz (görevli tedarik / son kaynak) ──────────────────────────────────────────────────────────
function ckCoz(S, metin) {
  const r = CK.cozumle(metin);
  r.kaynak = 'CK'; r.tedarikci = 'CK Akdeniz Elektrik Perakende Satış A.Ş.'; r.uyarilar = [];
  const bul = re => { for (const x of S) { const m = re.exec(x); if (m) return m; } return null; };
  let m;
  if ((m = bul(/^Tekil Kod\/Tesisat No:\s*(\d+)/))) r.tesisatNo = m[1];
  if ((m = bul(/^Etso Kodu:\s*(\w+)/))) r.etso = m[1];
  // Abonelik adresi: "Adres :" satırı ve devamı (TCKN/VKN satırına kadar)
  const a = S.findIndex(x => /^Adres\s*:/.test(x)), b = S.findIndex((x, i) => i > a && /^TCKN\/VKN/.test(x));
  if (a >= 0) r.adres = S.slice(a, b > a ? b : a + 1).join(' ').replace(/^Adres\s*:\s*/, '').replace(/\s+/g, ' ').trim();
  if ((m = bul(/(\d+[.,]\d+) günü perakende satış tarifesi, (\d+[.,]\d+) günü son kaynak/))) r.sktGun = +m[2].replace(',', '.');
  // Okuma satırından zaman dilimleri (üç zamanlı sayaç)
  r.zaman = {};
  for (const z of ['Gündüz', 'Puant', 'Gece']) { const k = bul(new RegExp('^' + z + '(\\d+\\.\\d{3})(\\d+\\.\\d{3})(\\d+\\.\\d{3})$')); if (k) r.zaman[z] = { ilkEndeks: +k[1], sonEndeks: +k[2], kwh: +k[3] }; }
  if ((m = bul(/^Fatura Ort\.Tük$/))) { const i = S.indexOf(m[0]); const g = /^([\d.]+)$/.exec(S[i + 2] || ''); if (g) r.gunlukOrtalama = +g[1]; }
  // kWh'siz fatura (ör. "Yıllık İşletim Bedeli … 1. taksit"): dönem "Fatura Dönemi:17 - 07 - 2026" biçiminde gelir
  if (!r.donem && (m = bul(/^Fatura Dönemi:\s*\d{2}\s*-\s*(\d{2})\s*-\s*(\d{4})/))) r.donem = m[2] + '-' + m[1];
  if (r.tuketimKwh == null) r.tuketimKwh = 0;
  if (!r.kalemler.length) {
    const h = (r.diger || []).filter(x => x.tutar && !/yuvarlama/i.test(x.ad));
    if (h.length) r.hizmet = h.map(x => x.ad).join(', ') + ((/(\d+\. taksit)/i.exec(metin) || [])[1] ? ' · ' + /(\d+\. taksit)/i.exec(metin)[1] : '');
    if (!r.tuketiciGrubu) r.tuketiciGrubu = 'Hizmet / bedel faturası (kWh yok)';
  }
  if (r.kdv != null && r.kdvMatrah != null) r.kontrol = [{ ad: 'KDV / matrah oranı', beklenen: null, faturada: Math.round(r.kdv / r.kdvMatrah * 1000) / 10, fark: null, tamam: true }];
  return r;
}

function tur(metin) {
  if (/ANTALYA ORGANİZE SANAYİ BÖLGESİ/.test(metin) && /OSB\d{10,}/.test(metin)) return 'OSB';
  if (/ANT TRAFO/i.test(metin) && /ANT\d{10,}/.test(metin)) return 'ANT';
  if (/CK AKDENİZ|ckakdeniz/i.test(metin) && /CK\d{12,}/.test(metin)) return 'CK';
  return null;
}
function cozumle(metin) {
  const S = String(metin || '').replace(/ /g, ' ').split('\n').map(x => x.trim()).filter(Boolean);
  const t = tur(metin);
  if (t === 'OSB') return osbCoz(S);
  if (t === 'ANT') return antCoz(S, metin);
  if (t === 'CK') return ckCoz(S, metin);
  return { kaynak: null, okundu: false, hata: 'Fatura türü tanınamadı (CK Akdeniz / Antalya OSB / ANT Trafo değil).' };
}
// Fatura no kalıbı: dosya adları ve belgeler bu kalıpla eşleşir
const FATURA_NO = /(CK\d{12,16}|OSB\d{10,16}|ANT\d{10,16})/i;

module.exports = { cozumle, tur, bol, FATURA_NO };
