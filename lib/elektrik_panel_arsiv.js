// elektrik_panel_arsiv.js — Elektrik Fatura Paneli okumalarının gün ve ay bazlı arşivi
//
// Klasör: <veri>/elektrik_panel_arsiv/
//   okuma_gunlugu.jsonl                 her okuma denemesi (başarılı/başarısız) bir satır — her koşulda yazılır
//   2026-09/2026-09-30/0830_veri.json   gün klasörü: günün ilk okuması tam saklanır, sonrası yalnızca içerik değiştiyse
//   2026-09/2026-09-30/0830_ges.html    panel sayfaları da aynı kuralla (ekranda görünen hali)
//   tablolar/2026/faturalar_2026-09.csv dönem bazlı fatura tablosu (Excel ile açılır; biriken tüm kayıtlardan)
//   tablolar/2026/faturalar_2026_tum.csv yılın tüm faturaları tek tabloda
//   tablolar/2026/ges_saatlik_2026-09.csv ay bazlı saatlik GES çekiş/veriş tablosu
// Arşivden hiçbir şey silinmez.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const iki = n => String(n).padStart(2, '0');
const ozet = s => crypto.createHash('sha1').update(s).digest('hex');
// Excel (Türkçe): ';' ayraç, ondalık virgül, UTF-8 BOM
const hucre = v => v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : /[;"\r\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
const csv = (baslik, satirlar) => '﻿' + [baslik, ...satirlar].map(s => s.map(hucre).join(';')).join('\r\n') + '\r\n';
function yazDegistiyse(f, icerik) {
  try { if (fs.readFileSync(f, 'utf8') === icerik) return false; } catch (e) { }
  fs.writeFileSync(f, icerik, 'utf8');
  return true;
}

function arsiv(veriKlasoru) {
  const KOK = path.join(veriKlasoru, 'elektrik_panel_arsiv');
  const TABLO = path.join(KOK, 'tablolar');
  fs.mkdirSync(TABLO, { recursive: true });
  const GUNLUK = path.join(KOK, 'okuma_gunlugu.jsonl');
  const SON = path.join(KOK, 'son_ozetler.json');

  const gunluk = kayit => fs.appendFileSync(GUNLUK, JSON.stringify({ zaman: new Date().toISOString(), ...kayit }) + '\n', 'utf8');

  // icerikler: { 'veri': '<json metni>', 'ges.html': '<html>', ... }
  function sakla(icerikler, bilgi = {}) {
    const simdi = new Date();
    const gun = simdi.getFullYear() + '-' + iki(simdi.getMonth() + 1) + '-' + iki(simdi.getDate());
    const saat = iki(simdi.getHours()) + iki(simdi.getMinutes());
    const klasor = path.join(KOK, gun.slice(0, 7), gun);
    fs.mkdirSync(klasor, { recursive: true });
    let son = {}; try { son = JSON.parse(fs.readFileSync(SON, 'utf8')); } catch (e) { }
    const yazilan = [];
    for (const [ad, metin] of Object.entries(icerikler)) {
      if (metin == null) continue;
      const h = ozet(metin), onceki = son[ad] || {};
      // Günün ilk okuması her zaman tam saklanır; gün içinde yalnızca değişen içerik
      if (onceki.gun === gun && onceki.ozet === h) continue;
      fs.writeFileSync(path.join(klasor, saat + '_' + ad + (/\.\w+$/.test(ad) ? '' : '.json')), metin, 'utf8');
      son[ad] = { gun, ozet: h };
      yazilan.push(ad);
    }
    fs.writeFileSync(SON, JSON.stringify(son), 'utf8');
    gunluk({ ok: true, ...bilgi, yazilan });
    return { klasor, yazilan };
  }

  // Biriken panel verisinden (eklemeli depo) ay bazlı tablolar
  function tablolar(panelVeri) {
    if (!panelVeri) return [];
    const degisen = [];
    const yilKlasoru = yil => { const k = path.join(TABLO, yil); fs.mkdirSync(k, { recursive: true }); return k; };
    const FATURA_BASLIK = ['Dönem', 'Sözleşme no', 'Lokasyon', 'Grup', 'Tüketim (kWh)', 'Ödenecek (TL)', 'Birim fiyat (TL/kWh)', 'Dosya', 'Dosya yolu', 'İlk görülme', 'Son değişiklik'];
    const faturaSatiri = f => [f.donem, f.sozlesmeNo, f.lokasyon, f.grup, f.tuketim, f.odenecek, f.birimFiyat, f.dosya, f.dosyaYolu, f.eklenme, f.guncelleme];
    const lokSira = (a, b) => String(a.lokasyon).localeCompare(String(b.lokasyon), 'tr');
    const donemler = {}, yillar = {};
    for (const f of panelVeri.faturalar || []) {
      (donemler[f.donem] = donemler[f.donem] || []).push(f);
      (yillar[String(f.donem).slice(0, 4)] = yillar[String(f.donem).slice(0, 4)] || []).push(f);
    }
    // tablolar/2026/faturalar_2026-01.csv … (dönem bazlı) ve tablolar/2026/faturalar_2026_tum.csv (yıllık)
    for (const [donem, liste] of Object.entries(donemler)) {
      const icerik = csv(FATURA_BASLIK, liste.sort(lokSira).map(faturaSatiri));
      if (yazDegistiyse(path.join(yilKlasoru(donem.slice(0, 4)), 'faturalar_' + donem + '.csv'), icerik)) degisen.push('faturalar_' + donem);
    }
    for (const [yil, liste] of Object.entries(yillar)) {
      const icerik = csv(FATURA_BASLIK, liste.sort((a, b) => String(a.donem).localeCompare(String(b.donem)) || lokSira(a, b)).map(faturaSatiri));
      if (yazDegistiyse(path.join(yilKlasoru(yil), 'faturalar_' + yil + '_tum.csv'), icerik)) degisen.push('faturalar_' + yil + '_tum');
    }
    const aylar = {};
    for (const [gun, o] of Object.entries(panelVeri.gesSaatlik || {})) (aylar[gun.slice(0, 7)] = aylar[gun.slice(0, 7)] || []).push([gun, o]);
    for (const [ay, gunler] of Object.entries(aylar)) {
      const satirlar = [];
      for (const [gun, o] of gunler.sort((a, b) => a[0].localeCompare(b[0]))) for (let s = 0; s < 24; s++) satirlar.push([gun, iki(s) + ':00', o.cekis[s], o.veris[s], +(o.cekis[s] - o.veris[s]).toFixed(3)]);
      if (yazDegistiyse(path.join(yilKlasoru(ay.slice(0, 4)), 'ges_saatlik_' + ay + '.csv'), csv(['Gün', 'Saat', 'Çekiş (kWh)', 'Veriş (kWh)', 'Net (kWh)'], satirlar))) degisen.push('ges_saatlik_' + ay);
    }
    const lok = (panelVeri.lokasyonlar || []).slice().sort((a, b) => String(a.lokasyon).localeCompare(String(b.lokasyon), 'tr'));
    if (yazDegistiyse(path.join(TABLO, 'lokasyonlar.csv'), csv(['Sözleşme no', 'Lokasyon', 'Grup'], lok.map(l => [l.sozlesmeNo, l.lokasyon, l.grup])))) degisen.push('lokasyonlar');
    return degisen;
  }

  return { KOK, sakla, tablolar, hata: (mesaj, bilgi = {}) => gunluk({ ok: false, hata: mesaj, ...bilgi }) };
}

module.exports = { arsiv };
