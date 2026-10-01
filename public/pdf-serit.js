// pdf-serit.js — Fatura tablolarında "fatura no"ya tıklayınca tablonun üstünde açılan karşılaştırma şeridi:
// tablodaki (panel + uygulamanın hesabı) değerler ↔ faturanın PDF'inden okunan gerçek değerler (reel fatura).
// Fatura Kontrol ve GES Mahsup sayfaları ortak kullanır; sayfanın V.satirlar verisini okur.
(function () {
  const e = x => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const t2 = v => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const k3 = v => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('tr-TR', { maximumFractionDigits: 3 });
  const isaretli = (v, f) => v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + f(v);
  const AY = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
  const ayEt = d => d ? AY[+d.slice(5) - 1] + ' ' + d.slice(0, 4) : '';
  const STIL = '<style>.pdf-serit{background:#fff4e0;border:1px solid #f0c27a;border-left:6px solid #e67e22;border-radius:8px;padding:8px 12px;margin:0 0 8px;color:#5a3b00;font-size:12px;position:relative}'
    + '.pdf-serit h4{margin:0 0 4px;font-size:13.5px;color:#1a3a6b}.pdf-serit .alt{color:#7a6a4f;font-size:11.5px;margin-bottom:6px}'
    + '.pdf-serit table{border-collapse:collapse;width:auto;min-width:640px;font-size:12px;background:#fff;margin:4px 0}.pdf-serit th{position:static;background:#f6d9a8;color:#5a3b00;padding:3px 10px;max-width:none;cursor:default;text-align:right}.pdf-serit th:first-child{text-align:left}'
    + '.pdf-serit td{padding:3px 10px;border-bottom:1px solid #f3dcb6;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.pdf-serit td:first-child{text-align:left;font-weight:700}'
    + '.pdf-serit .cipler{display:flex;flex-wrap:wrap;gap:3px;margin:4px 0}.pdf-serit .cip{display:inline-block;padding:0 7px;border-radius:5px;font-size:11px;font-weight:600;line-height:18px;border:1px solid #dde3ec;background:#fff;color:#1c2430;white-space:nowrap}'
    + '.pdf-serit .c-guv{background:#f1eefa;border-color:#c9bdea;color:#5b3f99;font-weight:700}.pdf-serit .c-guc{background:#e4eef9;border-color:#a8c8ea;color:#1d5a91;font-weight:700}.pdf-serit .c-dus{background:#e3f4ea;border-color:#a9dcbf;color:#1e7045;font-weight:700}.pdf-serit .c-ver{background:#f5f5f5;color:#555}'
    + '.pdf-serit .fk{display:inline-block;padding:1px 9px;border-radius:6px;font-weight:800;font-size:12px}.pdf-serit .fk-0{background:#e3f4ea;color:#1e7045;border:1px solid #a9dcbf}.pdf-serit .fk-p{background:#e67e22;color:#fff}.pdf-serit .fk-n{background:#c0392b;color:#fff}'
    + '.pdf-serit tr.vurgu td{background:#fde9cc;font-weight:800}.pdf-serit tr.bolum td{background:#fbe3bd;color:#7a4a00;font-size:11px;font-weight:800;letter-spacing:.3px;padding:2px 10px;text-align:left}.pdf-serit .kf{color:#8a7a5a;font-weight:400;font-size:11px}.pdf-serit .yontem{background:#fff;border:1px solid #f0c27a;border-radius:6px;padding:3px 9px;margin:2px 0 4px;font-size:11.5px;color:#1a3a6b}'
    + '.pdf-serit td.ack-h{text-align:left;white-space:normal;min-width:260px;max-width:520px;font-weight:400}.pdf-serit .ack{display:block;background:#fff7cc;border-left:4px solid #e67e22;border-radius:4px;padding:2px 7px;color:#7a3e00;font-size:11.5px;line-height:1.45;font-weight:600}.pdf-serit .ack b{color:#a93226}'
    + '.pdf-serit .kontrol{border-radius:6px;padding:4px 9px;margin:4px 0;font-size:11.5px}.pdf-serit .k-ok{background:#e3f4ea;border:1px solid #a9dcbf;color:#1d3b2a}.pdf-serit .k-hata{background:#fdecea;border:1px solid #f1a9a0;color:#a93226}'
    + '.pdf-serit .yorum{background:#fff;border:1px dashed #e0b36b;border-radius:6px;padding:5px 9px;margin-top:5px;line-height:1.5}'
    + '.pdf-serit .kapat{position:absolute;top:7px;right:9px;background:#e67e22;color:#fff;border:1px solid #d35400;border-radius:5px;padding:2px 10px;font-size:11.5px;font-weight:700;cursor:pointer}'
    + '.pdf-serit .dug{display:inline-block;background:#fff;border:1px solid #c7cfdc;color:#1a3a6b;border-radius:5px;padding:2px 10px;font-weight:700;font-size:11.5px;text-decoration:none;margin-right:6px}'
    + 'a.fno{color:#1a3a6b;font-weight:700;text-decoration:underline dotted;cursor:pointer}a.fno:hover{color:#e67e22}'
    // Tıklanan faturanın satırı: tamamı tek renk (renkli fark hücreleri dahil), kalın turuncu çerçeve
    + 'tr.secili-satir td,tr.secili-satir:hover td{background:#ffe08a !important;color:#3b2a00 !important;border-top:2px solid #e67e22;border-bottom:2px solid #e67e22}'
    + 'tr.secili-satir td:first-child{border-left:4px solid #e67e22}tr.secili-satir td:last-child{border-right:4px solid #e67e22}tr.secili-satir a.fno{color:#8a3c00}</style>';

  // Stil sayfa açılınca bir kez eklenir (fatura no bağlantıları şerit açılmadan da biçimli görünsün)
  document.head.insertAdjacentHTML('beforeend', STIL);
  function kap() {
    let k = document.getElementById('pdfSerit');
    if (k) return k;
    const ic = document.getElementById('gIcerik'); if (!ic) return null;
    const hedef = ic.querySelector('label.sutun-sec') || ic.querySelector('.tablo-kap');
    k = document.createElement('div'); k.id = 'pdfSerit';
    if (hedef) hedef.parentNode.insertBefore(k, hedef); else ic.prepend(k);
    return k;
  }
  const vurguKaldir = () => document.querySelectorAll('tr.secili-satir').forEach(x => x.classList.remove('secili-satir'));
  window.pdfSeritKapat = function () { const k = document.getElementById('pdfSerit'); if (k) k.remove(); vurguKaldir(); };

  function html(s, r) {
    const hesap = s.hesap != null ? s.hesap : s.hesapNormal != null ? s.hesapNormal : s.brut;
    const mahsupUyg = s.gesMahsup ? s.gesMahsup.mahsup : s.mahsupTL;
    let h = STIL + '<div class="pdf-serit"><button class="kapat" onclick="pdfSeritKapat()">✕ Kapat</button>'
      + '<h4>🧾 ' + e(s.faturaNo) + ' · ' + e(s.lokasyon) + ' · ' + ayEt(s.donem) + '</h4>';
    if (!r || !r.ok) {
      return h + '<div class="yorum">' + e((r && r.hata) || 'Fatura okunamadı.') + (r && r.yok ? ' 📁 Belgeler › Faturalar klasörüne yükleyin; dosya adındaki fatura numarasıyla kendiliğinden eşleşir.' : '') + '</div></div>';
    }
    h += '<div class="alt">Reel fatura (PDF): okuma ' + e(r.ilkOkuma || '?') + ' → ' + e(r.sonOkuma || '?') + (r.gun ? ' · ' + r.gun + ' gün' : '') + (r.tuketiciGrubu ? ' · ' + e(r.tuketiciGrubu) : '') + (r.anlasmaGucu ? ' · anlaşma gücü ' + k3(r.anlasmaGucu) + ' kW' : '') + '</div>';
    const fk = (a, b) => a == null || b == null ? null : a - b;
    // Fark kutucuğu: aynıysa yeşil ✔, tablo fazlaysa turuncu, eksikse kırmızı (vurgulu)
    // (tolerans içindeki fark da tutarıyla yazılır, yeşil gösterilir; yalnız sıfıra yakınsa "aynı")
    const farkKutu = (fark, bic, esik) => fark == null ? '' : Math.abs(fark) < 0.01 ? '<span class="fk fk-0">✔ aynı</span>' : Math.abs(fark) < (esik || 0.01) ? '<span class="fk fk-0" title="Tolerans içinde">✔ ' + isaretli(fark, bic) + '</span>' : '<span class="fk ' + (fark > 0 ? 'fk-p' : 'fk-n') + '">' + isaretli(fark, bic) + '</span>';
    // Açıklama: fark sıfır değilse nedeni (rakamlarıyla) vurgulu kutuda
    const satir = (ad, tablo, pdf, fark, bic, vurgu, esik, acik) => '<tr' + (vurgu ? ' class="vurgu"' : '') + '><td>' + ad + '</td><td>' + bic(tablo) + '</td><td><b>' + bic(pdf) + '</b></td><td>' + farkKutu(fark, bic, esik) + '</td><td class="ack-h">' + (acik && fark != null && Math.abs(fark) >= 0.01 ? '<span class="ack">' + acik + '</span>' : '') + '</td></tr>';
    // Uygulamanın vergi kırılımı (hesap, güç bedeli / trafo kaybı eklenmişse onların KDV'si dahil)
    const hd = s.hesapDetay, ekK = s.pdf ? s.pdf.ekKalem || 0 : 0, kO = hd && hd.kdvOran != null ? hd.kdvOran : null;
    const uEtv = hd ? hd.etv : null, uKdv = hd ? hd.kdv + (kO != null ? ekK * kO / (1 + kO) : 0) + (hd.ekDiger ? hd.ekDiger.filter(x => x.kdvli).reduce((a, x) => a + x.tutar, 0) * (kO || 0) : 0) : null;
    const ekD = hd && hd.ekDiger ? hd.ekDiger.filter(x => x.kdvli).reduce((a, x) => a + x.tutar, 0) : 0;
    const uMatrah = hd ? hd.enerji + hd.dagitim + hd.etv + (kO != null ? ekK / (1 + kO) : 0) + ekD : null;
    const pVergi = r.vergiFon != null ? r.vergiFon : r.etv != null && r.kdv != null ? r.etv + r.kdv : null;
    const odenenEnerji = r.odenecek != null ? r.odenecek - (r.guvence || 0) : null;
    // Fark açıklamaları için: enerji + dağıtım (vergisiz) faturada ve uygulamada, kWh başına birim fiyat
    const kwhF = r.tuketimKwh || s.kwh;
    const ePdf = [...(r.kalemler || []).filter(k => !/güç bedeli|trafo/i.test(k.ad)), ...(r.diger || []).filter(k => /dağıtım/i.test(k.ad))].reduce((a, k) => a + (k.tutar || 0), 0);
    const eApp = hd ? hd.enerji + hd.dagitim : null, dE = eApp != null ? eApp - ePdf : null;
    const b4 = v => v == null || !isFinite(v) ? '—' : v.toLocaleString('tr-TR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    const birimAck = eApp != null && kwhF ? 'enerji + dağıtım (vergisiz) uygulamada <b>' + t2(eApp) + '</b>, faturada <b>' + t2(ePdf) + '</b> → birim ' + b4(eApp / kwhF) + ' ↔ ' + b4(ePdf / kwhF) + ' TL/kWh (fark ' + isaretli((eApp - ePdf) / kwhF, b4) + ' × ' + k3(kwhF) + ' kWh = <b>' + isaretli(dE, t2) + ' TL</b>)' : '';
    const dusAck = r.dusulen && r.dusulen.length ? '; faturada düşülen satırlar ' + t2(r.dusulenTL) + ' TL (uygulamada yok)' : '';
    const tukAck = (r.okumaKwh != null ? 'sayaç okuması <b>' + k3(r.okumaKwh) + ' kWh</b>' + (Math.abs(r.okumaKwh - (s.kwh || 0)) < 0.01 ? ' = panel' : ' ≠ panel') + (Math.abs(r.okumaKwh - (r.tuketimKwh || 0)) < 0.01 ? ' = fatura satırları' : ' ≠ fatura satırları') + '; ' : '') + 'panel kWh ile faturadaki enerji satırları farklı: okuma dönemi, ek / düzeltme faturası ya da satır okuma hatası olabilir';
    const kdvAck = kO != null ? 'KDV = matrah × %' + Math.round(kO * 100) + ': matrah farkı ' + isaretli(fk(uMatrah, r.kdvMatrah), t2) + ' × ' + kO.toLocaleString('tr-TR') + ' ≈ <b>' + isaretli(fk(uMatrah, r.kdvMatrah) * kO, t2) + ' TL</b>' : '';
    const etvAck = 'ETV = enerji bedelinin %5’i: ' + (dE != null ? 'enerji bedeli farkından (' + isaretli(dE, t2) + ' TL) kaynaklanır' : 'enerji bedeli farkından kaynaklanır');
    const yuvAck = 'enerji bedeli ve vergiler faturayla aynı: fark faturadaki kuruş yuvarlamasından / ödenecek tutarın 5 TL’ye yuvarlanmasından';
    const anaAck = dE != null && Math.abs(dE) < 0.05 && Math.abs(fk(uMatrah, r.kdvMatrah) || 0) < 0.05 ? yuvAck : [birimAck ? 'Enerji fiyatı: ' + birimAck : '', dusAck ? dusAck.slice(2) : '', kO != null ? 'vergiler (ETV + KDV) bu farkı yaklaşık ×' + (1.05 * (1 + kO)).toLocaleString('tr-TR', { maximumFractionDigits: 2 }) + ' büyütür' : ''].filter(Boolean).join(' · ');
    // Faturanın kalem düzeninde: her satır "kWh × birim = tutar"; uygulama sütunu da aynı biçimde
    const kf = (kwh, birim, tutar) => kwh != null && birim != null ? '<span class="kf">' + k3(kwh) + ' kWh × ' + b4(birim) + ' =</span> ' + t2(tutar) : t2(tutar);
    const satirH = (ad, tabloH, pdfH, fark, esik, acik, sinif) => '<tr' + (sinif ? ' class="' + sinif + '"' : '') + '><td>' + ad + '</td><td>' + tabloH + '</td><td><b>' + pdfH + '</b></td><td>' + farkKutu(fark, t2, esik) + '</td><td class="ack-h">' + (acik && fark != null && Math.abs(fark) >= 0.01 ? '<span class="ack">' + acik + '</span>' : '') + '</td></tr>';
    const bolum = ad => '<tr class="bolum"><td colspan="5">' + ad + '</td></tr>';
    const pEnerji = (r.kalemler || []).filter(k => /^Enerji Bedeli/i.test(k.ad));
    const pDiger = [...(r.kalemler || []).filter(k => !/^Enerji Bedeli/i.test(k.ad)), ...(r.diger || []).filter(k => !/yuvarlama|güvence/i.test(k.ad))];
    let govde = bolum('⚡ Tüketim') + satir('Tüketim (kWh)', s.kwh, r.tuketimKwh, fk(s.kwh, r.tuketimKwh), k3, false, 0, tukAck)
      + (r.okumaKwh != null ? satir('Sayaç okuması (kWh) · ' + e(r.ilkOkuma || '') + ' → ' + e(r.sonOkuma || ''), s.kwh, r.okumaKwh, fk(s.kwh, r.okumaKwh), k3, false, 0, 'panel kWh sayaç okumasından farklı') : '');
    if (hd) {
      govde += bolum('🧾 Enerji bedeli (enerji + dağıtım, vergisiz)');
      if (hd.kalemler && hd.kalemler.length) {
        // Uygulama faturadaki kademe kalemlerini tarifeyle yeniden fiyatladı: kalem kalem yan yana
        hd.kalemler.forEach((a, i) => {
          const p = pEnerji[i] || {};
          const ack = Math.abs((a.birim || 0) - (p.birim || 0)) >= 0.00005 ? 'birim fiyat: tarife (' + e(a.tip) + ') <b>' + b4(a.birim) + '</b> = enerji ' + b4(a.enerjiKr / 100) + ' + dağıtım ' + b4(a.dagitimKr / 100) + ' · faturada <b>' + b4(p.birim) + '</b>' + ((a.tablolar || []).length > 1 ? ' · okuma dönemi tarife değişimini kapsıyor (' + a.tablolar.join(' / ') + '): CK günlere değil tüketim profiline göre oranlar' : '') : '';
          govde += satirH(e(a.ad), kf(a.kwh, a.birim, a.tutar), kf(p.miktar, p.birim, p.tutar), fk(a.tutar, p.tutar), 0.05, ack);
        });
      } else {
        pEnerji.forEach(p => { govde += satirH(e(p.ad), '<span style="color:#9a8a6a">aşağıda toplu</span>', kf(p.miktar, p.birim, p.tutar), null); });
        const uB = hd.enerjiKr != null && hd.dagitimKr != null ? (hd.enerjiKr + hd.dagitimKr) / 100 : null;
        govde += satirH('Enerji + dağıtım toplamı · ' + e(hd.tipAd || hd.yontem || ''), kf(s.kwh, uB, eApp), t2(ePdf), dE, 1, birimAck);
      }
    }
    if (pDiger.length || (hd && hd.ekDiger && hd.ekDiger.length)) {
      govde += bolum('➕ Diğer kalemler (enerji dışı)');
      const uDig = hd && hd.ekDiger || [];
      for (const p of pDiger) {
        const guc = /güç bedeli|trafo/i.test(p.ad), u = uDig.find(x => x.ad === p.ad);
        const uv = guc ? p.tutar : u ? u.tutar : null;
        govde += satirH(e(p.ad) + (p.miktar ? ' <span class="kf">' + k3(p.miktar) + ' ' + e(p.birimi || '') + '</span>' : ''), uv != null ? t2(uv) + ' <span class="kf">faturadan</span>' : '<span style="color:#9a8a6a">hesapta yok</span>', t2(p.tutar), uv != null ? fk(uv, p.tutar) : null, 0.05, '');
      }
    }
    govde += bolum('🏛 Vergiler ve toplam')
      + (hd ? satir('Elektrik tüketim vergisi · ETV %5 (TL)', uEtv, r.etv, fk(uEtv, r.etv), t2, false, 1, etvAck) : '')
      + (hd ? satir('KDV matrahı (TL)', uMatrah, r.kdvMatrah, fk(uMatrah, r.kdvMatrah), t2, false, 1, 'Matrah = enerji + dağıtım + ETV (+ KDV’li diğer kalemler). ' + birimAck + dusAck) : '')
      + (hd ? satir('KDV %' + Math.round((kO || 0) * 100) + ' (TL)', uKdv, r.kdv, fk(uKdv, r.kdv), t2, false, 1, kdvAck) : '')
      + (hd ? satir('Vergi ve Fonlar · ETV + KDV (TL)', uEtv + uKdv, pVergi, fk(uEtv + uKdv, pVergi), t2, false, 1, 'ETV farkı ' + isaretli(fk(uEtv, r.etv), t2) + ' + KDV farkı ' + isaretli(fk(uKdv, r.kdv), t2)) : satir('Vergi ve Fonlar · ETV + KDV (TL)', null, pVergi, null, t2, false))
      + satir('Fatura tutarı (TL)', hesap != null ? hesap + (r.guvence || 0) : null, r.faturaTutari, hesap != null ? fk(hesap + (r.guvence || 0), r.faturaTutari) : null, t2, true, Math.max(10, (hesap || 0) * 0.03), anaAck)
      + satir('Faturada ödenen (TL)', s.odenen, r.odenecek, fk(s.odenen, r.odenecek), t2, false, 0, 'panelin kaydettiği ödenecek tutar faturadakinden farklı: ek / düzeltme faturası ya da okuma hatası')
      + (hesap != null ? satir('Uygulamanın hesabı ↔ ödenen' + (r.guvence ? ' − güvence' : '') + ' (TL)', hesap, odenenEnerji, fk(hesap, odenenEnerji), t2, true, Math.max(10, hesap * 0.03), anaAck) : '')
      + '<tr><td>Mahsup edilen (düşülen)</td><td>' + (mahsupUyg != null ? 'uygulama: ' + isaretli(mahsupUyg, t2) + ' TL' : '—') + '</td><td><b style="color:#1e7045">' + (r.dusulen && r.dusulen.length ? (r.dusulenKwh ? k3(r.dusulenKwh) + ' kWh · ' : '') + t2(r.dusulenTL) + ' TL' : 'faturada yok') + '</b></td><td></td><td class="ack-h">' + (r.dusulen && r.dusulen.length ? '<span class="ack" style="background:#e3f4ea;border-color:#1e8449;color:#1d3b2a">' + r.dusulen.map(k => e(k.ad) + ' ' + t2(k.tutar)).join(' · ') + '</span>' : '') + '</td></tr>';
    // Uygulamanın yöntemi (faturadaki grup / kademe ile mi, panel grubuyla mı hesaplandı)
    if (hd) h += '<div class="yontem">🧮 Uygulamanın hesabı: <b>' + e(s.yontem || hd.yontem || '') + '</b>' + (hd.okuma ? ' · okuma ' + e(hd.okuma.ilk) + ' → ' + e(hd.okuma.son) + ' (' + hd.okuma.gun + ' gün)' : '') + (hd.tablolar && hd.tablolar.length ? ' · tarife ' + hd.tablolar.join(' / ') : '') + (s.hesapOnce ? ' · <span style="color:#7a6a4f">panel grubuyla önceki hesap: ' + e(s.hesapOnce.tipAd || '') + ' → ' + t2(s.hesapOnce.toplam) + ' TL</span>' : '') + '</div>';
    h += '<table><tr><th>Kalem</th><th>Uygulama (hesap)</th><th>Reel fatura (PDF)</th><th>Fark (uygulama − PDF)</th><th style="text-align:left">Açıklama</th></tr>' + govde + '</table>';
    // Tutarlılık kontrolü: kalemler + ETV + KDV = fatura tutarı (yuvarlama farkı birkaç kuruş / lira olabilir)
    const kalemTop = [...(r.kalemler || []), ...(r.diger || []).filter(k => !/yuvarlama/i.test(k.ad))].reduce((a, k) => a + (k.tutar || 0), 0) + (r.etv || 0) + (r.kdv || 0);
    if (r.faturaTutari != null) {
      const f = r.faturaTutari - kalemTop, ok = Math.abs(f) < 5;
      h += '<div class="kontrol ' + (ok ? 'k-ok' : 'k-hata') + '">🧮 Kontrol: kalemler + ETV + KDV = <b>' + t2(kalemTop) + ' TL</b> · fatura tutarı <b>' + t2(r.faturaTutari) + ' TL</b> → ' + (ok ? '✔ tutuyor' + (Math.abs(f) >= 0.01 ? ' (yuvarlama ' + isaretli(f, t2) + ' TL)' : '') : '⚠ ' + isaretli(f, t2) + ' TL açıklanamayan fark: fatura PDF’ine bakılmalı') + (pVergi != null && r.etv != null ? ' · Vergi ve Fonlar ' + t2(pVergi) + ' = ETV ' + t2(r.etv) + ' + KDV ' + t2(r.kdv) + ' ✔' : '') + '</div>';
    }
    // Faturadaki kalemler
    const cip = (sinif, metin) => '<span class="cip ' + sinif + '">' + metin + '</span>';
    const kalemCip = k => cip(/güvence/i.test(k.ad) ? 'c-guv' : /güç bedeli|trafo/i.test(k.ad) ? 'c-guc' : (k.tutar < 0 || k.miktar < 0) ? 'c-dus' : '', e(k.ad) + (k.miktar ? ' ' + k3(k.miktar) + ' ' + (k.birimi || '') + (k.birim ? ' × ' + k.birim.toLocaleString('tr-TR', { maximumFractionDigits: 4 }) : '') : '') + ' = <b>' + t2(k.tutar) + '</b>');
    h += '<div class="cipler"><b style="margin-right:4px">Faturadaki kalemler:</b>' + (r.kalemler || []).map(kalemCip).join('') + (r.diger || []).filter(k => !/yuvarlama/i.test(k.ad)).map(kalemCip).join('')
      + (r.etv != null ? cip('c-ver', 'ETV = <b>' + t2(r.etv) + '</b>') : '') + (r.kdv != null ? cip('c-ver', 'KDV (matrah ' + t2(r.kdvMatrah) + ') = <b>' + t2(r.kdv) + '</b>') : '') + '</div>';
    // Yorum: uygulamanın hesabında olmayan kalemler farkı açıklıyor mu?
    const kdvO = r.kdv && r.kdvMatrah ? r.kdv / r.kdvMatrah : 0.2;
    const disi = (r.guvence || 0) + ((r.gucBedeli || 0) + (r.trafoKaybi || 0)) * (1 + kdvO);
    let y = [];
    if (r.guvence) y.push('<b>Güvence bedeli ' + t2(r.guvence) + ' TL</b> bu faturaya eklenmiş (KDV’siz, enerji tüketimi değil)');
    if (r.gucBedeli) y.push('<b>Güç bedeli ' + t2(r.gucBedeli) + ' TL</b> (+KDV; OG çift terim, anlaşma gücü ' + k3(r.anlasmaGucu) + ' kW)');
    if (r.trafoKaybi) y.push('<b>Trafo kaybı ' + t2(r.trafoKaybi) + ' TL</b>');
    if (r.dusulen && r.dusulen.length) y.push('<b style="color:#1e7045">Düşülen kalemler ' + t2(r.dusulenTL) + ' TL</b>' + (r.dusulenKwh ? ' (' + k3(r.dusulenKwh) + ' kWh; GES tesislerinde mahsup edilen enerji bu satırlarda görünür)' : ''));
    if (y.length || hesap != null) {
      let c = y.length ? 'Faturada uygulamanın hesabında olmayan kalemler: ' + y.join(' · ') + '.' : '';
      if (hesap != null && r.odenecek != null && disi) {
        const kalan = r.odenecek - disi - hesap;
        c += ' Bu kalemler çıkarılınca ödenen − hesap farkı <b style="color:' + (Math.abs(kalan) <= hesap * 0.03 + 10 ? '#1e8449' : '#a93226') + '">' + isaretli(kalan, t2) + ' TL</b> (' + (hesap ? isaretli(kalan / hesap * 100, v => v.toLocaleString('tr-TR', { maximumFractionDigits: 1 })) + '%' : '') + ')' + (Math.abs(kalan) <= hesap * 0.03 + 10 ? ': fark bu kalemlerden kaynaklanıyor, enerji fiyatı hesapla uyumlu.' : '.');
      }
      if (c) h += '<div class="yorum">💡 ' + c + '</div>';
    }
    h += '<div style="margin-top:6px"><a class="dug" href="/belge-gor/' + encodeURIComponent(r.belge.id) + '" target="_blank">🧾 Fatura görselini aç</a><a class="dug" href="/belge/' + encodeURIComponent(r.belge.id) + '?indir=1">⬇ PDF indir</a></div>';
    return h + '</div>';
  }

  window.pdfSerit = async function (faturaNo, ev) {
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    // Tıklanan satırı komple renklendir (öncekinin vurgusu kalkar)
    vurguKaldir();
    const tr = ev && ev.target && ev.target.closest ? ev.target.closest('tr') : null;
    if (tr) tr.classList.add('secili-satir');
    const s = (typeof V !== 'undefined' && V && V.satirlar || []).find(x => x.faturaNo === faturaNo) || { faturaNo };
    const k = kap(); if (!k) return;
    k.innerHTML = STIL + '<div class="pdf-serit">⏳ <b>' + e(faturaNo) + '</b> faturasının PDF’i okunuyor…</div>';
    let r;
    try { r = await (await fetch('/api/fatura-pdf?faturaNo=' + encodeURIComponent(faturaNo))).json(); } catch (x) { r = { ok: false, hata: 'Sunucuya ulaşılamadı: ' + x.message }; }
    k.innerHTML = html(s, r);
    k.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  // Fatura görüntüleme sayfası (belge-gor) aynı karşılaştırmayı kullanır
  window.pdfSeritHtml = html;
  // Fatura no hücresi: tıklanabilir bağlantı (satırın kendi tıklamasını tetiklemez)
  window.faturaNoBag = no => no ? '<a class="fno" href="#" title="Tıklayın: tablonun üstünde tüketim, reel fatura (PDF) ve ödenen tutar yan yana" onclick="pdfSerit(\'' + String(no).replace(/[^A-Za-z0-9]/g, '') + '\', event)">' + no + '</a>' : '';
})();
