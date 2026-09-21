# Bu depoda calisan modeller icin

Burasi bir **CAD revizyon araci**. Kullanici parametrik bir build123d modelini
tarayicida acar, bir aciyi dondurur, uzerine kirmizi kalemle isaret koyar ve bir
not birakir. Talep MongoDB'ye duser.

**Diskte model dosyasi yoktur.** Kaynak kod da uretilen dosyalar da
veritabanindadir; `models/` diye bir klasor aramayin.

## Ilk yapilacak

```bash
.venv/bin/python tools/revisions.py queue
```

Sirada is varsa `show` ile cizimi diske alip **Read araciyla acin**. Yorum tek
basina yetmez: "bu kisimlara" derken hangi kisim oldugunu yalnizca kirmizi
isaretler soyler.

## Yalnizca `queued` olanlar istir

| Durum | Anlami |
|---|---|
| `draft` | kullanici hala yaziyor — **dokunmayin** |
| `queued` | **isiniz bu** |
| `applied` / `rejected` | kapandi |

Kullanici "siraya al" demeden bir revizyon is sayilmaz.

## Komutlar

```bash
.venv/bin/python tools/revisions.py queue                 # siradakiler
.venv/bin/python tools/revisions.py show <id>             # cizimi diske yaz
.venv/bin/python tools/revisions.py models                # modeller
.venv/bin/python tools/revisions.py source <model>        # kaynagi yazdir
.venv/bin/python tools/revisions.py save <model> <dosya>  # kaynagi guncelle
.venv/bin/python tools/revisions.py build <model>         # yeniden uret (~15 sn)
.venv/bin/python tools/revisions.py done <id>             # uygulandi isaretle
```

`build` calistirmazsaniz kullanici degisikligi goremez.

## Model sozlesmesi

```python
TITLE = "Fan 120 mm"
PARTS = [frame, rotor, pins]            # tessellate edilecek nesneler
NAMES = ["govde", "pervane", "pinler"]  # agactaki adlar
```

Modeller parametriktir: bir olcu istendiginde sabiti degistirin, geometriyi
elden yeniden yazmayin.

## Sessiz hatalar

Bu kod tabaninda daha once tuzaga dusulmus yerler:

- **Tessellation onbellegi** — sekilde triangulation varsa `linear_deflection`
  sessizce yok sayilir. Once `BRepTools.Clean_s`.
- **`Plane.rotated()` global aci alir**, yerel degil. Yerel sandiginizda
  geometri sessizce yanlis cikar.
- **Loft kesitleri poligon olmali** — elips telleriyle OCCT
  `NCollection_DataMap::Find` atar.
- **`Compound(children=[...])` yeniden ebeveynler** — yardimci compound kurmak
  parcalari oncekinden koparir, gabari bozulur.
- **Binary dosya tararken `grep -a`** — PNG'leri de iceren birlesik bir dosyada
  grep ikili sanip sessizce hicbir sey bulmaz.

## Mimari

| Katman | Yer |
|---|---|
| Model kaynagi | `models` koleksiyonu |
| Uretilen viewer/STEP/STL | GridFS `model_files` (gzip) |
| Revizyon goruntuleri | GridFS `shots` |
| Surum gecmisi | `model_versions` — yalnizca kaynak metni |
| Uretim | gecici dizin, is bitince silinir |

Ayrinti icin `.claude/skills/asset-revisions/SKILL.md`.
