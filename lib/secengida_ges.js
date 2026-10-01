// secengida_ges.js — SECENGIDA çatı GES'i (AOSB fabrika, 750 kWe): GES üretim ve mahsup tetkiki, panel verisi olmadan,
// yalnızca reel faturalardan (PDF). Fatura Kontrol sayfasındaki "☀ Üretilen GES enerjisi" ve "📊 GES mahsup tetkiki"
// tablolarını besler (lib/elektrik_ges_mahsup.js gesUretimi / mahsupKontrolu ile aynı alanlar).
//
//  • Mahsuba giren üretim = AOSB faturasındaki şebekeye veriş, sayaç 2.8.0 (öz tüketilen üretim sayaçtan geçmez).
//  • M ayının verişi M+1 faturasında "Aktif enerji üretim bir önceki dönem" satırıyla, M ayının geçici birim fiyatından düşülür.
//    Bu yüzden tetkik satırı = fatura ayı; "GES üretimi" sütunu o faturada mahsup edilmesi gereken ÖNCEKİ AYIN verişidir.
//  • Mevzuat: 30.04.2026'ya kadar aylık mahsup = min(çekiş, veriş) (fabrikada çekiş hep büyük → verişin tamamı).
//    01.05.2026'dan saatlik mahsup = Σ saat min(çekiş, veriş); kalan veriş ihtiyaç fazlasıdır: mahsup edilmez, satılır,
//    bedeli faturada görünmez, ayrıca ödenmelidir. Saatlik çekiş/veriş (OSOS) olmadan saatlik mahsup doğrulanamaz:
//    o aylarda faturada mahsup edilen kabul edilir, kalan veriş ihtiyaç fazlası olarak gösterilir.
//  • Tahmini toplam üretim (öz tüketim dahil) = PVGIS aylık kWh/kWp × kurulu güç (kWe). Yaklaşık (±%10–20).
const yuv = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
const TOLERANS = 0.03;
const onceki = a => { const [y, m] = a.split('-').map(Number); return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0'); };

function secengidaGes({ satirlar, okunan, gunes, saatlikBaslangic = '2026-05-01', yilBasi = '2026-01' }) {
  const osb = [...okunan.values()].filter(r => r.kaynak === 'OSB' && r.okundu && r.donem).sort((a, b) => a.donem.localeCompare(b.donem));
  if (!osb.length) return null;
  const O = Object.fromEntries(osb.map(r => [r.donem, r]));
  const kwe = osb.map(r => r.uretimKwe).filter(Boolean).pop() || null;
  const lok = (satirlar.find(s => s.sozlesmeNo === osb[0].sozlesme) || {}).lokasyon || 'AOSB FABRİKA';
  const kdvK = r => r.kdv && r.kdvMatrah ? r.kdv / r.kdvMatrah : 0.2;
  const etvK = r => r.etv && r.kdvMatrah ? 0.01 : 0; // OSB faturasında ETV satırı boş

  // ☀ Üretilen GES enerjisi: üretim (veriş) ayına göre
  const pv = gunes && gunes.aylikUretim;
  const uAylar = osb.map(r => {
    const veris = r.veris ? r.veris.kwh : 0, b = r.aktif ? r.aktif.birim * (1 + etvK(r)) * (1 + kdvK(r)) : null;
    const tah = pv && kwe ? pv[+r.donem.slice(5) - 1] * kwe : null;
    return {
      ay: r.donem, uretim: yuv(veris), birim: b != null ? Math.round(b * 1e4) / 1e4 : null, tutar: b != null ? yuv(veris * b) : null,
      tesis: [{ sozlesmeNo: r.sozlesme, lokasyon: lok, kwh: yuv(veris), pay: 100, tutar: b != null ? yuv(veris * b) : null, tahmini: false }],
      tahminiUretim: yuv(tah), ozTuketim: tah != null ? yuv(tah - veris) : null, ozTuketimTL: tah != null && b != null ? yuv((tah - veris) * b) : null,
      ilaveVeris: r.veris ? r.veris.ilave : 0,
    };
  });
  const uretim = {
    tesisler: [{ sozlesmeNo: osb[0].sozlesme, lokasyon: lok, tur: 'cati', guc: kwe, gucKaynak: 'faturadaki kurulu üretim gücü (kWe)' }],
    aylar: uAylar, sonGun: null, tahmin: !!pv,
    kaynak: 'AOSB faturası · sayaç 2.8.0 (şebekeye veriş: mahsuba giren üretim). Öz tüketilen üretim sayaçtan geçmez, faturada yoktur',
    fiyat: 'o ayın OSB geçici enerji birimi × KDV %20 (OSB faturasında ETV yok)',
    tahminKaynak: pv ? 'PVGIS 5.3 Antalya aylık kWh/kWp × ' + kwe + ' kWe (30° eğim, güney, %14 kayıp) · yaklaşık ±%10–20' : null,
  };

  // 📊 GES mahsup tetkiki: fatura ayına göre (tüm faturalar)
  const M = {};
  for (const s of satirlar) {
    if (s.donem < yilBasi || s.mukerrer) continue;
    const m = (M[s.donem] = M[s.donem] || { ay: s.donem, fatura: 0, pdf: 0, reel: 0, reelKwh: 0, odenen: 0, mahsupKwh: 0, mahsupTL: 0, mahsupFatura: 0, mahsupLok: [] });
    m.fatura++; m.odenen += +s.odenen || 0;
    const r = okunan.get(s.faturaNo);
    if (!r || r.faturaTutari == null) continue;
    m.pdf++; m.reel += r.faturaTutari; m.reelKwh += +r.tuketimKwh || 0;
    if (r.kaynak === 'OSB') m.osb = true;
    if (r.kaynak === 'OSB' && r.uretimMahsup && r.uretimMahsup.tutar) {
      m.mahsupKwh += Math.abs(r.uretimMahsup.miktar); m.mahsupTL += Math.abs(r.uretimMahsup.tutar) * (1 + etvK(r)) * (1 + kdvK(r)); m.mahsupFatura++; m.mahsupLok.push(s.lokasyon);
    }
  }
  let kumKural = 0, kumFatura = 0, kumFazla = 0, kumFazlaTL = 0;
  const aylar = Object.values(M).sort((a, b) => a.ay.localeCompare(b.ay)).map(m => {
    const uAy = onceki(m.ay), u = O[uAy] || null; // bu faturada mahsup edilmesi gereken: önceki ayın verişi
    const saatlik = uAy + '-01' >= saatlikBaslangic;
    const veris = u && u.veris ? u.veris.kwh : null, b = u && u.aktif ? u.aktif.birim * (1 + etvK(u)) * (1 + kdvK(u)) : null;
    const r = {
      ay: m.ay, uretimAyi: uAy, fatura: m.fatura, pdf: m.pdf, reel: yuv(m.reel), reelKwh: yuv(m.reelKwh), odenen: yuv(m.odenen),
      mahsupKwh: yuv(m.mahsupKwh), mahsupTL: yuv(m.mahsupTL), mahsupFatura: m.mahsupFatura, mahsupLok: m.mahsupLok,
      mahsupsuz: yuv(m.reel + m.mahsupTL), gesTL: veris != null && b != null ? yuv(veris * b) : null, gesKwh: veris != null ? yuv(veris) : null, rejim: saatlik ? 'Saatlik' : 'Aylık',
    };
    r.beklenen = r.gesTL != null ? yuv(r.mahsupsuz - r.gesTL) : null;
    r.fark = r.beklenen != null ? yuv(r.odenen - r.beklenen) : null;
    if (veris == null) { r.durum = 'veri-yok'; return r; }
    // Bu ayın AOSB faturası henüz gelmedi: önceki ayın verişi mahsup için bekleniyor (karara katılmaz)
    if (!m.osb) { r.durum = 'fatura-bekleniyor'; r.beklenen = null; r.fark = null; return r; }
    const cekis = u.aktif ? u.aktif.okuma : Infinity;
    if (!saatlik) {
      r.kuralKwh = yuv(Math.min(cekis, veris)); r.fazlaKwh = yuv(veris - r.kuralKwh); r.fazlaTL = yuv(r.fazlaKwh * u.aktif.birim); r.fazlaBirim = u.aktif.birim;
      kumKural += r.kuralKwh; kumFatura += m.mahsupKwh;
      r.kumKural = yuv(kumKural); r.kumFatura = yuv(kumFatura); r.kumFark = yuv(kumFatura - kumKural); r.kumFarkYuzde = kumKural ? yuv((kumFatura - kumKural) / kumKural * 100) : null;
      r.ayFark = yuv(m.mahsupKwh - r.kuralKwh);
      r.durum = Math.abs(r.kumFarkYuzde) <= TOLERANS * 100 ? 'tam' : r.kumFark < 0 ? 'eksik' : 'fazla';
    } else {
      // Saatlik mahsup OSOS olmadan doğrulanamaz: faturada mahsup edilen = Σ min(çekiş, veriş) kabul; kalan veriş ihtiyaç fazlası
      r.kuralKwh = null; r.fazlaKwh = yuv(Math.max(veris - m.mahsupKwh, 0)); r.fazlaTL = yuv(r.fazlaKwh * u.aktif.birim); r.fazlaBirim = u.aktif.birim; r.fazlaYaklasik = true;
      kumFazla += r.fazlaKwh; kumFazlaTL += r.fazlaTL;
      r.durum = 'saatlik-yok';
    }
    return r;
  });
  const aylik = aylar.filter(a => a.kuralKwh != null), son = aylik[aylik.length - 1];
  const ozet = son ? {
    bas: aylik[0].ay, son: son.ay, kuralKwh: son.kumKural, faturaKwh: son.kumFatura, farkKwh: son.kumFark, farkYuzde: son.kumFarkYuzde, durum: son.durum,
    fazlaKwh: yuv(kumFazla), fazlaTL: yuv(kumFazlaTL), fazlaAylar: aylar.filter(a => a.durum === 'saatlik-yok').map(a => ({ ay: a.ay, uretimAyi: a.uretimAyi, veris: a.gesKwh, mahsup: a.mahsupKwh, fazla: a.fazlaKwh, tl: a.fazlaTL })),
    veriYok: aylar.filter(a => a.durum === 'veri-yok' && a.mahsupKwh).map(a => ({ ay: a.ay, mahsupKwh: a.mahsupKwh, mahsupTL: a.mahsupTL })),
  } : null;
  return { uretim, kontrol: { aylar, ozet, tolerans: TOLERANS, secengida: true } };
}

module.exports = { secengidaGes };
