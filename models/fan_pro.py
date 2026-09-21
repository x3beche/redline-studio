"""120 x 120 x 25 mm modiler PC kasa fani.

Profesyonel detaylar:
  - venturi girisli, giris/cikis agzi yuvarlatilmis hava kanali
  - havsali montaj delikleri, koselerde malzeme kazanci cepleri
  - ileri supurmeli (skew), kamburlu, burulan kanatlar
  - cerceveye gomulu 4 pinli DISI header - kullanici kendi kablosunu takar
  - motordan header'a ic kablo kanali + alt yuzeyde kablo oluğu
"""

import math
from pathlib import Path

from build123d import *

# Cikti yollari dosyanin kendi konumuna bagli; baska dizinden import
# edildiginde cwd'ye gore relatif yol kiriliyordu.
ROOT = Path(__file__).resolve().parent.parent   # depo koku

# ---------------- cerceve ----------------
SIZE, DEPTH = 120.0, 25.0
CORNER_R = 7.5                 # kose yaricapi -> delik araligi 105 (standart)
HOLE_D, HOLE_CHAMFER = 4.4, 0.9
BORE_R = 56.5
INLET_R, OUTLET_R = 2.5, 1.5   # hava kanali agiz yuvarlatmalari
OUTER_R = 1.0                  # dis kenar yumusatmasi
POCKET_OD, POCKET_ID, POCKET_H = 12.0, 8.0, 2.0   # kosedeki kazanc cebi

# ---------------- kollar / yatak ----------------
N_STRUTS, STRUT_W, STRUT_T = 4, 5.0, 5.0   # kalinlik 5: kablo tuneli icine sigsin
STRUT_A = 30.0                 # ilk kolun acisi; header de bu isin uzerinde
BOSS_D, BOSS_H, SHAFT_D = 20.0, 14.0, 6.0

# ---------------- disi header ----------------
HDR_W, HDR_H, HDR_DEPTH = 10.4, 5.6, 8.0
HDR_Z = 9.5                    # kavite merkezi - altinda 6.7 mm saglam taban kalir
HDR_MOUTH = 0.6                # agiz genislemesi
N_PINS, PIN_PITCH = 4, 2.54
PIN_SQ, PIN_OUT, PIN_IN = 0.64, 6.0, 2.0   # kare pin; kaviteye tasan / gomulu boy
KEY_W, KEY_H = 1.4, 1.0        # ters takmayi onleyen kama kanali
CABLE_D, CABLE_Z = 2.6, 2.6    # tunel capi / cita icindeki yuksekligi

# ---------------- pervane ----------------
HUB_D, HUB_H, ROTOR_Z = 43.0, 18.0, 5.5
HUB_WALL, HUB_TOP = 2.0, 3.0   # gobek ince cidarli kap - en buyuk malzeme kazanci
HUB_DOME = 3.0
N_BLADES, BLADE_T, CAMBER = 9, 1.2, 0.09
CHORD_ROOT, CHORD_TIP = 20.0, 28.0
PITCH_ROOT, PITCH_TIP = 40.0, 22.0
SKEW = 28.0                    # uca dogru ileri supurme (derece)
TIP_GAP, ROOT_SINK = 1.5, 2.0

HOLE_SPACING = SIZE - 2 * CORNER_R
SWEEP_R = BORE_R - TIP_GAP
softened, skipped = [], []


def soften(shape, edges, radius, label):
    """Fillet dener; OCCT reddederse parcayi bozmadan geri doner."""
    try:
        out = fillet(edges, radius)
        softened.append(f"{label} r{radius}")
        return out
    except Exception as exc:
        skipped.append(f"{label} r{radius} ({type(exc).__name__})")
        return shape


def airfoil(chord, thick, camber, n=24):
    """Parabolik kambur + eliptik kalinlik dagilimi, kapali poligon.

    Poligon cunku loft her kesitte ayni sayida, ayni siradaki noktayi birebir
    eslestirmek zorunda; elips telleriyle OCCT NCollection_DataMap::Find atiyor.
    """
    upper, lower = [], []
    for i in range(n + 1):
        s = i / n
        x = s * chord - chord / 2
        y_c = 4 * camber * s * (1 - s)
        t = max(thick * math.sqrt(max(0.0, 1 - (2 * s - 1) ** 2)), thick * 0.15)
        upper.append((x, y_c + t / 2))
        lower.append((x, y_c - t / 2))
    return upper + lower[::-1]


def hole_tool(radius, chamfer):
    """Iki ucu havsali delme takimi - kenar secmeye gerek birakmaz."""
    tool = Pos(0, 0, -1) * Cylinder(radius, DEPTH + 2,
                                    align=(Align.CENTER, Align.CENTER, Align.MIN))
    tool += Cone(radius + chamfer, radius, chamfer,
                 align=(Align.CENTER, Align.CENTER, Align.MIN))
    tool += Pos(0, 0, DEPTH - chamfer) * Cone(radius, radius + chamfer, chamfer,
                                              align=(Align.CENTER, Align.CENTER, Align.MIN))
    return tool


# ==================== CERCEVE ====================
with BuildSketch() as profile:
    Rectangle(SIZE, SIZE)
    fillet(profile.vertices(), CORNER_R)
    Circle(BORE_R, mode=Mode.SUBTRACT)
frame = extrude(profile.sketch, amount=DEPTH)

# hava kanali agizlari: venturi girisi + cikis yuvarlatmasi
top_face = frame.faces().sort_by(Axis.Z)[-1]
bot_face = frame.faces().sort_by(Axis.Z)[0]
bore_top = max(top_face.inner_wires(), key=lambda w: w.length).edges()
bore_bot = max(bot_face.inner_wires(), key=lambda w: w.length).edges()
frame = soften(frame, bore_top, INLET_R, "kanal girisi")
frame = soften(frame, bore_bot, OUTLET_R, "kanal cikisi")

# dis kenarlar
faces = frame.faces().sort_by(Axis.Z)
outer = list(faces[-1].outer_wire().edges()) + list(faces[0].outer_wire().edges())
frame = soften(frame, outer, OUTER_R, "dis kenar")

# tasiyici kollar + motor yatagi
with BuildSketch() as web:
    with PolarLocations(BORE_R / 2, N_STRUTS, start_angle=STRUT_A):
        Rectangle(BORE_R, STRUT_W)
    # Buraya Circle(BOSS_D/2) KOYMA: yatak silindiriyle birebir ayni yaricap,
    # cakisan yan yuzeyler gecersiz kati uretiyor. r<10 zaten yatak dolduruyor.
frame += extrude(web.sketch, amount=STRUT_T)
frame += Cylinder(BOSS_D / 2, BOSS_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
frame -= Cylinder(SHAFT_D / 2, BOSS_H + STRUT_T,
                  align=(Align.CENTER, Align.CENTER, Align.MIN))

# montaj delikleri (havsali) + kosedeki malzeme kazanci cepleri
for sx in (-1, 1):
    for sy in (-1, 1):
        at = Pos(sx * HOLE_SPACING / 2, sy * HOLE_SPACING / 2, 0)
        frame -= at * hole_tool(HOLE_D / 2, HOLE_CHAMFER)
        ring = Cylinder(POCKET_OD / 2, POCKET_H,
                        align=(Align.CENTER, Align.CENTER, Align.MIN))
        ring -= Cylinder(POCKET_ID / 2, POCKET_H,
                         align=(Align.CENTER, Align.CENTER, Align.MIN))
        frame -= at * ring

# ==================== DISI HEADER ====================
a = math.radians(STRUT_A)
hdr_y = (SIZE / 2) * math.tan(a)          # kolun isini yan yuzde kestigi nokta
hdr_x = SIZE / 2 - HDR_DEPTH / 2
seat = Pos(hdr_x, hdr_y, HDR_Z)

cavity = Box(HDR_DEPTH + 2, HDR_W, HDR_H)                 # disari tasir, temiz keser
frame -= Pos(hdr_x + 1, hdr_y, HDR_Z) * cavity
frame -= Pos(SIZE / 2 - HDR_MOUTH / 2, hdr_y, HDR_Z) * \
    Box(HDR_MOUTH + 0.2, HDR_W + 2 * HDR_MOUTH, HDR_H + 2 * HDR_MOUTH)   # agiz pahi
frame -= Pos(hdr_x + 1, hdr_y, HDR_Z + HDR_H / 2 + KEY_H / 2) * \
    Box(HDR_DEPTH + 2, KEY_W, KEY_H)                      # kama kanali

# 4 kare erkek pin: arka duvara gomulu, kaviteye tasiyor (insert-molding).
# Ayri parca -> metal rengi, ayrica plastikte delik acmaya gerek kalmiyor.
pins = None
for i in range(N_PINS):
    dy = (i - (N_PINS - 1) / 2) * PIN_PITCH
    pin = Pos(SIZE / 2 - HDR_DEPTH + (PIN_OUT - PIN_IN) / 2, hdr_y + dy, HDR_Z) * \
        Box(PIN_OUT + PIN_IN, PIN_SQ, PIN_SQ)
    pin = chamfer(pin.edges().group_by(Axis.X)[-1], PIN_SQ * 0.22)   # ucu pahli
    pins = pin if pins is None else pins + pin

# ==================== KABLO YOLU ====================
def rod(p0, p1, radius):
    """p0 -> p1 arasi silindir."""
    d = Vector(*p1) - Vector(*p0)
    return Plane(origin=p0, z_dir=d) * Cylinder(
        radius, d.length, align=(Align.CENTER, Align.CENTER, Align.MIN))

# Kablo tuneli: yataktan cikar, citanin ICINDEN radyal gider, sonra pinlerin
# arkasina yukselir. Kaviteye hic girmez (x<=50.8, kavite x>=52) - onceki
# surumde kanal 30 derece isini boyunca gidip soketin tam ortasini deliyordu.
P0 = (3.5 * math.cos(a), 3.5 * math.sin(a), CABLE_Z)      # mil deligine acilir
elbow_x = SIZE / 2 - HDR_DEPTH - PIN_IN - 0.5              # 49.5: kavitenin gerisi
P1 = (elbow_x, elbow_x * math.tan(a), CABLE_Z)             # cita icinde, duvara girerken
P2 = (elbow_x, hdr_y, HDR_Z)                               # pin koklerinin arkasi
tunnel = rod(P0, P1, CABLE_D / 2) + Pos(*P1) * Sphere(CABLE_D / 2) \
    + rod(P1, P2, CABLE_D / 2)
frame -= tunnel

# ==================== PERVANE ====================
hub = Cylinder(HUB_D / 2, HUB_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
hub = soften(hub, hub.edges().filter_by(GeomType.CIRCLE).sort_by(Axis.Z)[-1],
             HUB_DOME, "gobek tepesi")
# gobek oyugu asagida, kanatlardan sonra aciliyor

r_root, r_tip = HUB_D / 2 - ROOT_SINK, BORE_R + 3.5
sections = []
N_SEC = 9
for i in range(N_SEC):
    t = i / (N_SEC - 1)
    r = r_root + t * (r_tip - r_root)
    ang = PITCH_ROOT + t * (PITCH_TIP - PITCH_ROOT)
    chord = CHORD_ROOT + t * (CHORD_TIP - CHORD_ROOT)
    # normal radyal, yerel x tegetsel; hatve GLOBAL X etrafinda
    # (Plane.rotated yerel degil global aci alir)
    plane = Plane(origin=(r, 0, HUB_H / 2),
                  x_dir=(0, 1, 0), z_dir=(1, 0, 0)).rotated((-ang, 0, 0))
    sec = plane * Polygon(*airfoil(chord, BLADE_T, CAMBER * chord), align=None)
    sections.append(Rot(Z=SKEW * t ** 2) * sec)            # ileri supurme
one = loft(sections)

rotor = hub
for i in range(N_BLADES):
    rotor += Rot(Z=i * 360 / N_BLADES) * one
# uclari supurme silindirine tirasla: kiris tegetsel uzandigi icin kesit
# merkezini SWEEP_R'ye koymak kose noktalarini disari tasirirdi
rotor &= Cylinder(SWEEP_R, 3 * HUB_H)
vol_solid_rotor = rotor.volume
rotor -= Cylinder(HUB_D / 2 - HUB_WALL, HUB_H - HUB_TOP,      # motor kabi
                  align=(Align.CENTER, Align.CENTER, Align.MIN))
rotor = Pos(0, 0, ROTOR_Z) * rotor

# ==================== MOTOR ====================
# Dis rotorlu BLDC: stator + sargilar + surucu karti govdeye sabit,
# miknatis halkasi ve mil pervaneyle birlikte doner.
PCB_OD, PCB_T, PCB_Z = 30.0, 1.2, 6.0
ST_OD, ST_ID, ST_H, ST_Z = 32.0, 20.4, 9.0, 7.6      # stator paket
ST_CORE, ST_SHOE = 24.4, 29.0                         # boyunduruk / kutup ayagi capi
N_POLES = 4
TOOTH_W = 5.0
COIL_T, COIL_MARGIN = 3.0, 1.8
MAG_OD, MAG_ID, MAG_H, MAG_Z = 38.9, 33.0, 11.0, 7.0  # miknatis halkasi
SHAFT_R, SHAFT_Z0 = 2.5, 2.0

cup_r = HUB_D / 2 - HUB_WALL                          # 19.5 - rotor ic cidari
cup_top = ROTOR_Z + HUB_H - HUB_TOP                   # 20.5

def ring(od, idd, h, z):
    return Pos(0, 0, z) * (Cylinder(od / 2, h, align=(Align.CENTER, Align.CENTER, Align.MIN))
                           - Cylinder(idd / 2, h, align=(Align.CENTER, Align.CENTER, Align.MIN)))

pcb = ring(PCB_OD, ST_ID, PCB_T, PCB_Z)

stator = ring(ST_CORE, ST_ID, ST_H, ST_Z)             # boyunduruk
coils = None
for i in range(N_POLES):
    ang = i * 360 / N_POLES
    r_mid = (ST_CORE + ST_SHOE) / 4 + ST_CORE / 4     # dis ile ic arasi
    tooth = Rot(Z=ang) * Pos((ST_CORE / 2 + ST_SHOE / 2) / 2, 0, ST_Z) * \
        Box(ST_SHOE / 2 - ST_CORE / 2, TOOTH_W, ST_H,
            align=(Align.CENTER, Align.CENTER, Align.MIN))
    shoe = Rot(Z=ang - 36) * (ring(ST_OD, ST_SHOE, ST_H, ST_Z) &
                              Pos(0, 0, ST_Z) * Cylinder(ST_OD, ST_H, arc_size=72,
                                                         align=(Align.CENTER, Align.CENTER, Align.MIN)))
    stator += tooth + shoe
    # sargi: dis kutu eksi dis (radyal yonde delip gecen) tooth kesiti
    c_out = Rot(Z=ang) * Pos((ST_CORE / 2 + ST_SHOE / 2) / 2, 0, ST_Z + ST_H / 2) * \
        Box(COIL_T, TOOTH_W + 2 * COIL_MARGIN, ST_H + 2 * COIL_MARGIN)
    c_in = Rot(Z=ang) * Pos((ST_CORE / 2 + ST_SHOE / 2) / 2, 0, ST_Z + ST_H / 2) * \
        Box(COIL_T + 2, TOOTH_W, ST_H)
    coil = c_out - c_in
    coils = coil if coils is None else coils + coil

magnet = ring(MAG_OD, MAG_ID, MAG_H, MAG_Z)
shaft = Pos(0, 0, SHAFT_Z0) * Cylinder(SHAFT_R, cup_top - SHAFT_Z0,
                                       align=(Align.CENTER, Align.CENTER, Align.MIN))

# ==================== RAPOR ====================
frame.label, frame.color = "govde", Color("gray55")
rotor.label, rotor.color = "pervane", Color("steelblue")
pins.label, pins.color = "pinler", Color("goldenrod")
for part, name, col in ((stator, "stator", "gainsboro"), (coils, "sargilar", "peru"),
                        (pcb, "surucu_karti", "darkgreen"),
                        (magnet, "miknatis", "dimgray"), (shaft, "mil", "lightsteelblue")):
    part.label, part.color = name, Color(col)
# Donen takim (rotor+miknatis+mil) ile sabit takim (govde+stator+sargi+kart)
# arasinda hicbir yerde temas olmamali. Kontrolu ikili kesisimle yapiyoruz:
# Compound(children=[...]) parcalari YENIDEN EBEVEYNLIYOR, yani yardimci
# compound kurmak onlari fan'dan koparip gabariyi bozuyordu.
motor_clash_vol = 0.0
for moving in (rotor, magnet, shaft):
    for still in (frame, stator, coils, pcb):
        hit = moving.intersect(still)
        if hit:
            motor_clash_vol += hit.volume

fan = Compound(label="fan_120_pro",
               children=[frame, rotor, pins, stator, coils, pcb, magnet, shaft])

bb = fan.bounding_box()
r_max = max(math.hypot(v.X, v.Y) for v in rotor.vertices())
clash = frame.intersect(rotor)
solid_block = SIZE * SIZE * DEPTH

print(f"gabari          : {bb.size.X:.2f} x {bb.size.Y:.2f} x {bb.size.Z:.2f} mm")
print(f"delik araligi   : {HOLE_SPACING:.1f} mm  Ø{HOLE_D} havsali {HOLE_CHAMFER}")
print(f"govde           : {frame.volume:9.1f} mm^3  gecerli={frame.is_valid}")
print(f"pervane         : {rotor.volume:9.1f} mm^3  {N_BLADES} kanat, "
      f"katilar={len(rotor.solids())}")
print(f"uc bosluğu      : {BORE_R - r_max:.2f} mm  (supurme {r_max:.2f})")
print(f"girisim         : {(clash.volume if clash else 0.0):.6f} mm^3")
saved_hub = vol_solid_rotor - rotor.volume
print(f"kasa yuzeyi     : duz - yuva, cizgi, yazi yok")
print(f"gobek kabugu    : {HUB_WALL} mm cidar, {saved_hub / 1000:.1f} cm^3 "
      f"kazanc (pervaneden %{saved_hub / vol_solid_rotor * 100:.1f})")
print(f"plastik         : {(frame.volume + rotor.volume) / 1000:.1f} cm^3  "
      f"= dolu blogun %{(frame.volume + rotor.volume) / solid_block * 100:.1f}'i")
print(f"header          : {N_PINS}x{PIN_SQ} kare pin, {PIN_PITCH} mm adim, "
      f"{PIN_OUT} mm disarida")
print(f"                  kavite {HDR_W}x{HDR_H}x{HDR_DEPTH}, taban "
      f"{HDR_Z - HDR_H / 2:.1f} mm, pin sayisi {len(pins.solids())}")
print(f"motor           : {N_POLES} kutuplu BLDC, stator Ø{ST_OD}, "
      f"miknatis Ø{MAG_ID}-{MAG_OD}, mil Ø{2 * SHAFT_R}")
print(f"  hava araligi  : {(MAG_ID - ST_OD) / 2:.2f} mm   "
      f"mil bosluğu: {SHAFT_D / 2 - SHAFT_R:.2f} mm   "
      f"miknatis-kap: {cup_r - MAG_OD / 2:.2f} mm")
print(f"  donen/sabit temas: {motor_clash_vol:.6f} mm^3")
print(f"yumusatilan     : {', '.join(softened) if softened else '-'}")
print(f"ATLANAN         : {', '.join(skipped) if skipped else '-'}")

export_step(fan, ROOT / "exports" / "fan_120_pro.step")
export_stl(fan, ROOT / "exports" / "fan_120_pro.stl",
           tolerance=0.005, angular_tolerance=0.08)
print("exports/fan_120_pro.step + .stl yazildi")

try:
    from ocp_vscode import show, Camera
    show(frame, rotor, pins, stator, coils, pcb, magnet, shaft,
         names=["govde", "pervane", "pinler", "stator", "sargilar",
                "surucu_karti", "miknatis", "mil"],
         reset_camera=Camera.RESET, deviation=0.002, angular_tolerance=0.1)
except Exception as exc:
    print(f"viewer yok ({type(exc).__name__}: {exc})")
