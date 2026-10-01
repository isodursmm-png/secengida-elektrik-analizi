// panel_senkron.js — Elektrik Fatura Paneli verisini bulut sunucusuna (Render) gönderir.
//
// Bulut sunucusu yerel ağdaki panele (Sami PC, port 8010) erişemez; bu araç masaüstünde çalışır:
//  1) Panelden /durum, /veri, /lokasyonlar, /ges-veri okunur.
//  2) Panel kapalıysa masaüstü uygulamasının sakladığı son veri (elektrik_mahsup_veri.json) gönderilir.
//  3) Firma ve GES ayarları da eklenir. Bulut tarafı EKLEMELİ birleştirir, hiçbir kayıt silinmez.
// Gerekli .env satırları: SENKRON_ANAHTARI (Render'daki değerle aynı), BULUT_URL. İsteğe bağlı: PANEL_URL, MASAUSTU_VERI.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const KOK = path.join(__dirname, '..');
try { for (const satir of fs.readFileSync(path.join(KOK, '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(satir); if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) { }

const ANAHTAR = process.env.SENKRON_ANAHTARI;
const BULUT_URL = (process.env.BULUT_URL || '').replace(/\/+$/, '');
const PANEL = process.env.PANEL_URL || 'http://192.168.0.106:8010';
// Masaüstü uygulamasının veri klasörleri (ilk bulunan dosya kullanılır)
const KLASORLER = [process.env.MASAUSTU_VERI, process.env.DATA_DIR, path.join(KOK, 'veri'), path.join(KOK, '..')].filter(Boolean);
const bul = ad => KLASORLER.map(k => path.join(k, ad)).find(f => fs.existsSync(f));
const jsonOku = ad => { const f = bul(ad); try { return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (e) { return null; } };

function getir(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers, timeout: 180000 }, res => {
      const p = []; res.on('data', c => p.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(p).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Zaman aşımı: ' + url)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function panelden() {
  const s = {};
  for (const uc of ['/durum', '/veri', '/lokasyonlar', '/ges-veri']) {
    const r = await getir(PANEL + uc);
    if (r.status !== 200) throw new Error(uc + ' HTTP ' + r.status);
    s[uc] = JSON.parse(r.body);
  }
  s.kaynak = 'panel ' + PANEL;
  return s;
}

// Panel kapalıyken: masaüstünün birikmiş panel verisini panel biçimine çevirir
function saklanandan() {
  const v = jsonOku('elektrik_mahsup_veri.json'), p = v && v.panelVeri;
  if (!p) throw new Error('Masaüstünde saklanan panel verisi (elektrik_mahsup_veri.json) bulunamadı.');
  const ges = [];
  for (const [tarih, o] of Object.entries(p.gesSaatlik || {}))
    for (let saat = 0; saat < 24; saat++) if (o.cekis[saat] || o.veris[saat]) ges.push({ tarih, saat, cekis: o.cekis[saat], veris: o.veris[saat] });
  return {
    kaynak: 'masaüstü kaydı ' + (p.alinma || ''),
    '/durum': { ok: true, klasor: p.klasor || null },
    '/veri': { ok: true, kayitlar: p.faturalar.map(({ eklenme, guncelleme, ...f }) => f) },
    '/lokasyonlar': { ok: true, kayitlar: p.lokasyonlar || [] },
    '/ges-veri': { ok: true, kayitlar: ges },
  };
}

(async () => {
  if (!ANAHTAR || !BULUT_URL) throw new Error('.env dosyasında SENKRON_ANAHTARI ve BULUT_URL tanımlı olmalı (' + path.join(KOK, '.env') + ').');
  let veri;
  try { veri = await panelden(); console.log('Panel okundu:', PANEL); }
  catch (e) { console.log('Panele ulaşılamadı (' + e.message + '), masaüstünde saklanan veri gönderiliyor.'); veri = saklanandan(); }
  const firma = jsonOku('elektrik_firma_ayar.json'), ges = jsonOku('elektrik_ges_ayar.json');
  if (firma || ges) veri.ayarlar = { ...(firma ? { firma } : {}), ...(ges ? { ges } : {}) };
  console.log('Gönderiliyor:', (veri['/veri'].kayitlar || []).length, 'fatura,', (veri['/ges-veri'].kayitlar || []).length, 'saatlik GES kaydı →', BULUT_URL);
  const govde = JSON.stringify(veri);
  const r = await getir(BULUT_URL + '/api/panel/yukle', { method: 'POST', body: govde, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(govde), 'x-senkron-anahtari': ANAHTAR } });
  let j = {}; try { j = JSON.parse(r.body); } catch (e) { }
  if (r.status !== 200 || !j.ok) throw new Error('Bulut yanıtı HTTP ' + r.status + ': ' + (j.hata || r.body.slice(0, 300)));
  console.log('Tamam · gelen', j.gelen, '· yeni', j.yeni, '· güncellenen', j.guncellenen, '· yeni GES günü', j.gesYeniGun);
})().catch(e => { console.error('HATA:', e.message); process.exitCode = 1; });
