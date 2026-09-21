<div align="center">

# X3 Studios Asset Manager

**Parametrik CAD modellerini tarayicida ac, bir aciyi dondur, uzerine ciz,
revizyon notunu birak.** Proje verisinin tamami MongoDB'de durur.

</div>

![arayuz](docs/screenshot.png)

## Ne ise yarar

CAD revizyonu konusurken "su kose pahli olsun" demek zordur: hangi kose, ne
kadar? Bu arac o konusmayi somutlastirir. Modeli cevirirsiniz, begendiginiz
aciyi dondurursunuz, kirmizi kalemle isaretlersiniz, yorumunuzu yazarsiniz.
Kayit; isaretli goruntu, kamera acisi, secili parca ve model adiyla birlikte
saklanir. Sonradan "aciya git" ile tam o kameraya donulur.

Revizyonlar once **taslak** olarak durur. Siz "siraya al" diyene kadar
`GET /api/queue` bos doner; yani bir modelin ya da ekip arkadasinin gordugu
liste yalnizca sizin onayladiklarinizdir.

## Yigin

| Katman | Teknoloji |
|---|---|
| Model | Python 3.12 + [build123d](https://github.com/gumyr/build123d) (OpenCascade) |
| Tessellation | `ocp_vscode` / `ocp-viewer-core` |
| Goruntuleyici | [three-cad-viewer](https://github.com/bernhard-42/three-cad-viewer) 5.0.6 — VS Code eklentisindeki goruntuleyicinin ta kendisi |
| Arayuz | Angular 20 + Tailwind CSS 4 |
| Servis | FastAPI + Uvicorn |
| Veri | MongoDB + GridFS |

## Veri nerede duruyor

Diskte proje verisi **yok**. Model uretimi sirasinda gecici bir dizin acilir,
is biter bitmez silinir.

| Koleksiyon | Icerik |
|---|---|
| `models` | model kaynak kodu, baslik, sha256, uretilen dosya referanslari |
| `folders` | katalog klasorleri |
| `revisions` | yorum, kamera, parca, durum, sira zamani |
| `model_versions` | surum gecmisi (son surum + 10 kayit), yalnizca kaynak metni |
| `model_files` (GridFS) | uretilen viewer JSON / STEP / STL, gzip'li |
| `shots` (GridFS) | isaretli revizyon goruntuleri |

Surum gecmisi bilincli olarak yalnizca **kaynak kodu** tutar: viewer/STEP/STL
kaynaktan tureyen ciktilardir, geri donduktan sonra yeniden uretilir. Boylece
gecmis kilobaytlarla olculur, megabaytlarla degil.

## Kurulum

Gereksinimler: **Python >= 3.10**, **Node >= 20.19**, bir MongoDB baglantisi
(Atlas ya da yerel).

```bash
git clone https://github.com/x3beche/x3-studios-asset-manager.git
cd x3-studios-asset-manager
cp .env.example .env          # MONGODB_URI satirini doldurun
./start.sh
```

`start.sh` ilk calistirmada sanal ortami kurar, npm bagimliliklarini indirir ve
iki sunucuyu da canli yeniden yukleme ile baslatir:

- arayuz <http://127.0.0.1:4200>
- API <http://127.0.0.1:8000>

Tek sunucuda derlenmis surum: `./start.sh --build` &rarr; yalnizca `:8000`.

Baglanti dizesi yalnizca backend'de okunur, arayuze hicbir sekilde gecmez.
`.env` dosyasi `.gitignore` icindedir.

## Yapay zeka ile calisma

Depoda modeller icin iki dosya var:

- **`AGENTS.md`** — bu depoda ise baslayan bir modelin ilk okumasi gereken ozet
- **`.claude/skills/asset-revisions/SKILL.md`** — Claude Code skill'i; "sirada
  ne var", "cizdigimi uygula" gibi isteklerde kendiliginden devreye girer

Revizyonlar veritabaninda durdugu icin bir model, projeyi actigi anda bekleyen
talepleri gorebilir:

```bash
.venv/bin/python tools/revisions.py queue    # siradaki talepler
.venv/bin/python tools/revisions.py show ID  # isaretli cizimi diske yaz
.venv/bin/python tools/revisions.py source fan_pro > /tmp/m.py
.venv/bin/python tools/revisions.py save fan_pro /tmp/m.py
.venv/bin/python tools/revisions.py build fan_pro
.venv/bin/python tools/revisions.py done ID
```

Arac sunucu calismasa da dogrudan MongoDB'ye baglanir. Yalnizca **siraya
alinmis** revizyonlar is sayilir; taslaklar gorunmez.

## Kullanim

1. Sol sutunda **+M** ile model olusturun. Iskelet kod hazir gelir.
2. Modeli yazin, **↻** ile uretin (build123d calisir, sonuc veritabanina gider).
3. Modele tiklayip goruntuleyicide acin. Parcaya **cift tiklayinca** sagdaki
   form kendiliginden dolar.
4. **Dondur ve ciz** &rarr; isaretleyin &rarr; yorumu yazip kaydedin.
5. Hazir oldugunda **siraya al**. Kart uzerinden cizimi buyutup gorebilirsiniz.

Kart uzerindeki tek dugme durumu dondurur: taslak &rarr; sirada &rarr;
uygulandi &rarr; taslak. Yani "uygulandi" geri de alinabilir.

### Model sozlesmesi

Bir modul katalogda gorunmek icin sunlari tanimlar:

```python
TITLE = "Fan 120 mm"                  # istege bagli, arayuzde gorunen ad
PARTS = [frame, rotor, pins]          # tessellate edilecek build123d nesneleri
NAMES = ["govde", "pervane", "pinler"]  # istege bagli, agactaki adlar
```

## API

| Uc | Is |
|---|---|
| `GET /api/catalog` | klasor + model agaci |
| `PUT /api/models/{id}` | kaynak kodu yaz |
| `POST /api/models/{id}/build` | tessellate et, ciktiyi veritabanina koy |
| `GET /api/models/{id}/viewer.json` | goruntuleyici verisi |
| `GET /api/models/{id}/file/{step\|stl}` | uretilen dosya |
| `GET /api/queue` | **yalnizca siraya alinmis revizyonlar** |
| `GET /api/revisions/{id}/image` | isaretli goruntu |
| `DELETE /api/revisions/{id}` | revizyonu ve goruntusunu sil |
| `POST /api/versions` · `POST /api/versions/{id}/restore` | surum al / geri don |
| `GET /api/stats` · `GET /api/system` | veritabani doluluğu, CPU/RAM/GPU |

## Bilinen tuzaklar

- **Chrome'da WebGL acilmiyorsa** goruntuleyici baslamaz. Chrome 137+ otomatik
  yazilim yedegini kaldirdi. Melez Intel + NVIDIA makinelerde
  `chrome://flags/#use-angle` &rarr; **OpenGL** secmek cozuyor; test ettigimiz
  makinede varsayilan ANGLE arka ucu GPU komut tamponu olusturamiyordu.
- `export_gltf` ve tessellation cagrilarinda sekilde onceden triangulation
  varsa `linear_deflection` **sessizce yok sayilir**; once `BRepTools.Clean_s`.
- `three-cad-viewer` dokumanindaki `display.render(...)` ornegi yaniltici;
  `render()` `Viewer` uzerindedir ve `resizeCadView` ilk `render()` oncesinde
  hata firlatir.
- `Plane.rotated()` **global** aci alir, yerel degil — yerel sandiginizda
  geometri sessizce yanlis cikar.
- Loft kesitleri poligon olmali; elips telleriyle OCCT kesitleri
  eslestiremeyip `NCollection_DataMap::Find` atar.
- `Compound(children=[...])` parcalari **yeniden ebeveynler**; yardimci bir
  compound kurmak onlari oncekinden koparir ve gabariyi bozar.

## Lisans

MIT
