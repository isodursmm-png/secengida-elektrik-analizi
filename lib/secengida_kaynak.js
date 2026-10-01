// secengida_kaynak.js — SECENGIDA fatura kaynağı: Masaüstü\SECENGIDA klasörünü izler (Elektrik Fatura Paneli yerine).
//
// Klasöre bırakılan .zip (dağıtım şirketlerinin "INVOICE" arşivleri) ve .pdf dosyaları taranır; zip içindeki PDF'ler
// açılır. Her PDF bir kez okunur (SHA-1 ile tanınır): türü ve değerleri lib/secengida_pdf.js ile çözülür, kopyası
// veri\belge_deposu\faturalar\ altına yazılır, Belgeler › Faturalar listesine eklenir. Kaynak dosya silinse de kayıt kalır.
// Çıktı Elektrik Fatura Paneli uçlarıyla aynı biçimdedir (/durum, /veri, /lokasyonlar, /ges-veri): sunucunun geri kalanı
// (fatura kontrolü, mükerrer, firma eşleşmesi, arşiv) değişmeden çalışır.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const PDF = require('./secengida_pdf.js');

// Sözleşme → okunur lokasyon adı ve grup (kullanıcı veri\secengida_lokasyon.json ile değiştirebilir)
const VARSAYILAN_LOKASYON = {
  'AOSB-3033': { lokasyon: 'AOSB FABRİKA · 1.Kısım 4.Cad. No:15', grup: 'OSB SANAYİ OG' },
  '9699609184': { lokasyon: 'CK YILLIK İŞLETİM BEDELİ · Merkez/Antalya', grup: 'BEDEL' },
  'ANT-TRAFO-2500': { lokasyon: 'AOSB FABRİKA TRAFO · 2500 kVA (ANT Trafo)', grup: 'TRAFO HİZMET' },
};
function lokasyonTahmini(r) {
  if (r.kaynak === 'OSB') return { lokasyon: 'AOSB FABRİKA · abone ' + (r.aboneNo || '?'), grup: 'OSB SANAYİ OG' };
  if (r.kaynak === 'ANT') return { lokasyon: 'TRAFO İŞLETME · ' + (r.kuruluKva || '?') + ' kVA', grup: 'TRAFO HİZMET' };
  // CK: "SEDİR Mah.,MERKEZ,SEDİR Mah. AKIN Cd KONUT no:16/5,16 /5 ,AKIN Cd,MURATPAŞA,ANTALYA"
  const a = String(r.adres || '');
  const mah = (/([A-ZÇĞİÖŞÜ0-9 ]+ Mah\.)/.exec(a) || [])[1];
  const cd = (/([A-ZÇĞİÖŞÜ0-9]+ (?:Cd|Sk|Bulv)\.?)/.exec(a) || [])[1];
  const no = (/\b(KONUT|İŞYERİ|DÜKKAN|DEPO)?\s*no:\s*([^,]+)/i.exec(a) || []);
  const parca = [mah, cd, [no[1], no[2] ? 'no:' + no[2].trim() : ''].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  const ad = parca || a.split(',').filter(Boolean).slice(0, 2).join(' · ') || 'CK abonelik';
  const grup = /mesken/i.test(r.tuketiciGrubu || '') ? 'MESKEN' : r.tuketimKwh > 0 ? 'TİCARETHANE' : 'BEDEL';
  return { lokasyon: (r.tuketimKwh > 0 ? '' : 'BEDEL · ') + ad, grup };
}

function kaynak({ veri, klasorler, log = console.log }) {
  const DEPO = path.join(veri, 'belge_deposu');
  const FAT = path.join(DEPO, 'faturalar');
  fs.mkdirSync(FAT, { recursive: true });
  const DIZIN = path.join(veri, 'secengida_faturalar.json');   // sha1 → kayıt (okunan özet dahil)
  const LOK = path.join(veri, 'secengida_lokasyon.json');
  const oku = (f, v) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return v; } };
  const yaz = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 1), 'utf8');
  if (!fs.existsSync(LOK)) yaz(LOK, VARSAYILAN_LOKASYON);
  const durum = { sonTarama: null, sonYeni: 0, hata: null, calisiyor: false, klasorler: [] };

  // Klasördeki PDF'ler (zip içindekiler dahil): { ad, kaynak, buf }
  function pdfleriTopla() {
    const out = [];
    const gez = (d, derin = 0) => {
      let l = []; try { l = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of l) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (derin < 6) gez(p, derin + 1); continue; }
        const uz = path.extname(e.name).toLowerCase();
        try {
          if (uz === '.pdf') out.push({ ad: e.name, kaynak: p, buf: fs.readFileSync(p) });
          else if (uz === '.zip') {
            const z = XLSX.CFB.read(fs.readFileSync(p), { type: 'buffer' });
            z.FileIndex.forEach((f, i) => { if (f.type === 2 && /\.pdf$/i.test(z.FullPaths[i]) && f.content && f.content.length) out.push({ ad: path.basename(z.FullPaths[i]), kaynak: p + ' › ' + z.FullPaths[i].replace(/^Root Entry\//, ''), buf: Buffer.from(f.content) }); });
          }
        } catch (er) { log('SECENGIDA kaynak dosyası okunamadı:', p, er.message); }
      }
    };
    for (const k of klasorler()) gez(k);
    return out;
  }

  // Yeni PDF'leri okur ve depoya alır. Dönen: { yeni, toplam }
  async function tara() {
    if (durum.calisiyor) return { yeni: 0, toplam: Object.keys(oku(DIZIN, {})).length, mesgul: true };
    durum.calisiyor = true; durum.klasorler = klasorler();
    const dizin = oku(DIZIN, {});
    let yeni = 0;
    try {
      const pdfParse = require('pdf-parse/lib/pdf-parse.js');
      for (const d of pdfleriTopla()) {
        const sha1 = crypto.createHash('sha1').update(d.buf).digest('hex');
        if (dizin[sha1]) { if (!dizin[sha1].kaynaklar.includes(d.kaynak)) dizin[sha1].kaynaklar.push(d.kaynak); continue; }
        let r;
        try { r = PDF.cozumle((await pdfParse(d.buf)).text); } catch (e) { r = { okundu: false, hata: e.message }; }
        const no = r.faturaNo || ((PDF.FATURA_NO.exec(d.ad) || [])[1] || '').toUpperCase();
        if (!no) { log('SECENGIDA: fatura no bulunamadı, atlandı:', d.kaynak); dizin[sha1] = { sha1, atlandi: true, ad: d.ad, kaynaklar: [d.kaynak], hata: r.hata || 'fatura no yok' }; continue; }
        // Aynı fatura farklı dosya (ör. yeniden indirilmiş) olarak gelirse ilk kayıt esas, yenisi mükerrer işaretlenir
        const onceki = Object.values(dizin).find(x => x.faturaNo === no && !x.mukerrerDosya);
        const dosya = no + (onceki ? '_' + sha1.slice(0, 6) : '') + '.pdf';
        fs.writeFileSync(path.join(FAT, dosya), d.buf);
        dizin[sha1] = { sha1, faturaNo: no, ad: d.ad, dosya, boyut: d.buf.length, kaynaklar: [d.kaynak], eklenme: new Date().toISOString(), mukerrerDosya: !!onceki, okunan: r };
        yeni++;
        log('SECENGIDA faturası okundu:', no, r.kaynak || '?', r.donem || '', r.okundu ? '' : '(okunamadı: ' + (r.hata || 'değerler eksik') + ')');
      }
      yaz(DIZIN, dizin);
      Object.assign(durum, { sonTarama: new Date().toISOString(), sonYeni: yeni, hata: null });
    } catch (e) { durum.hata = e.message; throw e; }
    finally { durum.calisiyor = false; }
    return { yeni, toplam: Object.keys(dizin).length };
  }

  const kayitlar = () => Object.values(oku(DIZIN, {})).filter(x => x.faturaNo);
  // Belgeler › Faturalar listesi (yerel depo) için kayıtlar
  function belgeKayitlari() {
    const lok = oku(LOK, {});
    return kayitlar().map(x => {
      const r = x.okunan || {}, l = lok[r.sozlesme] || lokasyonTahmini(r);
      return {
        id: 'f-' + x.sha1.slice(0, 16), klasor: 'faturalar', nesne: 'faturalar/' + x.dosya, ad: x.ad, uzanti: '.pdf', tur: 'application/pdf', boyut: x.boyut, sha1: x.sha1,
        kategori: r.kaynak === 'ANT' ? 'Trafo hizmet faturası' : r.kaynak === 'OSB' ? 'Elektrik faturası (AOSB)' : r.tuketimKwh > 0 ? 'Elektrik faturası' : 'Fark / ek fatura',
        sozlesme: r.sozlesme || '', lokasyon: l.lokasyon, faturaNo: x.faturaNo, donem: r.donem || '', aciklama: (r.tedarikci || '') + (x.mukerrerDosya ? ' · aynı fatura no ile ikinci dosya' : ''), yukleme: x.eklenme, otomatik: true,
      };
    });
  }
  // Fatura no → okunan özet (ilk dosya esas)
  function okunanlar() {
    const m = new Map();
    for (const x of kayitlar()) if (!x.mukerrerDosya && x.okunan) m.set(x.faturaNo, { ...x.okunan, faturaNo: x.faturaNo, belgeId: 'f-' + x.sha1.slice(0, 16) });
    return m;
  }

  // Elektrik Fatura Paneli biçiminde çıktı (lib/elektrik_panel_kaynak.js'nin oku() dönüşüyle aynı alanlar)
  async function panelBicimi() {
    await tara();
    const lok = oku(LOK, {});
    const veriK = [], lokasyonlar = new Map();
    for (const x of kayitlar()) {
      const r = x.okunan || {};
      if (!r.sozlesme) continue;
      const l = lok[r.sozlesme] || lokasyonTahmini(r);
      lokasyonlar.set(r.sozlesme, { sozlesmeNo: r.sozlesme, lokasyon: l.lokasyon, grup: l.grup, adres: r.adres || '', tedarikci: r.tedarikci || '' });
      const kwh = +r.tuketimKwh || 0;
      veriK.push({
        sozlesmeNo: r.sozlesme, donem: r.donem || '', lokasyon: l.lokasyon, grup: l.grup, tuketim: kwh, odenecek: r.odenecek ?? r.faturaTutari ?? 0,
        // Dosya adı panel biçiminde: "<VKN>-<fatura no>-<sha1>.pdf" (fatura kontrolü fatura no'yu buradan alır)
        dosya: '7570429521-' + x.faturaNo + '-' + x.sha1.slice(0, 12) + '.pdf', dosyaYolu: 'belge_deposu\\faturalar\\' + x.dosya,
        birimFiyat: kwh ? (r.odenecek || 0) / kwh : null, kaynak: r.kaynak, tedarikci: r.tedarikci,
      });
    }
    const j = kayitlar => ({ ok: true, kayitlar });
    const v = j(veriK), lk = j([...lokasyonlar.values()]), g = j([]);
    const kl = klasorler().join(' · ');
    return {
      taban: 'SECENGIDA klasörü (' + kl + ')',
      durumJ: { ok: true, klasor: kl, paneller: [{ adres: 'yerel klasör', klasor: kl, fatura: veriK.length }] },
      veri: { j: v, body: JSON.stringify(v) }, lok: { j: lk, body: JSON.stringify(lk) }, ges: { j: g, body: JSON.stringify(g) }, ekler: {}, okunamayan: [],
    };
  }
  const pdfYolu = dosya => path.join(FAT, path.basename(dosya));
  return { tara, panelBicimi, belgeKayitlari, okunanlar, kayitlar, pdfYolu, durum, DEPO, LOK_DOSYASI: LOK };
}

module.exports = { kaynak, lokasyonTahmini };
