// supabase_yukle.js — Uygulamanın sakladığı tüm fatura/GES verisini ve sözleşme ayarlarını Supabase'e gönderir.
// Sunucu bunu panel her okunduğunda kendisi yapar; bu araç elle / ilk yükleme içindir.
// Kullanım: node araclar/supabase_yukle.js   (ayarlar: bu klasördeki .env → SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const fs = require('fs');
const path = require('path');
const { supabase, envOku } = require('../lib/elektrik_supabase.js');

const KOK = path.join(__dirname, '..');
const env = { ...envOku(path.join(KOK, '.env')), ...process.env };
const KLASORLER = [env.MASAUSTU_VERI, env.DATA_DIR, path.join(KOK, 'veri'), path.join(KOK, '..')].filter(Boolean);
const bul = ad => KLASORLER.map(k => path.join(k, ad)).find(f => fs.existsSync(f));
const jsonOku = (ad, vars) => { const f = bul(ad); try { return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : vars; } catch (e) { return vars; } };

(async () => {
  const S = supabase(env);
  if (!S.hazir) throw new Error('.env dosyasında SUPABASE_URL ve SUPABASE_SERVICE_ROLE_KEY tanımlı olmalı.');
  const p = (jsonOku('elektrik_mahsup_veri.json', {}) || {}).panelVeri;
  if (!p) throw new Error('Saklanan panel verisi (elektrik_mahsup_veri.json) bulunamadı.');
  // Supabase'de kayıtlı sözleşme ayarları yereldekilerle birleştirilir (Supabase'deki geçerli), sonra hepsi gönderilir
  const b = await S.ayarlariBirlestir(jsonOku('elektrik_firma_ayar.json', {}), jsonOku('elektrik_ges_ayar.json', {}));
  console.log('Gönderiliyor →', S.adres);
  const r = await S.gonder(p, b.firmaAyar, b.gesAyar);
  console.log('Tamam ·', Object.entries(r).map(([t, n]) => t + ': ' + n).join(' · '));
})().catch(e => { console.error('HATA:', e.message); process.exitCode = 1; });
