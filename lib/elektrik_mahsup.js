// elektrik_mahsup.js — ELEKTRİK ANALİZİ · Fatura ve mahsuplaşma kontrol motoru (Ocak 2026 →)
//
// Düzenlenen elektrik faturalarını (8010 elektrik paneli) EPDK tarifeleri, 2464/KDV vergi kuralları ve
// lisanssız üretim mahsup kurallarıyla yeniden hesaplar, kalem kalem karşılaştırır.
//  • Mahsup rejimi: 01.05.2026 öncesi AYLIK, sonrası SAATLİK (RG 02.04.2026/33212, mesken hariç).
//  • Aylık mahsup çok zamanlı tarifede zaman dilimi (gündüz/puant/gece) bazında netleştirilir.
//  • Ay içinde tarife değişirse (ör. 04.04.2026) saatlik veri varsa her gün kendi tarifesiyle,
//    yoksa tüketim gün sayısına oranlanarak hesaplanır.
//  • İhtiyaç fazlası: tek zamanlı aktif enerji bedeli − veriş yönlü dağıtım bedeli (GES: LÜ-2).
//  • ETV yalnızca aktif enerji bedeline (2464 m.37-38), KDV enerji+dağıtım+güç+reaktif+ETV toplamına.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAHSUP_BASLANGIC = '2026-01';
const SAATLIK_MAHSUP_BASLANGIC = '2026-05-01';
const TOLERANS_TL = 1;        // kuruş yuvarlamaları için
const TOLERANS_ORAN = 0.005;  // %0,5

const iki = n => String(n).padStart(2, '0');
const gunleri = ay => { const [y, m] = ay.split('-').map(Number); const n = new Date(y, m, 0).getDate(); return Array.from({ length: n }, (_, i) => ay + '-' + iki(i + 1)); };
const dilim = h => h >= 6 && h < 17 ? 'gunduz' : h >= 17 && h < 22 ? 'puant' : 'gece';
const yuvarla = v => v == null ? null : Math.round(v * 100) / 100;

function gunTarifesi(tarifeler, gun) { let t = null; for (const x of tarifeler) if (x.gecerlilik <= gun) t = x; return t || tarifeler[0]; }

// Adresten "İlçe/İl" çıkarır: "... 07320 Kepez/Antalya" → { ilce: 'Kepez', il: 'Antalya' }
function belediyeBul(adres) {
  if (!adres) return null;
  const m = /([A-ZÇĞİÖŞÜa-zçğıöşü]+)\s*\/\s*([A-ZÇĞİÖŞÜa-zçğıöşü]+)\s*$/.exec(String(adres).trim()) ||
            /([A-ZÇĞİÖŞÜa-zçğıöşü]+)\s*\/\s*([A-ZÇĞİÖŞÜa-zçğıöşü]+)/.exec(String(adres));
  return m ? { ilce: m[1], il: m[2] } : null;
}

// ─── Beklenen fatura hesabı ─────────────────────────────────────────────────────────────────────
// tesis: { tesisatNo, tarifeSinifi: 'AG'|'AG_dusuk'|'OGT'|'OGC', zaman: 'tek'|'uc', etv: 'diger'|'imal', lu: 'LU2'|'LU1'|'yok', sozlesmeGucuKw }
// olcum: { 'YYYY-MM-DD': { cekis:[24], veris:[24], enduktif?:[24], kapasitif?:[24] } }  (saatlik, kWh / kVArh)
// fatura: faturadaki toplamlar (saatlik veri yoksa çekiş/veriş kWh buradan alınır)
// rejim: 'saatlik' | 'aylik' verilirse tarihten bağımsız o rejimle hesaplar (etki karşılaştırması için)
function beklenenHesapla({ tesis, ay, olcum, fatura, tarifeler, etvOranlari, rejim }) {
  const gunler = gunleri(ay);
  const saatlikRejim = rejim ? rejim === 'saatlik' : ay + '-01' >= SAATLIK_MAHSUP_BASLANGIC;
  const saatlikVeri = olcum && gunler.every(g => olcum[g] && olcum[g].cekis && olcum[g].veris);
  const s = tesis.tarifeSinifi || 'AG', uc = tesis.zaman === 'uc';
  const etvOran = tesis.etv === 'imal' ? (etvOranlari ? etvOranlari.imal : 1) / 100 : (etvOranlari ? etvOranlari.diger : 5) / 100;
  const notlar = [];
  const tarifeSeti = [...new Set(gunler.map(g => gunTarifesi(tarifeler, g).gecerlilik))];
  if (tarifeSeti.length > 1) notlar.push('Ay içinde tarife değişti (' + tarifeSeti.join(' → ') + '); ' + (saatlikVeri ? 'her gün kendi tarifesiyle' : 'gün sayısına oranlanarak') + ' hesaplandı.');

  // Bileşen toplayıcı: kWh × (kr/kWh) → TL
  let tuketimKwh = 0, fazlaKwh = 0, cekisKwh = 0, verisKwh = 0, enerjiTL = 0, dagitimTL = 0, fazlaTL = 0;
  let enduktif = 0, kapasitif = 0, reaktifVar = false;
  const fiyat = (t, h) => { const x = t[s]; return { enerji: uc ? x[dilim(h)] : x.tek, dagitim: x.dagitim, fazla: t[s].tek - (tesis.lu === 'yok' ? 0 : (t[tesis.lu || 'LU2'] || 0)) }; };

  if (saatlikVeri) {
    // Dilim bazlı aylık netleştirme için birikimler
    const dil = { gunduz: { c: 0, v: 0, e: 0, d: 0, f: 0 }, puant: { c: 0, v: 0, e: 0, d: 0, f: 0 }, gece: { c: 0, v: 0, e: 0, d: 0, f: 0 }, tek: { c: 0, v: 0, e: 0, d: 0, f: 0 } };
    for (const g of gunler) {
      const t = gunTarifesi(tarifeler, g), o = olcum[g];
      for (let h = 0; h < 24; h++) {
        const c = +o.cekis[h] || 0, v = +o.veris[h] || 0, p = fiyat(t, h);
        cekisKwh += c; verisKwh += v;
        if (o.enduktif) { enduktif += +o.enduktif[h] || 0; reaktifVar = true; }
        if (o.kapasitif) { kapasitif += +o.kapasitif[h] || 0; reaktifVar = true; }
        if (saatlikRejim) {
          const net = c - v;
          if (net > 0) { tuketimKwh += net; enerjiTL += net * p.enerji / 100; dagitimTL += net * p.dagitim / 100; }
          else { fazlaKwh += -net; fazlaTL += -net * p.fazla / 100; }
        } else {
          const b = dil[uc ? dilim(h) : 'tek'];
          b.c += c; b.v += v; b.e += c * p.enerji; b.d += c * p.dagitim; b.f += v * p.fazla;
        }
      }
    }
    if (!saatlikRejim) for (const b of Object.values(dil)) {
      if (!b.c && !b.v) continue;
      const net = b.c - b.v;
      // Ağırlıklı ortalama birim fiyat (ay içi tarife değişimini tüketim ağırlığıyla yansıtır)
      const eOrt = b.c ? b.e / b.c : 0, dOrt = b.c ? b.d / b.c : 0, fOrt = b.v ? b.f / b.v : 0;
      if (net > 0) { tuketimKwh += net; enerjiTL += net * eOrt / 100; dagitimTL += net * dOrt / 100; }
      else { fazlaKwh += -net; fazlaTL += -net * fOrt / 100; }
    }
  } else if (fatura && fatura.cekisKwh != null) {
    if (saatlikRejim) notlar.push('Saatlik mahsup dönemi ama saatlik sayaç verisi yok: mahsup miktarı DOĞRULANAMADI, sadece faturadaki kWh üzerinden fiyat kontrolü yapıldı.');
    cekisKwh = +fatura.cekisKwh || 0; verisKwh = +fatura.verisKwh || 0;
    // Saatlik rejimde faturadaki mahsup sonrası miktarlar esas alınır; aylık rejimde net hesaplanır
    if (saatlikRejim && fatura.tuketimKwh != null) { tuketimKwh = +fatura.tuketimKwh; fazlaKwh = +fatura.fazlaKwh || 0; }
    else { const net = cekisKwh - verisKwh; tuketimKwh = Math.max(net, 0); fazlaKwh = Math.max(-net, 0); }
    if (uc) notlar.push('Çok zamanlı tarife için dilim kırılımı olmadan tek zamanlı ortalama kullanıldı.');
    // Gün sayısına oranlı fiyat
    for (const g of gunler) {
      const t = gunTarifesi(tarifeler, g), w = 1 / gunler.length, x = t[s];
      enerjiTL += tuketimKwh * w * x.tek / 100; dagitimTL += tuketimKwh * w * x.dagitim / 100;
      fazlaTL += fazlaKwh * w * (x.tek - (tesis.lu === 'yok' ? 0 : (t[tesis.lu || 'LU2'] || 0))) / 100;
    }
  } else {
    return { durum: 'veri-yok', notlar: ['Bu ay için ne saatlik sayaç verisi ne de faturada kWh bilgisi var.'] };
  }

  // Güç bedeli (OG çift terim): sözleşme gücü × güç bedeli, gün oranlı
  let gucTL = 0;
  if (s === 'OGC') {
    const kw = +(tesis.sozlesmeGucuKw || (fatura && fatura.sozlesmeGucuKw)) || 0;
    if (kw) for (const g of gunler) gucTL += kw * (gunTarifesi(tarifeler, g).gucBedeli || 0) / 100 / gunler.length;
    else notlar.push('OG çift terim ama sözleşme gücü bilinmiyor: güç bedeli hesaplanamadı.');
  }
  // Reaktif: limit aşılırsa ölçülen reaktifin tamamı faturalanır (≥50 kVA: endüktif %20, kapasitif %15)
  let reaktifTL = 0;
  const aktif = cekisKwh || 1;
  if (reaktifVar) {
    const rb = gunTarifesi(tarifeler, gunler[gunler.length - 1]).reaktif || 0;
    const kucuk = (tesis.kuruluGucKva || 50) < 50;
    const eSinir = kucuk ? 0.33 : 0.20, kSinir = kucuk ? 0.20 : 0.15;
    if (enduktif / aktif > eSinir) { reaktifTL += enduktif * rb / 100; notlar.push('Endüktif oran %' + (enduktif / aktif * 100).toFixed(1) + ' > sınır %' + eSinir * 100 + ': reaktif bedel doğar.'); }
    if (kapasitif / aktif > kSinir) { reaktifTL += kapasitif * rb / 100; notlar.push('Kapasitif oran %' + (kapasitif / aktif * 100).toFixed(1) + ' > sınır %' + kSinir * 100 + ': reaktif bedel doğar.'); }
  }
  const etvTL = enerjiTL * etvOran;
  const kdvTL = (enerjiTL + dagitimTL + gucTL + reaktifTL + etvTL) * 0.20;
  return {
    durum: 'hesaplandi', rejim: saatlikRejim ? 'Saatlik' : 'Aylık', saatlikVeri, tarifeler: tarifeSeti, notlar,
    cekisKwh: yuvarla(cekisKwh), verisKwh: yuvarla(verisKwh), tuketimKwh: yuvarla(tuketimKwh), fazlaKwh: yuvarla(fazlaKwh),
    aktifEnerjiTL: yuvarla(enerjiTL), dagitimTL: yuvarla(dagitimTL), gucTL: yuvarla(gucTL), reaktifTL: yuvarla(reaktifTL),
    etvTL: yuvarla(etvTL), kdvTL: yuvarla(kdvTL), toplamTL: yuvarla(enerjiTL + dagitimTL + gucTL + reaktifTL + etvTL + kdvTL),
    fazlaBedelTL: yuvarla(fazlaTL),
  };
}

// Saatlik sayaç verisi varsa aynı ay için iki rejimi de hesaplar: saatlik mahsubun etkisi (TL) görünür
function rejimEtkisi(args) {
  const a = beklenenHesapla({ ...args, rejim: 'aylik' }), s = beklenenHesapla({ ...args, rejim: 'saatlik' });
  if (a.durum !== 'hesaplandi' || !a.saatlikVeri) return null;
  const net = x => x.toplamTL - x.fazlaBedelTL; // ödenecek − alacak
  return { aylik: a, saatlik: s, farkTL: yuvarla(net(s) - net(a)) };
}

const KALEMLER = [
  ['tuketimKwh', 'Faturalanan tüketim (mahsup sonrası)', 'kWh'], ['fazlaKwh', 'İhtiyaç fazlası (mahsup sonrası)', 'kWh'],
  ['aktifEnerjiTL', 'Aktif enerji bedeli', 'TL'], ['dagitimTL', 'Dağıtım bedeli', 'TL'], ['gucTL', 'Güç bedeli', 'TL'],
  ['reaktifTL', 'Reaktif enerji bedeli', 'TL'], ['etvTL', 'Elektrik tüketim vergisi', 'TL'], ['kdvTL', 'KDV', 'TL'],
  ['toplamTL', 'Fatura toplamı', 'TL'], ['fazlaBedelTL', 'İhtiyaç fazlası bedeli (alacak)', 'TL'],
];
function karsilastir(fatura, hesap) {
  const satirlar = [];
  let farkli = 0, kontrol = 0;
  for (const [k, ad, birim] of KALEMLER) {
    const f = fatura[k], h = hesap[k];
    if (f == null || h == null) { satirlar.push({ k, ad, birim, fatura: f ?? null, hesap: h ?? null, fark: null, durum: 'yok' }); continue; }
    const fark = +(f - h).toFixed(2);
    const tol = Math.max(birim === 'TL' ? TOLERANS_TL : 1, Math.abs(h) * TOLERANS_ORAN);
    const ok = Math.abs(fark) <= tol;
    kontrol++; if (!ok) farkli++;
    satirlar.push({ k, ad, birim, fatura: f, hesap: h, fark, durum: ok ? 'ok' : 'fark' });
  }
  const sebepler = [];
  const s = Object.fromEntries(satirlar.map(x => [x.k, x]));
  if (s.tuketimKwh.durum === 'fark' || s.fazlaKwh.durum === 'fark') sebepler.push('Mahsup miktarı farklı: mahsup rejimi (aylık/saatlik) veya sayaç verisi uyuşmuyor olabilir.');
  if (s.tuketimKwh.durum === 'ok' && s.aktifEnerjiTL.durum === 'fark') sebepler.push('Miktar doğru ama aktif enerji bedeli farklı: yanlış tarife sınıfı/dönemi ya da Son Kaynak Tedarik Tarifesi uygulanmış olabilir.');
  if (s.tuketimKwh.durum === 'ok' && s.dagitimTL.durum === 'fark') sebepler.push('Dağıtım bedeli farklı: gerilim seviyesi veya terim (tek/çift) farklı uygulanmış olabilir.');
  if (s.aktifEnerjiTL.durum === 'ok' && s.etvTL.durum === 'fark') sebepler.push('Tüketim vergisi farklı: %5 yerine %1 (imal) uygulanmış olabilir ya da vergi dağıtım bedeline de uygulanmış olabilir.');
  if (s.fazlaBedelTL.durum === 'fark') sebepler.push('İhtiyaç fazlası bedeli farklı: birim fiyat (aktif enerji − LÜ-2) veya üretim sınırı (önceki yıl tüketiminin 2 katı) kontrol edilmeli.');
  return { satirlar, farkli, kontrol, sonuc: !kontrol ? 'veri-yok' : farkli ? 'farkli' : 'ortusuyor', sebepler };
}

// ─── Saatlik sayaç (OSOS) dosyası çözümü ─────────────────────────────────────────────────────────
// Esnek başlık eşleme: Tarih | Saat | Çekiş/Tüketim | Veriş/Üretim | Endüktif | Kapasitif (| Tesisat No)
function olcumCoz(satirlar) {
  if (!satirlar.length) throw new Error('Dosya boş.');
  const bas = satirlar.findIndex(r => r.some(c => typeof c === 'string' && /tarih|date/i.test(c)));
  if (bas < 0) throw new Error('"Tarih" başlıklı sütun bulunamadı.');
  const h = satirlar[bas].map(c => String(c || '').toLocaleLowerCase('tr-TR'));
  const bul = re => h.findIndex(c => re.test(c));
  const iT = bul(/tarih|date/), iS = bul(/^saat|hour|zaman/), iC = bul(/çekiş|cekis|tüketim|tuketim|alış|import|çekilen/),
    iV = bul(/veriş|veris|üretim|uretim|verilen|export/), iE = bul(/endüktif|enduktif|ri\b/), iK = bul(/kapasitif|rc\b/), iN = bul(/tesisat|abone/);
  if (iC < 0) throw new Error('Çekiş/tüketim sütunu bulunamadı.');
  const sayi = v => typeof v === 'number' ? v : Number(String(v || '0').replace(/\./g, '').replace(',', '.')) || 0;
  const tesisler = {};
  for (const r of satirlar.slice(bas + 1)) {
    let t = r[iT]; if (t == null || t === '') continue;
    let gun, saat;
    if (typeof t === 'number') { const d = new Date(Math.round((t - 25569) * 86400000)); gun = d.toISOString().slice(0, 10); saat = d.getUTCHours(); }
    else {
      const m = /(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})(?:[ T](\d{1,2}))?/.exec(String(t));
      if (!m) continue;
      const [a, b, c] = [m[1], m[2], m[3]];
      gun = a.length === 4 ? a + '-' + iki(b) + '-' + iki(c) : c + '-' + iki(b) + '-' + iki(a);
      saat = m[4] != null ? +m[4] : null;
    }
    if (iS >= 0 && r[iS] != null && r[iS] !== '') { const sv = r[iS]; saat = typeof sv === 'number' ? (sv < 1 ? Math.round(sv * 24) : sv) : parseInt(String(sv), 10); }
    if (saat == null || isNaN(saat)) continue;
    if (saat === 24) saat = 0;
    const no = iN >= 0 && r[iN] ? String(r[iN]).trim() : '_';
    const o = (tesisler[no] = tesisler[no] || {});
    const g = (o[gun] = o[gun] || { cekis: new Array(24).fill(0), veris: new Array(24).fill(0) });
    g.cekis[saat] += sayi(r[iC]);
    if (iV >= 0) g.veris[saat] += sayi(r[iV]);
    if (iE >= 0) { g.enduktif = g.enduktif || new Array(24).fill(0); g.enduktif[saat] += sayi(r[iE]); }
    if (iK >= 0) { g.kapasitif = g.kapasitif || new Array(24).fill(0); g.kapasitif[saat] += sayi(r[iK]); }
  }
  return tesisler;
}

// ─── Kalıcı depo ────────────────────────────────────────────────────────────────────────────────
function depo(klasor) {
  const DOSYA = path.join(klasor, 'elektrik_mahsup_veri.json');
  const HAM = path.join(klasor, 'elektrik_panel_ham');
  if (!fs.existsSync(HAM)) fs.mkdirSync(HAM);
  const oku = () => { try { return JSON.parse(fs.readFileSync(DOSYA, 'utf8')); } catch (e) { return { tesisler: {}, faturalar: [], olcum: {}, panel: {} }; } };
  const yaz = v => fs.writeFileSync(DOSYA, JSON.stringify(v), 'utf8');
  // Ham panel anlık görüntüsü: içerik değiştiyse zaman damgalı dosya olarak saklanır
  const hamSakla = (ad, icerik) => {
    const hash = crypto.createHash('sha1').update(icerik).digest('hex').slice(0, 12);
    const mevcut = fs.readdirSync(HAM).find(f => f.includes(hash));
    if (mevcut) return { dosya: mevcut, yeni: false };
    const d = new Date(), dam = d.getFullYear() + iki(d.getMonth() + 1) + iki(d.getDate()) + '_' + iki(d.getHours()) + iki(d.getMinutes());
    const dosya = dam + '_' + ad.replace(/[^A-Za-z0-9_-]/g, '_') + '_' + hash + (/^\s*[[{]/.test(icerik) ? '.json' : '.html');
    fs.writeFileSync(path.join(HAM, dosya), icerik, 'utf8');
    return { dosya, yeni: true };
  };
  return { oku, yaz, hamSakla, HAM };
}

module.exports = { MAHSUP_BASLANGIC, SAATLIK_MAHSUP_BASLANGIC, beklenenHesapla, rejimEtkisi, karsilastir, olcumCoz, belediyeBul, depo, gunleri, KALEMLER };
