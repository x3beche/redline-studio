# X3 Studios Asset Manager

Parametrik CAD modellerini tarayicida inceleyip **uzerine cizerek revizyon notu
birakmaya** yarayan bir arac. Model Python'da (build123d) tanimlanir, tarayicida
VS Code'daki **OCP CAD Viewer**'in birebir ayni goruntuleyicisiyle acilir; bir
aci secip donduruyor, kirmizi kalemle isaretliyor, yorumunu yaziyorsunuz.
Kayitlar MongoDB'ye, isaretli goruntu diske dusuyor.

![tek ekran arayuz](docs/screenshot.png)

## Neden

CAD revizyonu konusurken "su kose pahli olsun" demek zor; hangi kose, ne kadar?
Bu arac o konusmayi somutlastiriyor: donmus bir goruntu, uzerinde isaret, yaninda
kamera acisi ve parca adi. Kayit acildiginda tam o aciya geri donulebiliyor.

## Yigin

| Katman | Teknoloji |
|---|---|
| Model | Python 3.12 + [build123d](https://github.com/gumyr/build123d) (OpenCascade) |
| Tessellation | `ocp_vscode` / `ocp-viewer-core` |
| Goruntuleyici | [three-cad-viewer](https://github.com/bernhard-42/three-cad-viewer) 5.0.6 |
| Arayuz | Angular 20 + Tailwind CSS 4 |
| Servis | FastAPI + Uvicorn |
| Veri | MongoDB (Atlas ya da yerel); URI yoksa yerel JSON'a duser |

## Kurulum

Gereksinimler: **Python >= 3.10**, **Node >= 20.19**, ImageMagick (yalnizca
`tools/views.py` icin).

```bash
git clone https://github.com/x3beche/x3-studios-asset-manager.git
cd x3-studios-asset-manager
./start.sh
```

`start.sh` ilk calistirmada sanal ortami kurar, npm bagimliliklarini indirir,
modeli tessellate edip `assets/model.json` uretir ve iki sunucuyu da canli
yeniden yukleme ile baslatir:

- arayuz  <http://127.0.0.1:4200>  (Angular, hot reload)
- API     <http://127.0.0.1:8000>  (FastAPI, `--reload`)

Tek sunucuda derlenmis surum icin:

```bash
./start.sh --build      # yalnizca http://127.0.0.1:8000
```

## Veritabani

Varsayilan olarak kayitlar `revisions/_index.json` dosyasina yazilir; hicbir
ayar gerekmez. MongoDB kullanmak icin `.env.example` dosyasini `.env` olarak
kopyalayin:

```bash
cp .env.example .env
# MONGODB_URI=... satirini doldurun
```

Baglanti dizesi **yalnizca backend'de** okunur, arayuze hicbir sekilde
gecmez. `.env` dosyasi `.gitignore` icindedir.

## Kullanim

1. Modeli fareyle cevirin, istediginiz aciyi bulun.
2. **Dondur ve ciz** &rarr; goruntu kilitlenir.
3. Kalem rengini secip isaretleyin (geri al / temizle var).
4. Sag panelde parcayi secin, yorumu yazin, **Revizyonu kaydet**.
5. Liste uzerinden *aciya git* ile o kameraya donun, *uygulandi* / *iptal* ile
   durumu isaretleyin.

Kaydedilen her revizyon:

- `revisions/<id>.png` &mdash; isaretlenmis goruntu
- veritabaninda &mdash; yorum, kamera durumu, parca adi, zaman damgasi, durum

## Kendi modelinizi koymak

`models/` altina build123d ile yazilmis bir modul koyun ve `export_model.py`
icindeki parca listesini guncelleyin:

```python
parts = [F.frame, F.rotor, ...]        # build123d Part/Compound nesneleri
NAMES = ["govde", "pervane", ...]      # agacta gorunecek adlar
```

Sonra `./start.sh --build`.

Depodaki ornek `models/fan_pro.py`, 120x120x25 mm parametrik bir PC kasa fani:
govde, 9 kanatli pervane, 4 pinli konnektor ve 4 kutuplu BLDC motor (stator,
sargilar, surucu karti, miknatis, mil).

## Dizin duzeni

```
backend/main.py      FastAPI: revizyon CRUD, statik dosyalar
frontend/            Angular arayuz (three-cad-viewer sarmalayicisi)
models/fan_pro.py    ornek parametrik model
tools/views.py       olcekli ortografik gorunum ureteci (PNG, mm izgarali)
export_model.py      model -> assets/model.json
start.sh             gelistirme sunucusu
```

## Bilinen tuzaklar

- **Chrome'da WebGL acilmiyorsa** goruntuleyici baslamaz. Chrome 137+ otomatik
  yazilim yedegini kaldirdi. Melez Intel + NVIDIA makinelerde
  `chrome://flags/#use-angle` &rarr; **OpenGL** secmek cozuyor.
- `export_gltf` / tessellation cagrilarinda sekilde onceden triangulation
  varsa `linear_deflection` sessizce yok sayilir; once `BRepTools.Clean_s`.

## Lisans

MIT
