// elektrik_ges_mahsup.js — ELEKTRİK ANALİZİ · GES mahsup kontrolü (Ocak 2025 →)
//
// İki kaynaktan mahsubun doğruluğu izlenir:
//  1) GES'li sözleşmelerin faturaları (panel: kWh + ödenen). Faturadaki kWh o ayın emsal birim fiyatıyla
//     (aynı ay CK2 ticarethane faturalarının ortanca TL/kWh'si, vergiler dahil) çarpılınca "mahsupsuz brüt"
//     bulunur. Brüt − ödenen = faturaya yansıyan (örtük) mahsup / alacak tutarı.
//       + fark  → mahsup/alacak faturaya yansımış (✔)
//       ≈ 0     → bu ay mahsup görünmüyor (○)
//       − fark  → beklenenden fazla ödenmiş: mahsup yansımamış ya da ters uygulanmış olabilir (✘)
//  2) Panelin GES klasöründeki saatlik sayaç verisi (üretim = veriş, tüketim = çekiş). Aynı veriyle aylık
//     ve saatlik mahsup (RG 33212, 01.05.2026'dan itibaren saatlik) kWh ve TL olarak hesaplanır.
// Tarla / çatı ayrımı mahsup edilen kWh'nin değerini değiştirir:
//  • Çatı (aynı ölçüm noktası): mahsup kWh × tam perakende birim (enerji + dağıtım + ETV + KDV)
//  • Tarla (uzaktan mahsup): dağıtım tüketim noktasında yine ödenir → mahsup kWh × (birim − dağıtım × 1,2)
// İhtiyaç fazlası satış birimi: tek zamanlı aktif enerji bedeli − LÜ-2 veriş bedeli (vergiler hariç).
const TOLERANS = 0.03;
const YIL_BASI = '2026-01'; // İshak'ın isteği (2026-09-29): GES mahsup yalnız 2026 için, 2025 karışmasın
const yuv = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
const medyan = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const ayOrtasi = ay => ay + '-15';
const gunTarifesi = (tarifeler, gun) => { let t = null; for (const x of tarifeler) if (x.gecerlilik <= gun) t = x; return t; };

// Varsayılan GES sözleşmeleri: panel grubu GES ya da lokasyon adında "GES" geçenler
function gesSozlesmeleri(satirlar, ayar) {
  const L = {};
  for (const s of satirlar) if (s.panelGrup === 'GES' || /\bGES\b/i.test(s.lokasyon || '') || (ayar.ekSozlesmeler || []).includes(s.sozlesmeNo)) L[s.sozlesmeNo] = { sozlesmeNo: s.sozlesmeNo, lokasyon: s.lokasyon, grup: s.panelGrup };
  for (const no of Object.keys(L)) {
    const t = (ayar.tur || {})[no];
    // Tüketim noktasının adında GES geçiyorsa (ör. depo çatısı) çatı, ayrı GES aboneliği ise tarla varsayılır
    L[no].tur = t || (L[no].grup === 'GES' ? 'tarla' : 'cati');
    L[no].turVarsayilan = !t;
    // Otomatik yorumun gerekçesi (İshak inceleyip Tarla / çatı ayarlarından düzeltir)
    L[no].neden = L[no].grup === 'GES' ? 'Ayrı bir GES aboneliği (panel grubu GES): üretim kendi sayacında, tüketim başka noktalarda → uzaktan mahsup, tarla GES.' : 'Bir tüketim noktasının adında GES geçiyor (' + L[no].lokasyon + '): panel tüketim tesisinin çatısında, aynı ölçüm noktası → çatı GES.';
  }
  return Object.values(L).sort((a, b) => a.lokasyon.localeCompare(b.lokasyon, 'tr'));
}

function gesMahsup({ kiyas, gesSaatlik, tarifeler, ayar }) {
  ayar = ayar || {};
  // Ayın emsal birim fiyatı (TL/kWh, vergiler dahil) ve dağıtım birimi
  const orn = {};
  for (const s of kiyas.satirlar) if (s.donem >= YIL_BASI && s.seri === 'CK2' && s.durum === 'dogru' && s.aboneGrubu === 'Ticarethane' && s.kwh > 1000) (orn[s.donem] = orn[s.donem] || []).push(s.odenen / s.kwh);
  const birim = {};
  for (const [ay, a] of Object.entries(orn)) {
    const t = gunTarifesi(tarifeler, ayOrtasi(ay));
    const dagitimTL = t && t.AG ? t.AG.dagitim / 100 : null;               // TL/kWh, vergisiz
    const fazlaTL = t && t.AG ? (t.AG.tek - (t.LU2 || 0)) / 100 : null;     // ihtiyaç fazlası satış birimi, vergisiz
    const b = medyan(a);
    birim[ay] = { cati: b, tarla: dagitimTL != null ? b - dagitimTL * 1.2 : b, dagitim: dagitimTL, fazla: fazlaTL, ornek: a.length, tarife: t ? t.gecerlilik : null };
  }
  const tesisler = gesSozlesmeleri(kiyas.satirlar, ayar);
  const satirlar = [];
  for (const t of tesisler) {
    for (const s of kiyas.satirlar.filter(x => x.sozlesmeNo === t.sozlesmeNo && !x.mukerrer && x.donem >= YIL_BASI).sort((a, b) => a.donem.localeCompare(b.donem))) {
      const b = birim[s.donem];
      const r = { sozlesmeNo: t.sozlesmeNo, lokasyon: t.lokasyon, tur: t.tur, donem: s.donem, rejim: s.donem + '-01' >= '2026-05-01' ? 'Saatlik' : 'Aylık', seri: s.seri, faturaNo: s.faturaNo, kwh: s.kwh || 0, odenen: s.odenen };
      if (!(s.kwh > 0) || !b) { r.durum = 'yok'; r.aciklama = !(s.kwh > 0) ? 'kWh yok (ek/düzeltme faturası): ödenen tutar ayın toplamına eklenir.' : 'Bu ay için emsal birim fiyat yok.'; satirlar.push(r); continue; }
      r.emsalBirim = yuv(b.cati * 10000) / 10000;
      r.brut = yuv(s.kwh * b.cati);
      r.mahsupTL = yuv(r.brut - s.odenen);
      r.efektifBirim = yuv(s.odenen / s.kwh * 10000) / 10000;
      const tol = Math.max(50, r.brut * TOLERANS);
      if (r.mahsupTL > tol) { r.durum = 'yansimis'; r.aciklama = 'Mahsup / ihtiyaç fazlası alacağı faturaya yansımış: ' + r.mahsupTL.toLocaleString('tr-TR') + ' TL indirim.'; }
      else if (r.mahsupTL >= -tol) { r.durum = 'yok-mahsup'; r.aciklama = 'Bu ay faturada mahsup indirimi görünmüyor: fatura normal birim fiyattan kesilmiş.'; }
      else { r.durum = 'fazla'; r.aciklama = 'Normal birim fiyatla hesaplanandan ' + Math.abs(r.mahsupTL).toLocaleString('tr-TR') + ' TL fazla ödenmiş. Mahsup yansımamış, ters uygulanmış (fazla enerji tüketim gibi faturalanmış) ya da faturada önceki dönem farkı olabilir.'; }
      satirlar.push(r);
    }
  }
  // Saatlik sayaç: aylık ve saatlik mahsup
  const sayac = {};
  for (const [gun, o] of Object.entries(gesSaatlik || {})) {
    if (gun < YIL_BASI) continue;
    const ay = gun.slice(0, 7), a = (sayac[ay] = sayac[ay] || { ay, saat: 0, cekis: 0, veris: 0, sMahsup: 0, sTuketim: 0, sFazla: 0 });
    for (let h = 0; h < 24; h++) {
      const c = +o.cekis[h] || 0, v = +o.veris[h] || 0;
      if (!c && !v) continue;
      a.saat++; a.cekis += c; a.veris += v; a.sMahsup += Math.min(c, v);
      if (c > v) a.sTuketim += c - v; else a.sFazla += v - c;
    }
  }
  const sayacAylar = Object.values(sayac).sort((x, y) => x.ay.localeCompare(y.ay)).map(a => {
    const b = birim[a.ay] || {};
    const aMahsup = Math.min(a.cekis, a.veris), aTuketim = Math.max(a.cekis - a.veris, 0), aFazla = Math.max(a.veris - a.cekis, 0);
    const net = (tuk, faz) => b.cati != null && b.fazla != null ? tuk * b.cati - faz * b.fazla * 1.2 : null;
    const r = {
      ay: a.ay, saat: a.saat, uretim: yuv(a.veris), tuketim: yuv(a.cekis), rejim: a.ay + '-01' >= '2026-05-01' ? 'Saatlik' : 'Aylık',
      aylikMahsup: yuv(aMahsup), aylikFaturalanacak: yuv(aTuketim), aylikFazla: yuv(aFazla),
      saatlikMahsup: yuv(a.sMahsup), saatlikFaturalanacak: yuv(a.sTuketim), saatlikFazla: yuv(a.sFazla),
      birimCati: b.cati != null ? yuv(b.cati * 10000) / 10000 : null, birimTarla: b.tarla != null ? yuv(b.tarla * 10000) / 10000 : null, fazlaBirim: b.fazla != null ? yuv(b.fazla * 10000) / 10000 : null,
      aylikNetTL: yuv(net(aTuketim, aFazla)), saatlikNetTL: yuv(net(a.sTuketim, a.sFazla)),
    };
    r.mahsupDegeriCatiAylik = b.cati != null ? yuv(aMahsup * b.cati) : null; r.mahsupDegeriCatiSaatlik = b.cati != null ? yuv(a.sMahsup * b.cati) : null;
    r.mahsupDegeriTarlaAylik = b.tarla != null ? yuv(aMahsup * b.tarla) : null; r.mahsupDegeriTarlaSaatlik = b.tarla != null ? yuv(a.sMahsup * b.tarla) : null;
    r.fazlaSatisAylik = b.fazla != null ? yuv(aFazla * b.fazla) : null; r.fazlaSatisSaatlik = b.fazla != null ? yuv(a.sFazla * b.fazla) : null;
    r.rejimEtkisiTL = r.aylikNetTL != null ? yuv(r.saatlikNetTL - r.aylikNetTL) : null;
    return r;
  });
  return { tesisler, satirlar, sayac: sayacAylar, birim: Object.fromEntries(Object.entries(birim).map(([k, v]) => [k, { cati: yuv(v.cati * 10000) / 10000, tarla: yuv(v.tarla * 10000) / 10000, dagitim: v.dagitim, fazla: v.fazla != null ? yuv(v.fazla * 10000) / 10000 : null, ornek: v.ornek, tarife: v.tarife }])), tolerans: TOLERANS };
}

// Üretilen GES enerjisi (mahsupsuz): panelin saatlik verisindeki "veriş" = panelin "Toplam Üretim"i.
// Tutar = üretim kWh × ayın emsal birimi (KDV dahil; GES Mahsup sayfasının "mahsupsuz" fiyatı): bu enerji şebekeden alınsaydı ödenecek tutar.
// Panel verisi tesis ayrımı taşımadığı için GES bazındaki dağılım TAHMİNİDİR: toplam üretim tesislerin gücüne göre paylaştırılır.
// Güç önceliği: GES ayarındaki kurulu güç (ayar.kuruluGuc[sözleşme no], kWp) → faturadaki anlaşma gücü (kW).
// İleride tesis bazında ölçüm gelirse ayar.uretimKesin[sözleşme no][ay] = kWh ile o ay kesin değer kullanılır.
function gesUretimi({ sayac, birim, tesisler, guc, ayar }) {
  ayar = ayar || {}; guc = guc || {};
  const kg = ayar.kuruluGuc || {}, kesin = ayar.uretimKesin || {};
  const T = tesisler.map(t => {
    const g = +kg[t.sozlesmeNo] || +guc[t.sozlesmeNo] || null;
    return { sozlesmeNo: t.sozlesmeNo, lokasyon: t.lokasyon, tur: t.tur, guc: g, gucKaynak: +kg[t.sozlesmeNo] ? 'kurulu güç (GES ayarı)' : g ? 'faturadaki anlaşma gücü' : 'güç yok' };
  });
  const aylar = (sayac || []).map(a => {
    const b = (birim || {})[a.ay] || {}, bf = b.cati != null ? b.cati : null;
    // Kesin ölçümü olan tesisler önce düşülür, kalan üretim diğerlerine güç oranında paylaştırılır
    const kesinler = T.filter(t => kesin[t.sozlesmeNo] && kesin[t.sozlesmeNo][a.ay] != null);
    const kesinTop = kesinler.reduce((s, t) => s + +kesin[t.sozlesmeNo][a.ay], 0);
    const kalan = Math.max(a.uretim - kesinTop, 0), pT = T.filter(t => !kesinler.includes(t) && t.guc), gT = pT.reduce((s, t) => s + t.guc, 0);
    const tesis = T.map(t => {
      const k = kesinler.includes(t), kwh = k ? +kesin[t.sozlesmeNo][a.ay] : t.guc && gT ? kalan * t.guc / gT : null;
      return { sozlesmeNo: t.sozlesmeNo, lokasyon: t.lokasyon, kwh: yuv(kwh), pay: kwh != null && a.uretim ? yuv(kwh / a.uretim * 10000) / 100 : null, tutar: kwh != null && bf != null ? yuv(kwh * bf) : null, tahmini: !k };
    });
    return { ay: a.ay, saat: a.saat, uretim: a.uretim, birim: bf != null ? yuv(bf * 10000) / 10000 : null, tutar: bf != null ? yuv(a.uretim * bf) : null, tesis };
  });
  return { tesisler: T, aylar, kaynak: 'Panel saatlik GES verisi · veriş (panelde "Toplam Üretim")', fiyat: 'Ayın emsal birimi: aynı ay CK2 ticarethane faturalarının ortanca TL/kWh’si (KDV ve vergiler dahil)' };
}

// GES mahsup tetkiki: tedarikçi faturalarında GES üretimi mevzuata göre tam mahsup edilmiş mi?
// Kaynaklar: faturaların PDF'i (okunan: fatura no → kalemler) ve panelin saatlik verisi (sayac: aylık çekiş / veriş / mahsup).
//  • Faturada düşülen mahsup: eksi kWh'li enerji kalemleri ("Enerji Bedeli (Ek)", "Enerji Bedeli(Ek Tük)…"; tarla mahsubunda
//    mağaza faturalarında, enerji düşer dağıtım ödenir) + eksi dağıtım satırları. Vergili tutar = (enerji × 1,05 ETV + dağıtım) × (1 + KDV).
//    Reaktif (İndüktif / Kapasitif) eksi satırlar mahsup değildir, sayılmaz.
//  • Hesaplanan tüm bedel (mahsupsuz) = reel fatura (PDF) + faturada düşülen mahsup (vergili): mahsup olmasaydı ödenecek tutar.
//  • Mevzuata göre mahsup kWh: 30.04.2026'ya kadar aylık min(çekiş, veriş); 01.05.2026'dan saatlik Σ min(çekiş, veriş).
//    Üretimin kalanı ihtiyaç fazlasıdır (mahsup edilmez, satılır): faturada görünmez, ayrıca ödenmeli. Değeri × fazla birim (vergisiz).
//  • Faturaların okuma dönemi takvim ayıyla örtüşmez (bir ayın mahsubu sonraki faturaya kayar): karar BİRİKİMLİ toplamla verilir.
const MAHSUP_TOLERANS = 0.03;
function mahsupKontrolu({ satirlar, okunan, sayac, birim, uretim, yilBasi = YIL_BASI }) {
  const S = Object.fromEntries((sayac || []).map(a => [a.ay, a])), U = Object.fromEntries(((uretim && uretim.aylar) || []).map(a => [a.ay, a]));
  const M = {};
  for (const s of satirlar) {
    if (s.donem < yilBasi || s.mukerrer) continue;
    const m = (M[s.donem] = M[s.donem] || { ay: s.donem, fatura: 0, pdf: 0, reel: 0, reelKwh: 0, odenen: 0, mahsupKwh: 0, mahsupTL: 0, mahsupFatura: 0, mahsupLok: [] });
    m.fatura++; m.odenen += +s.odenen || 0;
    const r = okunan && okunan.get ? okunan.get(s.faturaNo) : null;
    if (!r || r.faturaTutari == null) continue;
    m.pdf++; m.reel += r.faturaTutari; m.reelKwh += +r.tuketimKwh || 0;
    const ne = (r.kalemler || []).filter(k => k.miktar < 0 && /^Enerji Bedeli/i.test(k.ad));
    const nd = (r.diger || []).filter(x => x.tutar < 0 && /dağıtım/i.test(x.ad));
    if (!ne.length && !nd.length) continue;
    const kdv = r.kdv && r.kdvMatrah ? r.kdv / r.kdvMatrah : 0.2;
    const e = -ne.reduce((t, k) => t + k.tutar, 0), d = -nd.reduce((t, x) => t + x.tutar, 0);
    m.mahsupKwh -= ne.reduce((t, k) => t + k.miktar, 0); m.mahsupTL += (e * 1.05 + d) * (1 + kdv); m.mahsupFatura++; m.mahsupLok.push(s.lokasyon);
  }
  let kumKural = 0, kumFatura = 0, kumFazla = 0, kumFazlaTL = 0;
  const aylar = Object.values(M).sort((a, b) => a.ay.localeCompare(b.ay)).map(m => {
    const a = S[m.ay], u = U[m.ay], b = (birim || {})[m.ay] || {};
    const saatlik = m.ay + '-01' >= '2026-05-01';
    const r = {
      ay: m.ay, fatura: m.fatura, pdf: m.pdf, reel: yuv(m.reel), reelKwh: yuv(m.reelKwh), odenen: yuv(m.odenen),
      mahsupKwh: yuv(m.mahsupKwh), mahsupTL: yuv(m.mahsupTL), mahsupFatura: m.mahsupFatura, mahsupLok: m.mahsupLok,
      mahsupsuz: yuv(m.reel + m.mahsupTL), gesTL: u ? u.tutar : null, gesKwh: u ? u.uretim : null, rejim: saatlik ? 'Saatlik' : 'Aylık',
    };
    r.beklenen = r.gesTL != null ? yuv(r.mahsupsuz - r.gesTL) : null;          // GES'in tamamı mahsup edilseydi
    r.fark = r.beklenen != null ? yuv(r.odenen - r.beklenen) : null;            // + : GES değerinin faturaya yansımayan kısmı
    if (a && a.uretim) {
      r.kuralKwh = yuv(saatlik ? a.saatlikMahsup : a.aylikMahsup);
      r.fazlaKwh = yuv(a.uretim - r.kuralKwh);
      r.fazlaTL = b.fazla != null ? yuv(r.fazlaKwh * b.fazla) : null;
      r.fazlaBirim = b.fazla != null ? b.fazla : null;
      kumKural += r.kuralKwh; kumFatura += m.mahsupKwh; kumFazla += r.fazlaKwh; kumFazlaTL += r.fazlaTL || 0;
      r.kumKural = yuv(kumKural); r.kumFatura = yuv(kumFatura); r.kumFark = yuv(kumFatura - kumKural); r.kumFarkYuzde = kumKural ? yuv((kumFatura - kumKural) / kumKural * 100) : null;
      r.ayFark = yuv(m.mahsupKwh - r.kuralKwh);
      r.durum = Math.abs(r.kumFarkYuzde) <= MAHSUP_TOLERANS * 100 ? 'tam' : r.kumFark < 0 ? 'eksik' : 'fazla';
    } else r.durum = 'veri-yok';
    return r;
  });
  const sonVeri = aylar.filter(a => a.kuralKwh != null).pop();
  const ozet = sonVeri ? {
    bas: aylar.find(a => a.kuralKwh != null).ay, son: sonVeri.ay, kuralKwh: sonVeri.kumKural, faturaKwh: sonVeri.kumFatura, farkKwh: sonVeri.kumFark, farkYuzde: sonVeri.kumFarkYuzde,
    durum: sonVeri.durum, fazlaKwh: yuv(kumFazla), fazlaTL: yuv(kumFazlaTL),
    veriYok: aylar.filter(a => a.durum === 'veri-yok').map(a => ({ ay: a.ay, mahsupKwh: a.mahsupKwh, mahsupTL: a.mahsupTL })),
  } : null;
  return { aylar, ozet, tolerans: MAHSUP_TOLERANS };
}

module.exports = { gesMahsup, gesSozlesmeleri, gesUretimi, mahsupKontrolu };
