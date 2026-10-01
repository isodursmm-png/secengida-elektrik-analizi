// elektrik_panel_kaynak.js — Ağdaki TÜM Elektrik Fatura Panellerini okuyup tek veri halinde birleştirir.
//
// Birden çok panel olabilir (ör. Sami PC 192.168.0.106 ve sunucu 192.168.0.240). Her turda bilinen tüm
// adresler denenir; açık olanların hepsi okunur. Kapalı olan atlanır, sonraki turda yine denenir.
// Bilinen adresler: PANEL_URL / varsayılan + ayar dosyasındaki "paneller" listesi. Hiçbiri yanıt vermezse
// ya da 6 saatte bir, yerel ağ 8010 portu için taranır; bulunan yeni panel listeye kalıcı eklenir.
// Birleştirme: aynı fatura (sözleşme + dönem + dosya) birden çok panelde varsa listede ÖNCE gelen panelin
// kaydı esas alınır, yalnızca boş alanları diğerinden doldurulur (boş değer dolu değeri asla ezmez).
const net = require('net');

const UCLAR = [['ges-durum', '/ges-durum'], ['elektrik-paneli.html', '/elektrik-paneli'], ['ges.html', '/ges.html'], ['ayarlar.html', '/ayarlar.html']];
const TARAMA_ARALIGI = 6 * 60 * 60 * 1000;
const bos = v => v === '' || v == null;
const doldur = (hedef, yeni) => { for (const [k, v] of Object.entries(yeni)) if (bos(hedef[k]) && !bos(v)) hedef[k] = v; return hedef; };

// Hızlı erişim kontrolü: kapalı bilgisayarda uzun zaman aşımı beklenmesin
function ulasilir(adres, ms = 2000) {
  return new Promise(r => {
    let u; try { u = new URL(adres); } catch (e) { return r(false); }
    const s = net.connect({ host: u.hostname, port: +u.port || 80 });
    s.setTimeout(ms); s.on('connect', () => { s.destroy(); r(true); }); s.on('timeout', () => { s.destroy(); r(false); }); s.on('error', () => r(false));
  });
}

function birlestir(kaynaklar) {
  const fk = f => f.sozlesmeNo + '|' + f.donem + '|' + (f.dosya || '');
  const fat = new Map(), lok = new Map(), ges = new Map(), ekler = {};
  for (const k of kaynaklar) {
    for (const f of k.veri.kayitlar || []) { const x = fat.get(fk(f)); fat.set(fk(f), x ? doldur(x, f) : { ...f }); }
    for (const l of k.lok.kayitlar || []) { const x = lok.get(l.sozlesmeNo); lok.set(l.sozlesmeNo, x ? doldur(x, l) : { ...l }); }
    for (const g of k.ges.kayitlar || []) { const a = String(g.tarih).slice(0, 10) + '|' + g.saat; if (!ges.has(a)) ges.set(a, g); }
    const onek = kaynaklar.length > 1 ? new URL(k.adres).hostname + '_' : '';
    for (const [ad, icerik] of Object.entries(k.ekler)) ekler[onek + ad] = icerik;
  }
  const j = kayitlar => ({ ok: true, kayitlar });
  const veri = j([...fat.values()]), lokJ = j([...lok.values()]), gesJ = j([...ges.values()]);
  const klasorler = [...new Set(kaynaklar.map(k => k.durum.klasor).filter(Boolean))];
  return {
    taban: kaynaklar.map(k => k.adres).join(' + '),
    durumJ: { ok: true, klasor: klasorler.join(' · ') || null, paneller: kaynaklar.map(k => ({ adres: k.adres, klasor: k.durum.klasor || null, fatura: (k.veri.kayitlar || []).length })) },
    veri: { j: veri, body: JSON.stringify(veri) }, lok: { j: lokJ, body: JSON.stringify(lokJ) }, ges: { j: gesJ, body: JSON.stringify(gesJ) }, ekler,
  };
}

// cfg: { adresler(): [..] öncelik sırasıyla, kaydet(liste), panelJson(taban, uc), yerelIstek(url), tara(): [adres..], log }
function paneller(cfg) {
  let sonTarama = 0;
  async function okuTek(adres) {
    if (!(await ulasilir(adres))) throw new Error('kapalı');
    const durum = (await cfg.panelJson(adres, '/durum')).j;
    const veri = (await cfg.panelJson(adres, '/veri')).j, lok = (await cfg.panelJson(adres, '/lokasyonlar')).j, ges = (await cfg.panelJson(adres, '/ges-veri')).j;
    const ekler = {};
    for (const [ad, uc] of UCLAR) { try { const r = await cfg.yerelIstek(adres + uc); if (r.status === 200) ekler[ad] = r.body; } catch (e) { } }
    return { adres, durum, veri, lok, ges, ekler };
  }
  async function okuHepsi(adresler) {
    const sonuc = await Promise.all(adresler.map(a => okuTek(a).then(k => ({ k }), e => ({ h: a + ': ' + e.message }))));
    return { basarili: sonuc.filter(x => x.k).map(x => x.k), hatalar: sonuc.filter(x => x.h).map(x => x.h) };
  }
  async function oku() {
    const adresler = [...new Set(cfg.adresler().filter(Boolean))];
    const { basarili, hatalar } = await okuHepsi(adresler);
    if (!basarili.length || Date.now() - sonTarama > TARAMA_ARALIGI) {
      sonTarama = Date.now();
      const yeni = (await cfg.tara()).filter(a => !adresler.includes(a));
      if (yeni.length) {
        cfg.log('Yeni elektrik paneli bulundu:', yeni.join(', '));
        cfg.kaydet([...adresler, ...yeni]);
        const r = await okuHepsi(yeni); basarili.push(...r.basarili); hatalar.push(...r.hatalar);
      }
    }
    if (!basarili.length) throw new Error('Hiçbir elektrik paneline ulaşılamadı (' + hatalar.join(' · ') + ')');
    if (hatalar.length) cfg.log('Okunamayan panel:', hatalar.join(' · '));
    const oncelik = a => { const i = adresler.indexOf(a); return i < 0 ? 999 : i; };
    return { ...birlestir(basarili.sort((x, y) => oncelik(x.adres) - oncelik(y.adres))), okunamayan: hatalar };
  }
  return { oku, ulasilir };
}

module.exports = { paneller, birlestir, ulasilir };
