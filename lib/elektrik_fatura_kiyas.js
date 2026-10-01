// elektrik_fatura_kiyas.js — ELEKTRİK ANALİZİ · Ödenen faturalar ↔ uygulamanın hesabı (Ocak 2025 →)
//
// Elektrik Fatura Paneli'nden saklanan her fatura (toplam kWh + ödenecek TL) yeniden hesaplanır.
// Fatura numarası serisi tedarik türünü gösterir (veriyle doğrulandı, 2026-09-29):
//  • CK1 = görevli tedarik (ulusal EPDK tarifesi). 2026 ticarethane faturaları tarifeye birebir uyar.
//      Beklenen = kWh × (aktif enerji + dağıtım) + ETV %5 (sadece enerjiye) + KDV
//      KDV: ticarethane %20, mesken %10, tarımsal %10 (tarımsal CK1 faturası tam 1,1/1,2 oranında çıktı).
//  • CK2 = ikili anlaşma (PTF'ye bağlı). Aynı ay içinde tüm dükkânlar ±%1 aynı birim fiyattan faturalanır.
//      Beklenen = kWh × ((PTF + YEKDEM) × k_ay + dağıtım) + ETV + KDV; k_ay = o ayın CK2 ticarethane
//      faturalarından çıkan emsal (medyan) katsayı. Resmi son kaynak katsayısı (1,0938) karşılaştırma için gösterilir.
//  • Mesken tarifesi yıllık limit / günlük 8 kWh kuralına bağlıdır, panel bu bilgiyi vermez: en yakın
//    resmi seçenek (düşük tüketim / normal / son kaynak) seçilir, sonuç "yaklaşık kontrol" sayılır.
// Fatura kesim günü (ayın 10'u / 20'si / sonu) bilinmediği için üç tüketim aralığı da aday olarak hesaplanır (bkz. KESIMLER).
// Ay içinde tarife değişirse (05.04.2025, 04.04.2026) gün sayısına oranlanır. Tolerans ±%3 (en az 10 TL):
// ödenecek tutar 5 TL'ye yuvarlıdır, PTF aylık ortalamadır, gecikme zammı vb. faturada ayrıca olabilir.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const TOLERANS = 0.03;
const SKTT_KATSAYI = 1.0938;
const ETV = 0.05;
const iki = n => String(n).padStart(2, '0');
const gunSayisi = ay => { const [y, m] = ay.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const yuv = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
const medyan = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// AG tek terim bölümündeki abone grubu satırları: [tek zamanlı enerji, gündüz, puant, gece, dağıtım]
function tarifeOku(dosya) {
  const wb = XLSX.readFile(dosya);
  const ad = wb.SheetNames.find(s => /faaliyet/i.test(s)) || wb.SheetNames[0];
  const satirlar = XLSX.utils.sheet_to_json(wb.Sheets[ad], { header: 1, raw: true, defval: null });
  const t = {};
  let ag = false;
  for (const s of satirlar) {
    const metin = s.filter(v => typeof v === 'string').join(' | ');
    const sayi = s.filter(v => typeof v === 'number');
    if (/alçak gerilim|AG Tek Terim/i.test(metin)) ag = true;
    if (/üretici/i.test(metin)) ag = false;
    if (!ag || sayi.length < 5) continue;
    const al = k => { if (!t[k]) t[k] = { enerji: sayi[0], dagitim: sayi[4] }; };
    if (/kamu ve özel.*ve altı/i.test(metin)) al('ticarethane_alt');
    else if (/kamu ve özel/i.test(metin)) al('ticarethane');
    else if (/mesken.*ve altı/i.test(metin)) al('mesken_alt');
    else if (/mesken/i.test(metin)) al('mesken');
    else if (/tarımsal/i.test(metin)) al('tarimsal');
    else if (/sanayi/i.test(metin)) al('sanayi');
  }
  const gecerlilik = (/(\d{4}-\d{2}-\d{2})/.exec(path.basename(dosya)) || [])[1];
  for (const k of ['ticarethane', 'ticarethane_alt', 'mesken', 'mesken_alt', 'tarimsal', 'sanayi'])
    if (!t[k] || !(t[k].enerji > 1 && t[k].dagitim > 1)) throw new Error('AG tarife satırı okunamadı: ' + k + ' · ' + path.basename(dosya));
  return { gecerlilik, dosya: path.basename(dosya), ...t };
}
function tarifeleriOku(klasor) {
  return fs.readdirSync(klasor).filter(f => /^tarife_\d{4}-\d{2}-\d{2}\.xlsx$/i.test(f)).map(f => tarifeOku(path.join(klasor, f)))
    .sort((a, b) => a.gecerlilik.localeCompare(b.gecerlilik));
}
const gunTarifesi = (tarifeler, gun) => { let t = null; for (const x of tarifeler) if (x.gecerlilik <= gun) t = x; return t; };

const TARIM = /sera|çiftli|ciftli|bahçe|bahce|meyvelik|büyükbaş|buyukbas|ahır|ahir|kuşbaba|kusbaba/i;
function aboneGrubu(f) {
  if (f.grup === 'MESKEN') return 'mesken';
  if (f.grup === 'GES') return 'ges';
  if (TARIM.test(f.lokasyon || '')) return 'tarimsal';
  return 'ticarethane';
}
const GRUP_AD = { mesken: 'Mesken', ticarethane: 'Ticarethane', tarimsal: 'Tarımsal faaliyet', ges: 'GES (üretim + tüketim)' };
const TIP_AD = { ticarethane: 'Ticarethane (30 kWh/gün üstü)', ticarethane_alt: 'Ticarethane (30 kWh/gün ve altı)', mesken: 'Mesken (8 kWh/gün üstü)', mesken_alt: 'Mesken (8 kWh/gün ve altı)', tarimsal: 'Tarımsal faaliyetler' };
const faturaNo = dosya => (/-((?:CK|OSB|ANT)\d+)-/.exec(dosya || '') || [])[1] || '';
// Seri: CK1 / CK2 (CK Akdeniz tedarik türü) · OSB (Antalya OSB) · ANT (ANT Trafo hizmeti)
const seri = dosya => { const n = faturaNo(dosya); return /^CK/.test(n) ? n.slice(0, 3) : n.replace(/\d.*$/, ''); };

// ─── Antalya OSB faturası (SECENGIDA fabrika): son kaynak (SKTT) referans hesabı ─────────────────────────────────
// OSB enerji bedelini o ayın saatlik tüketim profiline göre GEÇİCİ birim fiyatla keser; kesin fiyat ile fark bir sonraki
// faturada "Aktif enerji birim fiyat farkı" satırıyla düzeltilir. Bu yüzden enerji, referans son kaynak fiyatı
// (PTF + YEKDEM) × 1,0938 ile yeniden hesaplanır; önceki döneme ait satırlar (fiyat farkı, GES üretim mahsubu),
// OSB'nin iletim / dağıtım bedelleri, reaktif ve vergiler faturadaki tutarlarıyla alınır (OSB tarifesi EPDK ulusal
// tarife tablosunda yer almaz). KDV %20. Fark yalnızca bu ayın enerji fiyatından doğar.
function osbHesap(r, p) {
  if (!r || !r.aktif || !p) return null;
  const refBirim = (p.ptf + p.yekdem) / 1000 * SKTT_KATSAYI;
  const enerji = r.aktif.toplam * refBirim;
  const onceki = (r.fiyatFarki ? r.fiyatFarki.tutar : 0) + (r.uretimMahsup ? r.uretimMahsup.tutar : 0);
  const bedel = (r.bedeller || []).reduce((t, b) => t + (b.tutar || 0), 0) + Object.values(r.reaktif || {}).reduce((t, x) => t + (x.tutar || 0), 0);
  const vergi = (r.etv || 0) + (r.diger || []).reduce((t, x) => t + (x.tutar || 0), 0);
  const matrah = enerji + onceki + bedel + vergi, kdv = matrah * 0.2;
  return {
    yontem: 'OSB · son kaynak referansı (PTF+YEKDEM)×' + String(SKTT_KATSAYI).replace('.', ','), tip: 'osb', tipAd: 'Antalya OSB · ' + (r.tuketiciGrubu || 'OG'),
    kaynak: 'osb', ptf: yuv(p.ptf), yekdem: yuv(p.yekdem), katsayi: SKTT_KATSAYI, refBirim: Math.round(refBirim * 1e6) / 1e6, faturaBirim: r.aktif.birim,
    efektifK: Math.round(r.aktif.birim / ((p.ptf + p.yekdem) / 1000) * 1e4) / 1e4,
    enerji: yuv(enerji), enerjiFatura: r.aktif.tutar, oncekiDonem: yuv(onceki), dagitim: yuv(bedel), etv: yuv(r.etv || 0), digerVergi: yuv(vergi - (r.etv || 0)), kdv: yuv(kdv), toplam: yuv(matrah + kdv), kdvOran: 0.2,
    enerjiKr: yuv(refBirim * 100), dagitimKr: r.aktif.toplam ? yuv(bedel / r.aktif.toplam * 100) : null,
  };
}

// Ay içindeki günlere oranlanmış tarife bileşenleri (kr/kWh ortalaması) ve geçerli tablolar
function ayTarifesi(tarifeler, ay, tip) {
  const n = gunSayisi(ay);
  let enerji = 0, dagitim = 0; const tablolar = new Set();
  for (let g = 1; g <= n; g++) {
    const t = gunTarifesi(tarifeler, ay + '-' + iki(g));
    if (!t) return null;
    tablolar.add(t.gecerlilik); enerji += t[tip].enerji / n; dagitim += t[tip].dagitim / n;
  }
  return { enerji, dagitim, tablolar: [...tablolar] };
}
// Fatura kesim günleri: CK ayın 10'unda, 20'sinde ve sonunda fatura keser. Bir "dönem" faturası takvim ayını
// değil, önceki kesimden bu kesime kadar olan aralığı kapsar (10'u: önceki ayın 11'i → bu ayın 10'u). Hangi
// sözleşmenin hangi gün kesildiği panelde yok; üç aralık da aday olarak hesaplanır, ödenen tutara en yakını seçilir.
// Aralığın fiyatı, içindeki günlerin ait olduğu ayların fiyatlarının gün ağırlıklı ortalamasıdır.
const KESIMLER = [
  { gun: 30, ad: '' },                          // ay sonu = takvim ayı (eski davranış)
  { gun: 10, ad: " · ayın 10'unda kesim" },
  { gun: 20, ad: " · ayın 20'sinde kesim" },
];
function kesimGunleri(ay, kesim) {
  const [y, m] = ay.split('-').map(Number), g = [];
  const bas = kesim >= 28 ? new Date(y, m - 1, 1) : new Date(y, m - 2, kesim + 1);
  const bit = kesim >= 28 ? new Date(y, m, 0) : new Date(y, m - 1, kesim);
  for (const d = bas; d <= bit; d.setDate(d.getDate() + 1)) g.push(d.getFullYear() + '-' + iki(d.getMonth() + 1) + '-' + iki(d.getDate()));
  return g;
}
function aralikTarifesi(tarifeler, gunler, tip) {
  let enerji = 0, dagitim = 0; const tablolar = new Set();
  for (const gun of gunler) {
    const t = gunTarifesi(tarifeler, gun);
    if (!t) return null;
    tablolar.add(t.gecerlilik); enerji += t[tip].enerji / gunler.length; dagitim += t[tip].dagitim / gunler.length;
  }
  return { enerji, dagitim, tablolar: [...tablolar] };
}
function aralikPiyasa(piyasa, gunler) {
  let ptf = 0, yekdem = 0;
  for (const gun of gunler) { const p = piyasa[gun.slice(0, 7)]; if (!p) return null; ptf += p.ptf / gunler.length; yekdem += p.yekdem / gunler.length; }
  return { ptf, yekdem };
}

// Kalem kalem hesap: enerjiKr ve dagitimKr birim fiyat (kr/kWh)
function kalemler(kwh, enerjiKr, dagitimKr, kdvOran) {
  const enerji = kwh * enerjiKr / 100, dagitim = kwh * dagitimKr / 100, etv = enerji * ETV, kdv = (enerji + dagitim + etv) * kdvOran;
  return { enerji: yuv(enerji), dagitim: yuv(dagitim), etv: yuv(etv), kdv: yuv(kdv), toplam: yuv(enerji + dagitim + etv + kdv), enerjiKr: yuv(enerjiKr * 100) / 100, dagitimKr: yuv(dagitimKr * 100) / 100, kdvOran };
}

function kiyasla({ faturalar, lokasyonlar, tarifeler, piyasa, okunan = new Map() }) {
  const lok = Object.fromEntries((lokasyonlar || []).map(l => [l.sozlesmeNo, l]));
  const liste = faturalar.map(f0 => {
    const l = lok[f0.sozlesmeNo] || {};
    const f = { ...f0, lokasyon: l.lokasyon || f0.lokasyon || '', grup: l.grup || f0.grup || '' };
    return { f, grup: aboneGrubu(f), seri: seri(f.dosya), no: faturaNo(f.dosya) };
  });

  // Ayın emsal katsayısı: CK2 ticarethane (büyük) faturalarından enerji birim fiyatı ÷ (PTF+YEKDEM)
  const kOrnek = {};
  for (const { f, grup, seri: sr } of liste) {
    if (sr !== 'CK2' || grup !== 'ticarethane' || !(f.tuketim > 1000) || !piyasa[f.donem]) continue;
    const t = ayTarifesi(tarifeler, f.donem, 'ticarethane'); if (!t) continue;
    const enerjiKr = ((f.odenecek / 1.2) / f.tuketim * 100 - t.dagitim) / (1 + ETV);
    (kOrnek[f.donem] = kOrnek[f.donem] || []).push(enerjiKr / ((piyasa[f.donem].ptf + piyasa[f.donem].yekdem) / 10));
  }
  const emsalK = Object.fromEntries(Object.entries(kOrnek).map(([ay, a]) => [ay, { k: medyan(a), ornek: a.length }]));

  const satirlar = [];
  for (const { f, grup, seri: sr, no } of liste) {
    const s = { sozlesmeNo: f.sozlesmeNo, lokasyon: f.lokasyon, panelGrup: f.grup || '(grupsuz)', aboneGrubu: GRUP_AD[grup], donem: f.donem, seri: sr, faturaNo: no, kwh: f.tuketim, odenen: f.odenecek, dosya: f.dosya };
    const p = piyasa[f.donem];
    if (sr === 'ANT') { s.durum = 'ek-fatura'; s.hizmet = true; s.aciklama = 'Trafo işletme sorumluluğu hizmet bedeli (kWh içermez).'; satirlar.push(s); continue; }
    if (sr === 'OSB') {
      const r = okunan.get(no), h = osbHesap(r, p);
      if (!h) { s.durum = 'hesaplanamadi'; s.aciklama = !p ? 'Bu dönem için PTF / YEKDEM verisi yok.' : 'OSB faturasının PDF değerleri okunamadı.'; satirlar.push(s); continue; }
      s.hesapDetay = h; s.yontem = h.yontem; s.hesap = h.toplam; s.osb = true;
      s.fark = yuv(f.odenecek - h.toplam); s.farkYuzde = h.toplam ? yuv((f.odenecek - h.toplam) / h.toplam * 100) : null;
      s.birimOdenen = yuv(f.odenecek / f.tuketim * 10000) / 10000; s.birimHesap = yuv(h.toplam / f.tuketim * 10000) / 10000;
      const tol = Math.max(10, h.toplam * TOLERANS), tl = v => v.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
      const birimMetni = 'faturadaki geçici birim ' + tl(h.faturaBirim) + ' TL/kWh = (PTF+YEKDEM) × ' + String(h.efektifK).replace('.', ',') + ' · referans ' + tl(h.refBirim) + ' TL/kWh';
      if (Math.abs(s.fark) <= tol) { s.durum = 'dogru'; s.aciklama = 'Son kaynak referansıyla uyumlu (fark ±%3 içinde): ' + birimMetni + '.'; }
      else { s.durum = s.fark > 0 ? 'fazla' : 'eksik'; s.aciklama = (s.fark > 0 ? 'Referans son kaynak fiyatının üzerinde: ' : 'Referans son kaynak fiyatının altında: ') + birimMetni + '. OSB geçici fiyatla keser; kesin fiyat farkı bir sonraki faturada "birim fiyat farkı" satırıyla düzeltilir (AOSB Fabrika sekmesinde ay ay).'; }
      if (r.uyarilar && r.uyarilar.length) s.aciklama += ' ⚠ ' + r.uyarilar.join(' ');
      satirlar.push(s); continue;
    }
    if (grup === 'ges') { s.durum = 'kapsam-disi'; s.aciklama = 'GES tesisi: üretim ve tüketim mahsuplaşır, tutar kWh ile doğrudan hesaplanamaz.'; satirlar.push(s); continue; }
    if (!(f.tuketim > 0)) { s.durum = 'ek-fatura'; s.aciklama = 'Faturada kWh yok: ek, fark veya düzeltme faturası.'; satirlar.push(s); continue; }
    const kdv = grup === 'ticarethane' ? 0.20 : 0.10;
    const gunluk = f.tuketim / gunSayisi(f.donem);
    const adaylar = [];
    // Her yöntem üç kesim aralığı için hesaplanır (bkz. KESIMLER); eşitlikte ilk aday (ay sonu) kalır
    const tarifeAday = (tip, ad) => {
      for (const k of KESIMLER) { const t = aralikTarifesi(tarifeler, kesimGunleri(f.donem, k.gun), tip); if (t) adaylar.push({ yontem: ad + k.ad, kesim: k.gun, tip, tablolar: t.tablolar, ...kalemler(f.tuketim, t.enerji, t.dagitim, kdv), _dag: t.dagitim }); }
    };
    if (sr === 'CK2') {
      const tip = grup === 'tarimsal' ? 'tarimsal' : grup === 'mesken' ? 'mesken' : 'ticarethane';
      const t = ayTarifesi(tarifeler, f.donem, tip), e = emsalK[f.donem];
      if (e) for (const k of KESIMLER) {
        const gl = kesimGunleri(f.donem, k.gun), tk = aralikTarifesi(tarifeler, gl, tip), pk = aralikPiyasa(piyasa, gl);
        if (tk && pk) adaylar.push({ yontem: k.ad ? 'İkili anlaşma (emsal fiyat' + k.ad + ')' : 'İkili anlaşma (ayın emsal fiyatı)', kesim: k.gun, tip, tablolar: tk.tablolar, katsayi: yuv(e.k * 10000) / 10000, ptf: yuv(pk.ptf), yekdem: yuv(pk.yekdem), ...kalemler(f.tuketim, (pk.ptf + pk.yekdem) / 10 * e.k, tk.dagitim, kdv) });
      }
      s.kyas = {};
      if (t) s.kyas.tarife = kalemler(f.tuketim, t.enerji, t.dagitim, kdv).toplam;
      if (t && p) s.kyas.sktt = kalemler(f.tuketim, (p.ptf + p.yekdem) / 10 * SKTT_KATSAYI, t.dagitim, kdv).toplam;
    } else if (grup === 'mesken') {
      tarifeAday('mesken_alt', 'Ulusal tarife · mesken düşük tüketim'); tarifeAday('mesken', 'Ulusal tarife · mesken');
      for (const k of KESIMLER) {
        const gl = kesimGunleri(f.donem, k.gun), tk = aralikTarifesi(tarifeler, gl, 'mesken'), pk = aralikPiyasa(piyasa, gl);
        if (tk && pk) adaylar.push({ yontem: 'Son kaynak (mesken limit üstü)' + k.ad, kesim: k.gun, tip: 'mesken', tablolar: tk.tablolar, ptf: yuv(pk.ptf), yekdem: yuv(pk.yekdem), ...kalemler(f.tuketim, (pk.ptf + pk.yekdem) / 10 * SKTT_KATSAYI, tk.dagitim, kdv) });
      }
      s.yaklasik = true;
    } else if (grup === 'tarimsal') tarifeAday('tarimsal', 'Ulusal tarife · tarımsal');
    else {
      tarifeAday(gunluk > 30 ? 'ticarethane' : 'ticarethane_alt', 'Ulusal tarife · ticarethane');
      if (gunluk <= 30) { tarifeAday('ticarethane', 'Ulusal tarife · ticarethane'); s.yaklasik = true; }
    }
    if (!adaylar.length) { s.durum = 'hesaplanamadi'; s.aciklama = 'Bu dönem için tarife veya PTF/YEKDEM verisi yok.'; satirlar.push(s); continue; }
    const h = adaylar.reduce((x, y) => Math.abs(f.odenecek - y.toplam) < Math.abs(f.odenecek - x.toplam) ? y : x);
    delete h._dag;
    s.hesapDetay = { ...h, tipAd: TIP_AD[h.tip] || h.tip }; s.yontem = h.yontem; s.hesap = h.toplam;
    s.fark = yuv(f.odenecek - h.toplam); s.farkYuzde = h.toplam ? yuv((f.odenecek - h.toplam) / h.toplam * 100) : null;
    s.birimOdenen = yuv(f.odenecek / f.tuketim * 10000) / 10000; s.birimHesap = yuv(h.toplam / f.tuketim * 10000) / 10000;
    const tol = Math.max(10, h.toplam * TOLERANS);
    if (Math.abs(s.fark) <= tol) { s.durum = 'dogru'; s.aciklama = h.yontem + ' ile uyumlu (' + (Math.abs(s.fark) > h.toplam * TOLERANS ? 'küçük tutarlı fatura: fark 10 TL altında' : 'fark ±%3 içinde') + ').'; }
    else {
      s.durum = s.fark > 0 ? 'fazla' : 'eksik';
      const oran = f.odenecek / h.toplam;
      if (f.tuketim < 50) s.aciklama = 'Tüketim çok düşük: sabit bedel, önceki dönem bakiyesi veya asgari tutar etkisi olabilir.';
      else if (oran > 2 || oran < 0.5) s.aciklama = 'Tutar kWh ile orantısız: önceki borç, gecikme zammı, endeks düzeltmesi ya da birden çok dönem birlikte faturalanmış olabilir.';
      else if (s.fark > 0) s.aciklama = sr === 'CK2' ? 'Aynı ayda diğer dükkânlardan daha yüksek birim fiyat uygulanmış: anlaşma dışı fiyat, reaktif bedel, gecikme zammı veya YEKDEM fark bedeli olabilir.' : 'Tarifenin üzerinde: yanlış tarife sınıfı, reaktif bedel, gecikme zammı veya son kaynak fiyatı uygulanmış olabilir.';
      else s.aciklama = sr === 'CK2' ? 'Aynı ayda diğer dükkânlardan daha düşük birim fiyat: kısmi dönem, mahsup, iade veya fark düzeltmesi olabilir.' : 'Tarifenin altında: kısmi dönem, mahsup, iade veya indirim olabilir.';
      if (s.yaklasik) s.aciklama += ' (Yaklaşık kontrol: abone sınıfı panelde yok.)';
    }
    satirlar.push(s);
  }

  // Kesin mükerrer: aynı fatura numarası birden fazla kayıt
  const noGrup = {};
  for (const s of satirlar) if (s.faturaNo) (noGrup[s.faturaNo] = noGrup[s.faturaNo] || []).push(s);
  const mukerrer = Object.values(noGrup).filter(l => l.length > 1).map(l => {
    for (const s of l.slice(1)) s.mukerrer = true;
    return { faturaNo: l[0].faturaNo, sozlesmeNo: l[0].sozlesmeNo, lokasyon: l[0].lokasyon, grup: l[0].panelGrup, donem: l[0].donem, kwh: l[0].kwh, tutar: l[0].odenen, adet: l.length, fazlaTutar: yuv(l.slice(1).reduce((t, x) => t + (+x.odenen || 0), 0)), dosyalar: l.map(x => x.dosya) };
  });
  // Olası mükerrer / dönem çakışması: aynı sözleşme + aynı ay, kWh'li birden fazla (farklı numaralı) fatura
  const ayGrup = {};
  for (const s of satirlar) if (s.kwh > 0 && !s.mukerrer) (ayGrup[s.sozlesmeNo + '|' + s.donem] = ayGrup[s.sozlesmeNo + '|' + s.donem] || []).push(s);
  const cift = Object.values(ayGrup).filter(l => l.length > 1).map(l => {
    for (const s of l) s.ciftFatura = true;
    const seriler = [...new Set(l.map(x => x.seri))];
    return {
      sozlesmeNo: l[0].sozlesmeNo, lokasyon: l[0].lokasyon, grup: l[0].panelGrup, donem: l[0].donem, adet: l.length,
      faturalar: l.map(x => ({ faturaNo: x.faturaNo, seri: x.seri, kwh: x.kwh, tutar: x.odenen, durum: x.durum })),
      toplamKwh: yuv(l.reduce((t, x) => t + x.kwh, 0)), toplamTutar: yuv(l.reduce((t, x) => t + x.odenen, 0)),
      yorum: seriler.length > 1 ? 'İki farklı tedarik serisi (' + seriler.join(' + ') + '): ay içinde tedarikçi değişimi veya iki okuma dönemi. Toplam kWh önceki aylarla kıyaslanmalı.' : 'Aynı seride iki fatura (' + seriler[0] + '): iki okuma dönemi veya yeniden düzenlenmiş (iptal edilmemiş) fatura olabilir.',
    };
  });
  // Ay özeti
  const aylar = {};
  for (const s of satirlar) {
    const a = (aylar[s.donem] = aylar[s.donem] || { ay: s.donem, adet: 0, kwh: 0, odenen: 0, kontrolAdet: 0, kontrolOdenen: 0, kontrolHesap: 0, dogru: 0, fazla: 0, eksik: 0, ek: 0, disi: 0, fazlaTL: 0, eksikTL: 0, mukerrer: 0, mukerrerTL: 0, tarifeIle: 0 });
    a.adet++; a.kwh += +s.kwh || 0; a.odenen += +s.odenen || 0;
    if (s.mukerrer) { a.mukerrer++; a.mukerrerTL += +s.odenen || 0; }
    if (s.hesap != null && !s.mukerrer) { a.kontrolAdet++; a.kontrolOdenen += s.odenen; a.kontrolHesap += s.hesap; }
    if (s.kyas && s.kyas.tarife && !s.mukerrer) a.tarifeIle += s.kyas.tarife - s.odenen;
    if (s.mukerrer) continue;
    if (s.durum === 'dogru') a.dogru++; else if (s.durum === 'fazla') { a.fazla++; a.fazlaTL += s.fark; } else if (s.durum === 'eksik') { a.eksik++; a.eksikTL += s.fark; } else if (s.durum === 'ek-fatura') a.ek++; else a.disi++;
  }
  const ay = Object.values(aylar).sort((x, y) => x.ay.localeCompare(y.ay)).map(a => ({
    ...a, kwh: yuv(a.kwh), odenen: yuv(a.odenen), kontrolOdenen: yuv(a.kontrolOdenen), kontrolHesap: yuv(a.kontrolHesap), fark: yuv(a.kontrolOdenen - a.kontrolHesap),
    fazlaTL: yuv(a.fazlaTL), eksikTL: yuv(a.eksikTL), mukerrerTL: yuv(a.mukerrerTL), anlasmaKazanci: yuv(a.tarifeIle),
    ptf: piyasa[a.ay] ? piyasa[a.ay].ptf : null, yekdem: piyasa[a.ay] ? piyasa[a.ay].yekdem : null, emsalK: emsalK[a.ay] ? yuv(emsalK[a.ay].k * 10000) / 10000 : null,
  }));
  return { satirlar, mukerrer, cift, aylar: ay, tolerans: TOLERANS, sktt: SKTT_KATSAYI, tarifeler: tarifeler.map(t => ({ gecerlilik: t.gecerlilik, dosya: t.dosya, ticarethane: t.ticarethane, mesken: t.mesken, tarimsal: t.tarimsal })) };
}

// Faturanın PDF'inden (lib/elektrik_pdf_fatura.js) tarife grubu ve kademe alınarak yeniden hesap.
// Panel grubu (ör. MESKEN) faturadaki tüketici grubuyla uyuşmayabilir; PDF okunduysa grup faturadan gelir:
//  • Tarifeli fatura (Enerji Bedeli-Düşük / Yüksek Kademe, tarımsal "Enerji Bedeli"): kWh faturadaki kademe kalemlerinden,
//    birim fiyat EPDK tarifesinden (Düşük Kademe = "… ve altı" satırı), okuma aralığının günlerine oranlanır.
//    Not: tarife değişimini kapsayan dönemlerde CK günlere eşit değil tüketim profiline göre oranlar (fark binde 3–5).
//  • SKTT (son kaynak / ikili anlaşma) faturası: null — fiyat piyasaya ve tarife tavanına bağlı, uygulamanın hesabı kalır.
//  • Faturadaki enerji dışı kalemler (gecikme, kesme-bağlama, tazminat…) ekDiger olarak ayrıca döner.
//  • KDV yasal oranı gruba göre (Kamu/Özel %20, mesken ve tarımsal %10): faturanın kendi oranı yalnızca kontrol içindir.
//  • OG ve grubu okunamayan faturalar: null (tarife dosyasında yalnız AG satırları okunur).
const PDF_GRUP_AD = { ticarethane: 'Kamu/Özel Sektör', mesken: 'Mesken', tarimsal: 'Tarımsal' };
function pdfGrubu(g) {
  if (!g || /\bOG\b/.test(g)) return null;
  return /mesken/i.test(g) ? 'mesken' : /tarımsal|tarimsal/i.test(g) ? 'tarimsal' : /kamu\s*\/?\s*özel|kamu\/özel/i.test(g) ? 'ticarethane' : null;
}
const KDV_GRUP = { ticarethane: 0.20, mesken: 0.10, tarimsal: 0.10 };
function okumaGunleri(r) {
  const iso = s => /^\d{2}-\d{2}-\d{4}$/.test(s || '') ? s.split('-').reverse().join('-') : null;
  const a = iso(r.ilkOkuma), b = iso(r.sonOkuma);
  if (!a || !b || a >= b) return r.donem ? kesimGunleri(r.donem, 30) : null;
  const g = [], d = new Date(a + 'T00:00:00Z'), son = new Date(b + 'T00:00:00Z');
  for (d.setUTCDate(d.getUTCDate() + 1); d <= son; d.setUTCDate(d.getUTCDate() + 1)) g.push(d.toISOString().slice(0, 10)); // (ilk, son]
  return g;
}
function pdfHesap(r, hd, tarifeler) {
  const grup = pdfGrubu(r.tuketiciGrubu);
  if (!grup || !r.kalemler || !r.kalemler.length) return null;
  const gunler = okumaGunleri(r);
  if (!gunler || !gunler.length) return null;
  // SKTT (son kaynak / ikili anlaşma) fiyatı piyasaya ve tarife tavanına bağlı: burada yeniden kurulmaz (uygulamanın hesabı kalır)
  if (r.kalemler.some(k => /SKTT/i.test(k.ad))) return null;
  const kdvOran = KDV_GRUP[grup];
  const enerjiKalem = r.kalemler.filter(k => /^Enerji Bedeli/i.test(k.ad) && k.miktar); // eksi kWh (iade / düzeltme) dahil
  if (!enerjiKalem.length) return null;
  const kalem = [];
  let enerji = 0, dagitim = 0, kwh = 0;
  for (const k of enerjiKalem) {
    const tip = grup === 'tarimsal' ? 'tarimsal' : grup + (/düşük/i.test(k.ad) ? '_alt' : '');
    const t = aralikTarifesi(tarifeler, gunler, tip);
    if (!t) return null;
    const e = k.miktar * t.enerji / 100, d = k.miktar * t.dagitim / 100;
    enerji += e; dagitim += d; kwh += k.miktar;
    kalem.push({ ad: k.ad, tip, kwh: k.miktar, enerjiKr: yuv(t.enerji * 100) / 100, dagitimKr: yuv(t.dagitim * 100) / 100, birim: Math.round((t.enerji + t.dagitim) * 100) / 1e4, tutar: yuv(e + d), pdfBirim: k.birim, pdfTutar: k.tutar, tablolar: t.tablolar });
  }
  const etv = enerji * ETV, kdv = (enerji + dagitim + etv) * kdvOran;
  // Faturadaki enerji dışı kalemler (gecikme, kesme-bağlama, tazminat, düzeltme…): KDV matrahına girip girmediği faturanın
  // kendi toplamından anlaşılır (kalemler + ETV + diğer = matrah → KDV'li). Güvence ayrı işlenir; ayrı yazılmış dağıtım bedeli enerjiye aittir.
  const diger = (r.diger || []).filter(x => x.tutar && !/güvence|dağıtım/i.test(x.ad));
  const kalemTop = r.kalemler.reduce((s, k) => s + (k.tutar || 0), 0) + (r.diger || []).filter(x => /dağıtım/i.test(x.ad)).reduce((s, x) => s + x.tutar, 0) + (r.etv || 0);
  const icinde = r.kdvMatrah != null && Math.abs(kalemTop + diger.reduce((s, x) => s + x.tutar, 0) - r.kdvMatrah) < 0.05;
  const ekDiger = diger.map(x => ({ ad: x.ad, tutar: x.tutar, kdvli: icinde, kdvDahil: yuv(x.tutar * (icinde ? 1 + kdvOran : 1)) }));
  const kademe = kalem.length > 1 ? ' · ' + kalem.map(k => /düşük/i.test(k.ad) ? 'düşük' : /yüksek/i.test(k.ad) ? 'yüksek' : 'tek').filter((v, i, a) => a.indexOf(v) === i).join(' + ') + ' kademe' : /düşük/i.test(kalem[0].ad) ? ' · düşük kademe' : /yüksek/i.test(kalem[0].ad) ? ' · yüksek kademe' : '';
  return {
    yontem: 'Ulusal tarife · faturadaki grup: ' + PDF_GRUP_AD[grup] + kademe,
    tip: kalem.length === 1 ? kalem[0].tip : grup, pdfGrup: grup, kaynak: 'pdf', kesim: null, tablolar: [...new Set(kalem.flatMap(k => k.tablolar))],
    okuma: { ilk: r.ilkOkuma, son: r.sonOkuma, gun: gunler.length }, kalemler: kalem, kwh: yuv(kwh), ekDiger, ekDigerTop: yuv(ekDiger.reduce((s, x) => s + x.kdvDahil, 0)),
    enerji: yuv(enerji), dagitim: yuv(dagitim), etv: yuv(etv), kdv: yuv(kdv), toplam: yuv(enerji + dagitim + etv + kdv),
    enerjiKr: kwh ? yuv(enerji / kwh * 1e4) / 100 : null, dagitimKr: kwh ? yuv(dagitim / kwh * 1e4) / 100 : null, kdvOran,
  };
}

module.exports = { tarifeleriOku, kiyasla, aboneGrubu, faturaNo, osbHesap, pdfHesap, pdfGrubu, KDV_GRUP, TOLERANS, SKTT_KATSAYI };
