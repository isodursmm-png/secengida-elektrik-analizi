-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- ELEKTRİK ANALİZİ · Tarihli güvence bedeli (depozito / teminat) geçmişi
-- 001_sema.sql'den sonra SQL Editor'da bir kez çalıştırın. Tekrar çalıştırmak güvenlidir.
-- Bir sözleşmenin güvence bedeli zamanla değişebilir (ek güvence, güncelleme, iade). Her değişiklik
-- geçerlilik tarihiyle ayrı satırdır; fatura, dönemin son gününe kadar başlamış EN SON kayıtla eşleşir.
-- elektrik_sozlesmeler.guvence_bedeli_tl = güncel (son) tutar olarak kalır.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

create table if not exists public.elektrik_guvence_bedelleri (
  id                 bigint generated always as identity primary key,
  sozlesme_no        text not null references public.elektrik_sozlesmeler(sozlesme_no) on update cascade on delete cascade,
  gecerlilik_tarihi  date,                                -- null: başlangıçtan beri (tarihi bilinmeyen ilk yatırılan)
  tutar_tl           numeric(14, 2) not null,
  aciklama           text,
  kayit              timestamptz not null default now(),
  constraint elektrik_guvence_tekil unique nulls not distinct (sozlesme_no, gecerlilik_tarihi)
);
create index if not exists elektrik_guvence_sozlesme_idx on public.elektrik_guvence_bedelleri (sozlesme_no, gecerlilik_tarihi);
alter table public.elektrik_guvence_bedelleri enable row level security;

-- Daha önce tek tutar olarak girilmiş güvence bedelleri tarihsiz ilk kayıt olarak taşınır
insert into public.elektrik_guvence_bedelleri (sozlesme_no, gecerlilik_tarihi, tutar_tl)
select sozlesme_no, null, guvence_bedeli_tl from public.elektrik_sozlesmeler
where guvence_bedeli_tl is not null
on conflict on constraint elektrik_guvence_tekil do nothing;

-- Fatura detayı: her fatura kendi döneminde geçerli güvence bedeliyle
create or replace view public.v_elektrik_fatura_detay with (security_invoker = true) as
select f.*, s.firma, g.tutar_tl as guvence_bedeli_tl,
       extract(year from f.donem)::int as yil, extract(month from f.donem)::int as ay
from public.elektrik_faturalar f
left join public.elektrik_sozlesmeler s using (sozlesme_no)
left join lateral (
  select b.tutar_tl from public.elektrik_guvence_bedelleri b
  where b.sozlesme_no = f.sozlesme_no
    and (b.gecerlilik_tarihi is null or b.gecerlilik_tarihi <= (f.donem + interval '1 month - 1 day')::date)
  order by b.gecerlilik_tarihi desc nulls last
  limit 1
) g on true;

notify pgrst, 'reload schema';
