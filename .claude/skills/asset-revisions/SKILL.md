---
name: asset-revisions
description: Bu projede bekleyen CAD revizyon taleplerini veritabanindan oku ve uygula. Kullanici modeli tarayicida donduruyor, uzerine kirmizi kalemle ciziyor ve bir not birakiyor; talepler MongoDB'de durur, diskte degil. Su durumlarda kullan - "revizyonlari kontrol et", "sirada ne var", "bekleyen istek", "cizdigim seyi uygula", "modeli guncelle", ya da bu depoda ise baslarken ne yapilacagini ogrenmek icin.
---

# CAD revizyonlarini oku ve uygula

Bu depo bir **CAD revizyon araci**. Kullanici parametrik bir build123d modelini
tarayicida acar, bir aciyi dondurur, uzerine kirmizi kalemle isaret koyar ve
yorumunu yazar. Talep MongoDB'ye duser. **Diskte model dosyasi yoktur**; kaynak
kod da uretilen dosyalar da veritabanindadir.

## Onemli: yalnizca "sirada" olanlar isindir

Revizyonlarin dort durumu var:

| Durum | Anlami |
|---|---|
| `draft` | kullanici hala yaziyor — **sana gorunmez, dokunma** |
| `queued` | uygulama sirasina alindi — **isin bunlar** |
| `applied` | uygulandi |
| `rejected` | iptal |

Kullanici "siraya al" demeden bir revizyon is sayilmaz. Taslaklari kendi
inisiyatifinle uygulamaya kalkma.

## Akis

Tum komutlar depo kokunden, projenin sanal ortamiyla calisir:

```bash
.venv/bin/python tools/revisions.py queue
```

### 1. Sirada ne var

```bash
.venv/bin/python tools/revisions.py queue
```

Her kayit icin yorum, hangi model, hangi parca, kamera acisi ve goruntu
komutu yazar.

### 2. Cizimi gor — bu adimi atlama

```bash
.venv/bin/python tools/revisions.py show <id>
```

PNG'yi diske yazar ve yolunu soyler. **Read araciyla o dosyayi ac ve bak.**
Yorum tek basina yeterli degil: "bu kisimlara" derken hangi kisim oldugunu
yalnizca kirmizi isaretler soyler. Isaretlerin modelin neresine denk geldigini
kamera acisiyla birlikte degerlendir.

### 3. Kaynagi al, degistir, geri yaz

```bash
.venv/bin/python tools/revisions.py source fan_pro > /tmp/fan_pro.py
# /tmp/fan_pro.py dosyasini duzenle
.venv/bin/python tools/revisions.py save fan_pro /tmp/fan_pro.py
.venv/bin/python tools/revisions.py build fan_pro
```

`build` tessellation calistirir ve viewer/STEP/STL ciktilarini veritabanina
yazar. Yaklasik 15 saniye surer. Uretmezsen kullanici degisikligi goremez.

Buyuk bir degisiklikten once surum almak isteyebilirsin:

```bash
curl -s -X POST "http://127.0.0.1:8000/api/versions?note=degisiklik%20oncesi"
```

### 4. Isaretle

```bash
.venv/bin/python tools/revisions.py done <id>
```

Sadece is gercekten bitince. Emin degilsen kullaniciya sor.

## Modeli degistirirken

Model modulu su sozlesmeyi saglar; bozarsan katalogda gorunmez:

```python
TITLE = "Fan 120 mm"          # arayuzdeki ad
PARTS = [frame, rotor, pins]  # tessellate edilecek build123d nesneleri
NAMES = ["govde", "pervane", "pinler"]
```

Modeller parametriktir. Bir olcu istendiginde sabiti degistir, geometriyi elle
yeniden yazma. Degisiklikten sonra hacim, gabari ve girisim degerlerini
kontrol et — model dosyalari bunlari zaten yazdirir.

## Bu kod tabaninin tuzaklari

- **Tessellation onbellegi**: sekilde zaten triangulation varsa
  `linear_deflection` **sessizce yok sayilir**. Once `BRepTools.Clean_s`.
- **`Plane.rotated()` global aci alir**, yerel degil. Yerel eksende dondurdugunu
  sanmak sessiz geometri hatasi uretir.
- **Loft kesitleri poligon olmali**: elips telleriyle OCCT kesitleri
  eslestiremeyip `NCollection_DataMap::Find` atar.
- **`Compound(children=[...])` parcalari yeniden ebeveynler**; yardimci compound
  kurmak onlari onceki compound'dan koparir ve gabariyi bozar.

## Dogrudan veritabani

Arac yetmezse koleksiyonlar: `revisions`, `models`, `folders`,
`model_versions`; GridFS kovalari `model_files` (uretilen dosyalar, gzip'li) ve
`shots` (revizyon goruntuleri). Baglanti `.env` icindeki `MONGODB_URI`.

Sunucu ayaktaysa HTTP de var: `GET /api/queue`,
`GET /api/revisions/{id}/image`, `POST /api/models/{id}/build`.
