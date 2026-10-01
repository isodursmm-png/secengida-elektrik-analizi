// elektrik_supabase.js — Fatura/GES verisini ve sözleşme ayarlarını Supabase'e yazar, oradan geri okur.
//
// Tablolar: supabase/001_sema.sql (public.elektrik_*). Erişim: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// (secret anahtar; yalnızca sunucuda durur). REST (PostgREST) üzerinden upsert yapılır; aynı veri kaç kez
// gönderilirse gönderilsin mükerrer oluşmaz.
//  • Masaüstü: panel okununca gönderir; göndermeden önce sözleşme ayarlarını (firma, güvence, GES türü)
//    Supabase'den çeker — bulutta yapılan değişiklik masaüstünde ezilmez.
//  • Bulut: veriyi Supabase'den okur (yerel ağdaki panele erişemez, diski kalıcı değildir).
// Sözleşme ayarlarında son elle kaydedilen değer geçerlidir (hangi taraftan kaydedildiği fark etmez).
const fs = require('fs');
const GUVENCE = require('./elektrik_guvence.js');

const VARSAYILAN_FIRMALAR = ['SECEN', 'SECENGIDA', 'SECENART', 'PRENSES', 'TAHTAKALE', 'USRE (BİRİKİM)'];
// Sunucudaki firmaTahmini ile aynı kural
const firmaTahmini = (grup, lokasyon) => /USRE/i.test(lokasyon || '') ? 'USRE (BİRİKİM)' : grup === 'TAHTAKALE SPOT' ? 'TAHTAKALE' : grup === 'SECEN GROSS' ? 'SECEN' : null;
const sayi = v => v == null || v === '' || !isFinite(+v) ? null : +v;

function envOku(dosya) {
  const e = {};
  try { for (const s of fs.readFileSync(dosya, 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(s); if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (err) { }
  return e;
}

// Uygulama verisi → tablo satırları
function satirlar(panelVeri, firmaAyar = {}, gesAyar = {}) {
  const soz = new Map();
  for (const f of panelVeri.faturalar || []) soz.set(f.sozlesmeNo, { no: f.sozlesmeNo, lokasyon: f.lokasyon, grup: f.grup });
  for (const l of panelVeri.lokasyonlar || []) soz.set(l.sozlesmeNo, { ...(soz.get(l.sozlesmeNo) || {}), no: l.sozlesmeNo, ...Object.fromEntries(Object.entries(l).filter(([, d]) => d !== '' && d != null)) });
  const eslesme = firmaAyar.eslesme || {}, tur = gesAyar.tur || {};
  const firmalar = new Set(firmaAyar.firmalar || VARSAYILAN_FIRMALAR);
  const guvenceler = [];
  const sozlesmeler = [...soz.values()].map(s => {
    const onayli = eslesme[s.no] || null, firma = onayli || firmaTahmini(s.grup, s.lokasyon);
    if (firma) firmalar.add(firma);
    const gl = GUVENCE.liste(firmaAyar, s.no);
    for (const g of gl) guvenceler.push({ sozlesme_no: s.no, gecerlilik_tarihi: g.tarih || null, tutar_tl: g.tutar, aciklama: g.not || null });
    return { sozlesme_no: s.no, lokasyon: s.lokasyon || null, panel_grubu: s.grup || null, firma, firma_onayli: !!onayli, ges_turu: tur[s.no] || null, guvence_bedeli_tl: sayi(GUVENCE.guncel(gl)), guncelleme: new Date().toISOString() };
  });
  const faturalar = (panelVeri.faturalar || []).map(f => ({
    sozlesme_no: f.sozlesmeNo, donem: f.donem + '-01', lokasyon: f.lokasyon || null, panel_grubu: f.grup || null,
    tuketim_kwh: sayi(f.tuketim), odenecek_tl: sayi(f.odenecek), birim_fiyat_tl: sayi(f.birimFiyat),
    dosya: f.dosya || '', dosya_yolu: f.dosyaYolu || null, ilk_gorulme: f.eklenme || null, son_degisiklik: f.guncelleme || null,
  }));
  const ges = [];
  for (const [gun, o] of Object.entries(panelVeri.gesSaatlik || {})) for (let s = 0; s < 24; s++) ges.push({ gun, saat: s, cekis_kwh: sayi(o.cekis[s]) || 0, veris_kwh: sayi(o.veris[s]) || 0 });
  return { firmalar: [...firmalar].map(ad => ({ ad })), sozlesmeler, guvenceler, faturalar, ges };
}

function supabase(env) {
  const U = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const K = String(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || '').trim();
  const hazir = !!(U && K);
  const sonGonderilen = {}; // tablo → içerik özeti (değişmeyen tablo tekrar gönderilmez)

  async function istek(yol, { method = 'GET', govde, basliklar = {} } = {}) {
    const r = await fetch(U + '/rest/v1/' + yol, { method, headers: { apikey: K, Authorization: 'Bearer ' + K, 'Content-Type': 'application/json', ...basliklar }, body: govde ? JSON.stringify(govde) : undefined });
    const t = await r.text();
    if (!r.ok) {
      const ipucu = /PGRST205|does not exist/.test(t) ? ' — tablolar yok: supabase/001_sema.sql dosyasını Supabase SQL Editor\'da çalıştırın.' : '';
      throw new Error('Supabase ' + yol.split('?')[0] + ' HTTP ' + r.status + ': ' + t.slice(0, 200) + ipucu);
    }
    return t ? JSON.parse(t) : null;
  }
  async function upsert(tablo, liste, cakisma) {
    const ozet = require('crypto').createHash('sha1').update(JSON.stringify(liste.map(x => ({ ...x, guncelleme: undefined })))).digest('hex');
    if (sonGonderilen[tablo] === ozet) return 0;
    for (let i = 0; i < liste.length; i += 500)
      await istek(tablo + '?on_conflict=' + cakisma, { method: 'POST', govde: liste.slice(i, i + 500), basliklar: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    sonGonderilen[tablo] = ozet;
    return liste.length;
  }
  async function hepsi(tablo, secim, sira) {
    const sonuc = [];
    for (let bas = 0; ; bas += 1000) {
      const parca = await istek(tablo + '?select=' + secim + '&order=' + sira + '&offset=' + bas + '&limit=1000');
      sonuc.push(...parca);
      if (parca.length < 1000) return sonuc;
    }
  }

  const tabloYok = e => /PGRST205|does not exist/.test(e.message);
  // Güvence geçmişi küçük bir tablodur ve satır silinebilir: değiştiyse tamamı yeniden yazılır
  async function guvenceYaz(liste) {
    const ozet = require('crypto').createHash('sha1').update(JSON.stringify(liste)).digest('hex');
    if (sonGonderilen.guvence === ozet) return 0;
    try {
      await istek('elektrik_guvence_bedelleri?id=gt.0', { method: 'DELETE', basliklar: { Prefer: 'return=minimal' } });
      if (liste.length) await istek('elektrik_guvence_bedelleri', { method: 'POST', govde: liste, basliklar: { Prefer: 'return=minimal' } });
    } catch (e) { if (tabloYok(e)) return 'tablo yok (supabase/002_guvence_gecmisi.sql çalıştırılmalı)'; throw e; }
    sonGonderilen.guvence = ozet;
    return liste.length;
  }

  // Tüm veriyi gönderir; değişmeyen tablolar atlanır. Dönüş: { tablo: gönderilen satır }
  async function gonder(panelVeri, firmaAyar, gesAyar) {
    const s = satirlar(panelVeri, firmaAyar, gesAyar);
    return {
      firmalar: await upsert('elektrik_firmalar', s.firmalar, 'ad'),
      sozlesmeler: await upsert('elektrik_sozlesmeler', s.sozlesmeler, 'sozlesme_no'),
      guvence: await guvenceYaz(s.guvenceler),
      faturalar: await upsert('elektrik_faturalar', s.faturalar, 'sozlesme_no,donem,dosya'),
      ges: await upsert('elektrik_ges_saatlik', s.ges, 'gun,saat'),
    };
  }
  const okumaKaydet = k => istek('elektrik_panel_okumalari', { method: 'POST', govde: [k], basliklar: { Prefer: 'return=minimal' } });

  // Sözleşme ayarlarını Supabase'den alıp yerel ayarlarla birleştirir (Supabase'de olan sözleşmede Supabase geçerli)
  async function ayarlariBirlestir(firmaAyar = {}, gesAyar = {}) {
    const [soz, firmalar, guv] = await Promise.all([
      hepsi('elektrik_sozlesmeler', 'sozlesme_no,firma,firma_onayli,ges_turu,guvence_bedeli_tl', 'sozlesme_no'), hepsi('elektrik_firmalar', 'ad', 'ad'),
      hepsi('elektrik_guvence_bedelleri', 'sozlesme_no,gecerlilik_tarihi,tutar_tl,aciklama', 'sozlesme_no,gecerlilik_tarihi').catch(e => { if (tabloYok(e)) return null; throw e; }),
    ]);
    const f = { ...firmaAyar, eslesme: { ...(firmaAyar.eslesme || {}) }, guvence: { ...(firmaAyar.guvence || {}) }, guvenceGecmis: { ...(firmaAyar.guvenceGecmis || {}) } };
    const g = { ...gesAyar, tur: { ...(gesAyar.tur || {}) } };
    const gecmis = {};
    for (const r of guv || []) (gecmis[r.sozlesme_no] = gecmis[r.sozlesme_no] || []).push({ tarih: r.gecerlilik_tarihi ? String(r.gecerlilik_tarihi).slice(0, 10) : null, tutar: +r.tutar_tl, ...(r.aciklama ? { not: r.aciklama } : {}) });
    for (const r of soz) {
      if (r.firma_onayli && r.firma) f.eslesme[r.sozlesme_no] = r.firma; else delete f.eslesme[r.sozlesme_no];
      if (guv) {
        // Geçmiş tablosu varsa geçerli olan odur
        delete f.guvence[r.sozlesme_no];
        if (gecmis[r.sozlesme_no]) f.guvenceGecmis[r.sozlesme_no] = GUVENCE.temizle(gecmis[r.sozlesme_no]); else delete f.guvenceGecmis[r.sozlesme_no];
      } else if (!f.guvenceGecmis[r.sozlesme_no]) {
        if (r.guvence_bedeli_tl != null) f.guvence[r.sozlesme_no] = +r.guvence_bedeli_tl; else delete f.guvence[r.sozlesme_no];
      }
      // GES türü yalnızca Supabase'de doluysa alınır; boş değer yereldeki dolu ayarı SİLMEZ
      // (diski geçici bulut sunucusunun boş ayarla yaptığı bir kayıt, masaüstündeki GES tanımlarını silmişti)
      if (r.ges_turu) g.tur[r.sozlesme_no] = r.ges_turu;
    }
    if (firmalar.length) f.firmalar = [...new Set([...(firmaAyar.firmalar || VARSAYILAN_FIRMALAR), ...firmalar.map(x => x.ad)])];
    return { firmaAyar: f, gesAyar: g, sozlesmeSayisi: soz.length };
  }

  // Bulut: tüm veriyi Supabase'den uygulama biçiminde okur
  async function geriYukle() {
    const [fat, soz, ges, son] = await Promise.all([
      hepsi('elektrik_faturalar', 'sozlesme_no,donem,lokasyon,panel_grubu,tuketim_kwh,odenecek_tl,birim_fiyat_tl,dosya,dosya_yolu,ilk_gorulme,son_degisiklik', 'id'),
      hepsi('elektrik_sozlesmeler', 'sozlesme_no,lokasyon,panel_grubu', 'sozlesme_no'),
      hepsi('elektrik_ges_saatlik', 'gun,saat,cekis_kwh,veris_kwh', 'gun,saat'),
      istek('elektrik_panel_okumalari?select=zaman,adres&basarili=eq.true&kaynak=eq.masaustu&order=zaman.desc&limit=1'),
    ]);
    const temiz = o => Object.fromEntries(Object.entries(o).filter(([, d]) => d != null));
    const gesSaatlik = {};
    for (const r of ges) { const g = (gesSaatlik[r.gun] = gesSaatlik[r.gun] || { cekis: new Array(24).fill(0), veris: new Array(24).fill(0) }); g.cekis[r.saat] = +r.cekis_kwh; g.veris[r.saat] = +r.veris_kwh; }
    return {
      alinma: son && son[0] ? son[0].zaman : null, adres: son && son[0] ? son[0].adres : null,
      faturalar: fat.map(r => temiz({ sozlesmeNo: r.sozlesme_no, donem: String(r.donem).slice(0, 7), lokasyon: r.lokasyon || '', grup: r.panel_grubu || '', tuketim: sayi(r.tuketim_kwh), odenecek: sayi(r.odenecek_tl), dosya: r.dosya, dosyaYolu: r.dosya_yolu, birimFiyat: sayi(r.birim_fiyat_tl), eklenme: r.ilk_gorulme, guncelleme: r.son_degisiklik })),
      lokasyonlar: soz.map(r => ({ sozlesmeNo: r.sozlesme_no, lokasyon: r.lokasyon || '', grup: r.panel_grubu || '' })),
      gesSaatlik,
    };
  }

  return { hazir, adres: U, gonder, okumaKaydet, ayarlariBirlestir, geriYukle };
}

module.exports = { supabase, envOku, satirlar };
