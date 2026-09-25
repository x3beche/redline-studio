// The unit table behind Units & Numbers: every quantity, every unit, and each
// unit's size in the quantity's SI unit. Pure data (no DOM), shared by
// tool.js (the arithmetic) and view.js (names and symbols for the page).
//
// Sources for the factors, all exact by definition unless the name says
// otherwise:
//   - BIPM, The International System of Units (SI Brochure), 9th ed. 2019:
//     SI units and prefixes; the elementary charge 1.602176634e-19 C, c.
//   - NIST SP 811 (2008), Guide for the Use of the SI, Appendix B (factors
//     for US customary, imperial, CGS and industry units).
//   - International yard and pound (1959): 1 in = 25.4 mm, 1 lb = 0.45359237 kg.
//   - CGPM 1901 / ISO 80000-3: standard gravity gn = 9.80665 m/s^2 (so
//     1 kgf = 9.80665 N and 1 lbf = 4.4482216152605 N).
//   - IEC 80000-13: kB = 1000 B, KiB = 1024 B (binary prefixes).
//   - ASTM B258 / NEMA: AWG n diameter = 0.005 in x 92^((36 - n) / 39).
//   - IEC 60050 / ITU-R V.574: dBm, dBW, dBV, dBu (0.775 V = sqrt(0.6) V).
//   - IACS 1913: 100 % IACS = 58 MS/m (1/58 ohm mm^2/m).
//
// A unit is [symbol, size, name, system, aliases, options]:
//   size     how many SI units one of it is (a number), or for an affine or
//            logarithmic unit {to(x, ctx) -> SI, from(si, ctx) -> x}
//   system   M metric/SI · U US customary & imperial · O other/industry · L log
//   aliases  '|'-separated; a leading ~ makes it a weak alias (used only
//            when nothing else reads the same)
//   options  pre: SI prefixes may go on the symbol (k, M, µ ...); lo: the
//            symbol itself is a weak alias; quiet: no "also means" note;
//            ctx: the size depends on a setting (volts, ohms, dpi)

export const PI = Math.PI;
export const IN = 0.0254, FT = 0.3048, YD = 0.9144, MI = 1609.344, NMI = 1852, MIL = IN / 1000;
export const LB = 0.45359237, OZ = LB / 16, GR = LB / 7000, GN = 9.80665;
export const LBF = LB * GN, OZF = LBF / 16;
export const USGAL = 231 * IN ** 3, UKGAL = 4.54609e-3;
export const BTU = 1055.05585262, CALTH = 4.184, CALIT = 4.1868;
export const HP = 550 * FT * LBF, ATM = 101325, QE = 1.602176634e-19, C0 = 299792458;
export const CMIL = (PI / 4) * MIL ** 2;
export const MMHG = 13.5951 * GN; // conventional: 13.5951 g/cm^3 mercury, 1 mm, gn

const log = (mult, ref) => ({
  log: mult,
  to: (x) => ref * 10 ** (x / mult),
  from: (b) => (b > 0 ? mult * Math.log10(b / ref) : b === 0 ? -Infinity : NaN),
});
// Snapped to zero within float noise, so 0 °C reads 32 °F and not 31.99999999999994.
const snap = (x, scale) => (Math.abs(x) < 1e-12 * scale ? 0 : x);
const affine = (f, off) => ({ affine: true, to: (x) => snap((x + off) * f, off * f), from: (k) => snap(k / f - off, off), f, off });

// AWG: d = 0.127 mm x 92^((36 - n) / 39); 4/0 is n = -3, 1/0 is n = 0.
export const awgDiameterMm = (n) => 0.127 * 92 ** ((36 - n) / 39);
export const awgFromDiameterMm = (d) => 36 - (39 * Math.log(d / 0.127)) / Math.log(92);
const AWG = {
  awg: true,
  to: (n) => (PI / 4) * (awgDiameterMm(n) * 1e-3) ** 2,
  from: (a) => (a > 0 ? awgFromDiameterMm(Math.sqrt((4 * a) / PI) * 1e3) : NaN),
};

export const SYSTEMS = { M: 'Metric & SI', U: 'US & imperial', O: 'Other & industry', L: 'Logarithmic' };

export const QUANTITIES = [
  // ---------------- space ----------------
  { id: 'length', name: 'Length', group: 'Space', si: 'm', ex: '1.6 mm', draw: 'ruler',
    notes: ['PCB copper: 1 oz/ft² is about 35 µm (1.37 mil) thick, a convention rather than an exact unit.'],
    units: [
      ['Å', 1e-10, 'ångström', 'M', 'angstrom|angstroms|Angstrom'],
      ['nm', 1e-9, 'nanometre', 'M', 'nanometer|nanometre|nanometers|nanometres'],
      ['µm', 1e-6, 'micrometre (micron)', 'M', 'um|μm|micron|microns|micrometer|micrometre|micrometers'],
      ['mm', 1e-3, 'millimetre', 'M', 'millimeter|millimetre|millimeters|millimetres'],
      ['cm', 1e-2, 'centimetre', 'M', 'centimeter|centimetre|centimeters|centimetres'],
      ['m', 1, 'metre', 'M', 'meter|metre|meters|metres', { pre: 1 }],
      ['km', 1e3, 'kilometre', 'M', 'kilometer|kilometre|kilometers|kilometres'],
      ['µin', IN * 1e-6, 'microinch', 'U', 'uin|μin|microinch|microinches'],
      ['mil', MIL, 'mil (thou, 0.001 in)', 'U', 'thou|thous|thousandth'],
      ['in', IN, 'inch', 'U', 'inch|inches|"|″|”'],
      ['ft', FT, 'foot', 'U', "foot|feet|'|′|’"],
      ['yd', YD, 'yard', 'U', 'yard|yards'],
      ['mi', MI, 'mile (statute)', 'U', 'mile|miles|statute mile'],
      ['fathom', 6 * FT, 'fathom (6 ft)', 'O', 'fathoms|ftm'],
      ['ftUS', 1200 / 3937, 'US survey foot', 'O', 'survey foot|us survey foot|ft(US)|survey ft'],
      ['nmi', NMI, 'nautical mile', 'O', 'NM|nautical mile|nautical miles'],
      ['au', 149597870700, 'astronomical unit', 'O', 'AU|astronomical unit'],
      ['ly', 9460730472580800, 'light-year (Julian year × c)', 'O', 'light year|light years|lightyear|light-year|light-years'],
    ] },
  { id: 'area', name: 'Area', group: 'Space', si: 'm²', ex: '24 AWG', awg: true,
    notes: ['AWG is a gauge number, not a size: its row gives the (fractional) gauge of a round wire of this area.',
      'A circular mil is the area of a 1 mil diameter circle (π/4 mil²); 1 kcmil (MCM) = 1000 cmil.'],
    units: [
      ['mm²', 1e-6, 'square millimetre', 'M', 'mm2|mm^2|sq mm|sqmm|square millimetre|square millimeter|square millimeters|square millimetres'],
      ['cm²', 1e-4, 'square centimetre', 'M', 'cm2|cm^2|sq cm|square centimetre|square centimeter'],
      ['m²', 1, 'square metre', 'M', 'm2|m^2|sq m|sqm|square metre|square meter|square metres|square meters'],
      ['ha', 1e4, 'hectare', 'M', 'hectare|hectares'],
      ['km²', 1e6, 'square kilometre', 'M', 'km2|km^2|sq km|square kilometre|square kilometer'],
      ['mil²', MIL ** 2, 'square mil', 'U', 'mil2|mil^2|sq mil|sq mils|square mil|square mils'],
      ['cmil', CMIL, 'circular mil', 'U', 'circular mil|circular mils|circ mil|CM'],
      ['kcmil', 1000 * CMIL, 'thousand circular mils (MCM)', 'U', 'MCM|kcm|mcm|thousand circular mils'],
      ['in²', IN ** 2, 'square inch', 'U', 'in2|in^2|sq in|sqin|square inch|square inches'],
      ['ft²', FT ** 2, 'square foot', 'U', 'ft2|ft^2|sq ft|sqft|square foot|square feet'],
      ['yd²', YD ** 2, 'square yard', 'U', 'yd2|yd^2|sq yd|square yard|square yards'],
      ['acre', 4046.8564224, 'acre (international)', 'U', 'acres|ac'],
      ['mi²', MI ** 2, 'square mile', 'U', 'mi2|mi^2|sq mi|square mile|square miles'],
      ['AWG', AWG, 'American Wire Gauge (round wire)', 'O', 'awg|gauge|ga|AWG#'],
    ] },
  { id: 'volume', name: 'Volume', group: 'Space', si: 'm³', ex: '1 gal',
    notes: ['Cup, pint, quart and gallon are US liquid measures unless marked UK (imperial).'],
    units: [
      ['mm³', 1e-9, 'cubic millimetre', 'M', 'mm3|mm^3|cu mm|cubic millimetre|cubic millimeter'],
      ['µL', 1e-9, 'microlitre', 'M', 'uL|μL|ul|µl|microliter|microlitre|microliters|microlitres'],
      ['mL', 1e-6, 'millilitre', 'M', 'ml|milliliter|millilitre|milliliters|millilitres'],
      ['cm³', 1e-6, 'cubic centimetre (cc)', 'M', 'cm3|cm^3|cc|ccm|cu cm|cubic centimetre|cubic centimeter'],
      ['L', 1e-3, 'litre', 'M', 'l|liter|litre|liters|litres|ltr', { pre: 1 }],
      ['m³', 1, 'cubic metre', 'M', 'm3|m^3|cu m|cubic metre|cubic meter|cubic metres|cubic meters'],
      ['tsp', USGAL / 768, 'teaspoon (US)', 'U', 'teaspoon|teaspoons'],
      ['tbsp', USGAL / 256, 'tablespoon (US)', 'U', 'tablespoon|tablespoons|Tbsp|tbs'],
      ['fl oz', USGAL / 128, 'fluid ounce (US)', 'U', 'floz|fl.oz|fl. oz|fluid ounce|fluid ounces|US fl oz|oz fl'],
      ['cup', USGAL / 16, 'cup (US customary)', 'U', 'cups|US cup'],
      ['pint', USGAL / 8, 'pint (US liquid)', 'U', 'pints|US pint|US pt|~pt'],
      ['qt', USGAL / 4, 'quart (US liquid)', 'U', 'quart|quarts|US qt'],
      ['gal', USGAL, 'gallon (US)', 'U', 'gallon|gallons|US gal|usgal|US gallon'],
      ['in³', IN ** 3, 'cubic inch', 'U', 'in3|in^3|cu in|cubic inch|cubic inches|cid'],
      ['ft³', FT ** 3, 'cubic foot', 'U', 'ft3|ft^3|cu ft|cubic foot|cubic feet'],
      ['yd³', YD ** 3, 'cubic yard', 'U', 'yd3|yd^3|cu yd|cubic yard|cubic yards'],
      ['UK fl oz', UKGAL / 160, 'fluid ounce (imperial)', 'U', 'imp fl oz|UK floz|imperial fluid ounce'],
      ['UK pint', UKGAL / 8, 'pint (imperial)', 'U', 'imp pint|imperial pint|UK pt'],
      ['UK gal', UKGAL, 'gallon (imperial)', 'U', 'imp gal|imperial gallon|imperial gallons|UKgal'],
      ['bbl', 42 * USGAL, 'barrel (oil, 42 US gal)', 'O', 'barrel|barrels|oil barrel'],
    ] },
  { id: 'angle', name: 'Angle', group: 'Space', si: 'rad', ex: '45°', draw: 'dial',
    notes: ['Degrees-minutes-seconds read too: 12°30\'15" .'],
    units: [
      ['µrad', 1e-6, 'microradian', 'M', 'urad|μrad'],
      ['mrad', 1e-3, 'milliradian', 'M', 'milliradian|milliradians'],
      ['rad', 1, 'radian', 'M', 'radian|radians', { pre: 1 }],
      ['arcsec', PI / 648000, 'second of arc', 'O', '″|asec|arcsecond|arcseconds'],
      ['arcmin', PI / 10800, 'minute of arc', 'O', '′|amin|arcminute|arcminutes|MOA|moa'],
      ['°', PI / 180, 'degree', 'M', 'deg|degree|degrees|º|degs'],
      ['gon', PI / 200, 'gradian (gon)', 'O', 'grad|grads|gradian|gradians|grade'],
      ['NATO mil', (2 * PI) / 6400, 'NATO mil (1/6400 turn)', 'O', 'nato mil|mil (NATO)|mils (NATO)'],
      ['turn', 2 * PI, 'turn (revolution)', 'O', 'turns|rev|revs|revolution|revolutions|cycle|cycles'],
    ] },
  { id: 'screen', name: 'Screen & type', group: 'Space', si: 'in', ex: '12 pt',
    notes: ['A CSS px is 1/96 in by definition, but a screen shows it at whatever size its density gives; px @ dpi is a device pixel at the set density.',
      'dp (Android) is 1 px at 160 dpi. An em is the element\'s font size (16 CSS px by browser default), so it is not listed.'],
    units: [
      ['px', 1 / 96, 'CSS pixel (1/96 in)', 'O', 'CSS px|css px|pixel|pixels'],
      ['px@dpi', { ctx: 'dpi', to: (x, c) => x / c.dpi, from: (b, c) => b * c.dpi }, 'device pixel at the set dpi', 'O', 'device px|dev px|device pixel|device pixels'],
      ['dp', 1 / 160, 'Android dp (1 px at 160 dpi)', 'O', 'dip|dips|density-independent pixel'],
      ['pt', 1 / 72, 'point (PostScript / DTP, 1/72 in)', 'O', 'point|points|pts'],
      ['pc', 1 / 6, 'pica (12 pt)', 'O', 'pica|picas'],
      ['twip', 1 / 1440, 'twip (1/20 pt)', 'O', 'twips'],
      ['Q', 1 / 101.6, 'Q (quarter millimetre)', 'O', 'quarter mm|quarter-millimetre'],
      ['mm', 1 / 25.4, 'millimetre', 'M', '', { lo: 1, quiet: 1 }],
      ['in', 1, 'inch', 'U', '', { lo: 1, quiet: 1 }],
    ] },

  // ---------------- mechanics ----------------
  { id: 'mass', name: 'Mass', group: 'Mechanics', si: 'kg', ex: '1 lb',
    notes: ['Ounce and pound are avoirdupois; a "ton" alone is read as the US short ton.'],
    units: [
      ['µg', 1e-9, 'microgram', 'M', 'ug|μg|mcg|microgram|micrograms'],
      ['mg', 1e-6, 'milligram', 'M', 'milligram|milligrams'],
      ['g', 1e-3, 'gram', 'M', 'gram|grams|gm|gms', { pre: 1 }],
      ['kg', 1, 'kilogram', 'M', 'kilo|kilos|kilogram|kilograms|kgs'],
      ['t', 1000, 'tonne (metric ton)', 'M', 'tonne|tonnes|metric ton|metric tons'],
      ['ct', 2e-4, 'carat (metric)', 'O', 'carat|carats'],
      ['gr', GR, 'grain', 'U', 'grain|grains'],
      ['oz', OZ, 'ounce (avoirdupois)', 'U', 'ounce|ounces|oz av'],
      ['ozt', 31.1034768e-3, 'troy ounce', 'O', 'troy ounce|troy ounces|oz t|oz troy'],
      ['lb', LB, 'pound (avoirdupois)', 'U', 'lbs|pound|pounds|lbm'],
      ['st', 14 * LB, 'stone (14 lb)', 'U', 'stone|stones'],
      ['slug', LBF / FT, 'slug (lbf·s²/ft)', 'U', 'slugs'],
      ['short ton', 2000 * LB, 'short ton (US, 2000 lb)', 'U', 'ton|tons|US ton|US tons|tn'],
      ['long ton', 2240 * LB, 'long ton (UK, 2240 lb)', 'U', 'UK ton|UK tons|imperial ton'],
    ] },
  { id: 'density', name: 'Density', group: 'Mechanics', si: 'kg/m³', ex: '7.85 g/cm³',
    units: [
      ['mg/L', 1e-3, 'milligram per litre', 'M', 'mg/l|mg/dm³'],
      ['kg/m³', 1, 'kilogram per cubic metre (= g/L)', 'M', 'kg/m3|kg/m^3|g/L|g/l|g/dm³|g/dm3'],
      ['g/cm³', 1000, 'gram per cm³ (= g/mL = kg/L = t/m³)', 'M', 'g/cm3|g/cm^3|g/cc|g/mL|g/ml|kg/L|kg/l|kg/dm³|kg/dm3|t/m³|t/m3'],
      ['oz/in³', OZ / IN ** 3, 'ounce per cubic inch', 'U', 'oz/in3|oz/cu in'],
      ['lb/in³', LB / IN ** 3, 'pound per cubic inch', 'U', 'lb/in3|lb/cu in|pci'],
      ['lb/ft³', LB / FT ** 3, 'pound per cubic foot', 'U', 'lb/ft3|lb/cu ft|pcf'],
      ['lb/gal', LB / USGAL, 'pound per US gallon', 'U', 'ppg|lb/US gal|lbs/gal'],
    ] },
  { id: 'force', name: 'Force', group: 'Mechanics', si: 'N', ex: '10 lbf',
    notes: ['kgf, gf and lbf use standard gravity gn = 9.80665 m/s² (exact).'],
    units: [
      ['dyn', 1e-5, 'dyne', 'M', 'dyne|dynes'],
      ['mN', 1e-3, 'millinewton', 'M', 'millinewton|millinewtons'],
      ['gf', GN / 1000, 'gram-force', 'M', 'gram-force|gram force|grams-force|gF'],
      ['N', 1, 'newton', 'M', 'newton|newtons', { pre: 1 }],
      ['kgf', GN, 'kilogram-force (kilopond)', 'M', 'kp|kilopond|kg-force|kgF|kilogram-force|kilogram force'],
      ['kN', 1e3, 'kilonewton', 'M', 'kilonewton|kilonewtons'],
      ['tf', 1000 * GN, 'tonne-force', 'M', 'tonne-force|tonf(metric)'],
      ['MN', 1e6, 'meganewton', 'M', ''],
      ['ozf', OZF, 'ounce-force', 'U', 'oz-force|ounce-force|ozF'],
      ['pdl', LB * FT, 'poundal (lb·ft/s²)', 'U', 'poundal|poundals'],
      ['lbf', LBF, 'pound-force', 'U', 'lb-force|pound-force|pounds-force|lbF|lbs force|pound force'],
      ['kip', 1000 * LBF, 'kip (1000 lbf)', 'U', 'kips|klbf'],
    ] },
  { id: 'torque', name: 'Torque', group: 'Mechanics', si: 'N·m', ex: '1 N·m',
    units: [
      ['dyn·cm', 1e-7, 'dyne centimetre', 'M', 'dyncm|dyne-cm'],
      ['gf·cm', GN * 1e-5, 'gram-force centimetre', 'M', 'gfcm|g-cm|g·cm|gcm|gf-cm|gram-cm'],
      ['N·mm', 1e-3, 'newton millimetre', 'M', 'Nmm|N-mm|N.mm'],
      ['mN·m', 1e-3, 'millinewton metre', 'M', 'mNm|mN-m|mN.m'],
      ['N·cm', 1e-2, 'newton centimetre', 'M', 'Ncm|N-cm|N.cm'],
      ['kgf·cm', GN * 1e-2, 'kilogram-force centimetre', 'M', 'kgfcm|kg-cm|kg·cm|kgcm|kgf-cm|kgf.cm|kp·cm'],
      ['N·m', 1, 'newton metre', 'M', 'Nm|N-m|N.m|newton metre|newton meter|newton metres|newton meters'],
      ['kgf·m', GN, 'kilogram-force metre', 'M', 'kgfm|kg-m|kg·m|kgm|kgf-m|kp·m'],
      ['kN·m', 1e3, 'kilonewton metre', 'M', 'kNm|kN-m'],
      ['ozf·in', OZF * IN, 'ounce-force inch', 'U', 'oz-in|ozin|oz·in|ozf-in|in-oz|in·oz|ozfin'],
      ['lbf·in', LBF * IN, 'pound-force inch', 'U', 'lb-in|lbin|lb·in|in-lb|in·lb|inlb|in-lbf|lbf-in|in-lbs|lbfin'],
      ['lbf·ft', LBF * FT, 'pound-force foot', 'U', 'lb-ft|lbft|lb·ft|ft-lb|ft·lb|ftlb|ft-lbf|lbf-ft|ft-lbs|ft·lbf'],
    ] },
  { id: 'pressure', name: 'Pressure & stress', group: 'Mechanics', si: 'Pa', ex: '25 psi', draw: 'log',
    notes: ['Gauge and absolute (psig, psia, barg) are not told apart: the number is converted as it is.',
      'mmHg, inHg and the water columns are the conventional ones (13.5951 g/cm³ mercury, 1 g/cm³ water, gn).'],
    units: [
      ['Pa', 1, 'pascal (N/m²)', 'M', 'pascal|pascals|N/m²|N/m2', { pre: 1 }],
      ['dyn/cm²', 0.1, 'barye (dyn/cm²)', 'M', 'barye|dyn/cm2|Ba'],
      ['hPa', 100, 'hectopascal', 'M', 'hectopascal|hectopascals'],
      ['mbar', 100, 'millibar', 'M', 'mb|millibar|millibars'],
      ['kPa', 1e3, 'kilopascal', 'M', 'kpa|kilopascal|kilopascals|KPa'],
      ['bar', 1e5, 'bar', 'M', 'bars|barg|bara', { pre: 1 }],
      ['at', 98066.5, 'technical atmosphere (kgf/cm²)', 'M', 'kgf/cm²|kgf/cm2|kg/cm²|kg/cm2|ata|kp/cm²|kp/cm2|kgf/cm^2'],
      ['MPa', 1e6, 'megapascal (N/mm²)', 'M', 'mpa|megapascal|megapascals|N/mm²|N/mm2|N/mm^2'],
      ['kgf/mm²', GN * 1e6, 'kilogram-force per mm²', 'M', 'kgf/mm2|kg/mm2|kg/mm²'],
      ['GPa', 1e9, 'gigapascal', 'M', 'gpa|gigapascal|gigapascals'],
      ['mmH₂O', GN, 'millimetre of water (conventional)', 'O', 'mmH2O|mm H2O|mmwc|mmWC|mmAq|mm wc'],
      ['cmH₂O', GN * 10, 'centimetre of water (conventional)', 'O', 'cmH2O|cm H2O|cmwc'],
      ['mTorr', ATM / 760e3, 'millitorr', 'O', 'mtorr|millitorr|micron Hg|µmHg|umHg'],
      ['Torr', ATM / 760, 'torr (1/760 atm)', 'O', 'torr'],
      ['mmHg', MMHG, 'millimetre of mercury (conventional)', 'O', 'mm Hg|mmhg'],
      ['atm', ATM, 'standard atmosphere', 'O', 'atmosphere|atmospheres'],
      ['psf', LBF / FT ** 2, 'pound-force per square foot', 'U', 'lbf/ft²|lbf/ft2|lb/ft²|lb/ft2'],
      ['inH₂O', GN * 25.4, 'inch of water (conventional)', 'U', 'inH2O|in H2O|inWC|in wc|iwc|"WC|″WC|"H2O'],
      ['inHg', MMHG * 25.4, 'inch of mercury (conventional)', 'U', 'in Hg|inhg|"Hg'],
      ['psi', LBF / IN ** 2, 'pound-force per square inch', 'U', 'PSI|psig|psia|lbf/in²|lbf/in2|lb/in²|lb/in2|lbf/in^2|lb/in^2'],
      ['ksi', 1000 * LBF / IN ** 2, 'kilopound-force per square inch', 'U', 'KSI|kpsi'],
    ] },
  { id: 'spring', name: 'Stiffness (spring rate)', group: 'Mechanics', si: 'N/m', ex: '10 N/mm',
    units: [
      ['N/m', 1, 'newton per metre', 'M', 'N/M'],
      ['N/cm', 100, 'newton per centimetre', 'M', ''],
      ['kgf/m', GN, 'kilogram-force per metre', 'M', 'kg/m?'],
      ['N/mm', 1e3, 'newton per millimetre (= kN/m)', 'M', 'kN/m'],
      ['kgf/cm', GN * 100, 'kilogram-force per centimetre', 'M', ''],
      ['kgf/mm', GN * 1e3, 'kilogram-force per millimetre', 'M', 'kg/mm'],
      ['lbf/ft', LBF / FT, 'pound-force per foot', 'U', 'lb/ft'],
      ['lbf/in', LBF / IN, 'pound-force per inch', 'U', 'lb/in|lbs/in'],
    ] },
  { id: 'energy', name: 'Energy & work', group: 'Mechanics', si: 'J', ex: '1 kWh', draw: 'log',
    notes: ['cal is the thermochemical calorie (4.184 J); kcal the food Calorie. BTU is the International Table BTU.',
      'mAh @ V and Ah @ V are a battery\'s charge times the set voltage.'],
    units: [
      ['eV', QE, 'electronvolt', 'O', 'ev|electronvolt|electronvolts', { pre: 1 }],
      ['erg', 1e-7, 'erg', 'M', 'ergs'],
      ['µJ', 1e-6, 'microjoule', 'M', 'uJ|μJ'],
      ['mJ', 1e-3, 'millijoule', 'M', 'millijoule|millijoules'],
      ['J', 1, 'joule (W·s)', 'M', 'joule|joules|W·s|Ws|W-s|Wsec', { pre: 1 }],
      ['mWh', 3.6, 'milliwatt-hour', 'M', 'mW·h|mwh'],
      ['cal', CALTH, 'calorie (thermochemical)', 'M', 'calorie|calories|cal_th|calth'],
      ['cal(IT)', CALIT, 'calorie (International Table)', 'O', 'calIT|cal_IT|cal it'],
      ['kJ', 1e3, 'kilojoule', 'M', 'kilojoule|kilojoules'],
      ['Wh', 3600, 'watt-hour', 'M', 'W·h|W-h|watt hour|watt-hour|watt hours|Whr', { pre: 1 }],
      ['kcal', CALTH * 1000, 'kilocalorie (food Calorie)', 'M', 'Cal|kilocalorie|kilocalories|Calorie|Calories'],
      ['MJ', 1e6, 'megajoule', 'M', 'megajoule|megajoules'],
      ['kWh', 3.6e6, 'kilowatt-hour', 'M', 'kW·h|kwh|KWH|kWhr|kW-h|kilowatt hour|kilowatt-hour|kilowatt hours'],
      ['MWh', 3.6e9, 'megawatt-hour', 'M', 'MW·h|mwh?'],
      ['ft·lbf', LBF * FT, 'foot pound-force', 'U', 'ft-lbf|ft·lbf|~ft-lb|~ft·lb|~ftlb|~lbf·ft'],
      ['BTU', BTU, 'British thermal unit (IT)', 'U', 'Btu|btu|BTU(IT)|Btu_IT'],
      ['hp·h', HP * 3600, 'horsepower-hour (mechanical)', 'U', 'hph|hp-h|hp·hr|hp-hr'],
      ['therm', 1e5 * BTU, 'therm (EC, 100 000 BTU)', 'U', 'therms|thm'],
      ['mAh@V', { ctx: 'volts', to: (x, c) => x * 3.6 * c.volts, from: (b, c) => b / (3.6 * c.volts) }, 'milliampere-hour at the set voltage', 'O', '~mAh|mAh @ V'],
      ['Ah@V', { ctx: 'volts', to: (x, c) => x * 3600 * c.volts, from: (b, c) => b / (3600 * c.volts) }, 'ampere-hour at the set voltage', 'O', '~Ah|Ah @ V'],
    ] },
  { id: 'power', name: 'Power', group: 'Mechanics', si: 'W', ex: '0 dBm', draw: 'log',
    notes: ['dBm and dBW are power levels: 0 dBm = 1 mW, 0 dBW = 1 W. The voltage and current rows assume a resistive load of the set impedance.',
      'hp is the mechanical (imperial) horsepower, 550 ft·lbf/s; PS is the metric one (75 kgf·m/s).'],
    units: [
      ['nW', 1e-9, 'nanowatt', 'M', 'nw'],
      ['µW', 1e-6, 'microwatt', 'M', 'uW|μW|uw'],
      ['mW', 1e-3, 'milliwatt', 'M', 'mw|milliwatt|milliwatts'],
      ['W', 1, 'watt (J/s)', 'M', 'watt|watts|J/s|VA?', { pre: 1 }],
      ['kcal/h', (CALTH * 1000) / 3600, 'kilocalorie per hour', 'M', 'kcal/hr'],
      ['kW', 1e3, 'kilowatt', 'M', 'kw|KW|kilowatt|kilowatts'],
      ['MW', 1e6, 'megawatt', 'M', 'megawatt|megawatts'],
      ['BTU/h', BTU / 3600, 'BTU (IT) per hour', 'U', 'Btu/h|BTU/hr|Btu/hr|btuh|BTUH|btu/h'],
      ['ft·lbf/s', LBF * FT, 'foot pound-force per second', 'U', 'ft-lbf/s|ft·lb/s|ft-lb/s'],
      ['PS', 75 * GN, 'metric horsepower (PS, CV, ch)', 'M', 'metric hp|hp(M)|CV|cv|ch|pk|mhp'],
      ['hp', HP, 'horsepower (mechanical, 550 ft·lbf/s)', 'U', 'HP|bhp|hp(I)|horsepower|shp'],
      ['hp(E)', 746, 'horsepower (electric)', 'U', 'hpE|electric hp|electrical horsepower'],
      ['TR', (12000 * BTU) / 3600, 'ton of refrigeration (12 000 BTU/h)', 'U', 'RT|ton of refrigeration|tons of refrigeration|~ton|~tons'],
      ['dBm', log(10, 1e-3), 'decibel-milliwatt', 'L', 'dbm|DBM|dBmW'],
      ['dBW', log(10, 1), 'decibel-watt', 'L', 'dbw|DBW'],
      ['dBµW', log(10, 1e-6), 'decibel-microwatt', 'L', 'dBuW|dbuw'],
    ] },
  { id: 'speed', name: 'Speed', group: 'Mechanics', si: 'm/s', ex: '60 mph',
    units: [
      ['mm/s', 1e-3, 'millimetre per second', 'M', 'mm/sec'],
      ['m/min', 1 / 60, 'metre per minute', 'M', 'mpm|m/mn'],
      ['km/h', 1 / 3.6, 'kilometre per hour', 'M', 'kmh|kph|km/hr|kmph|kilometers per hour|kilometres per hour'],
      ['m/s', 1, 'metre per second', 'M', 'mps|m/sec|meters per second|metres per second'],
      ['in/s', IN, 'inch per second', 'U', 'ips|in/sec'],
      ['ft/min', FT / 60, 'foot per minute', 'U', 'fpm|ft/mn'],
      ['ft/s', FT, 'foot per second', 'U', 'fps|ft/sec'],
      ['mph', MI / 3600, 'mile per hour', 'U', 'mi/h|MPH|miles per hour'],
      ['kn', NMI / 3600, 'knot', 'O', 'kt|kts|knot|knots'],
      ['c', C0, 'speed of light in vacuum', 'O', 'speed of light'],
    ] },
  { id: 'accel', name: 'Acceleration', group: 'Mechanics', si: 'm/s²', ex: '1 gn',
    notes: ['gn is standard gravity, 9.80665 m/s² exactly; write gn (or g-force) for it, since g alone is a gram.'],
    units: [
      ['mm/s²', 1e-3, 'millimetre per second squared', 'M', 'mm/s2|mm/s^2'],
      ['Gal', 0.01, 'gal (cm/s²)', 'M', 'cm/s²|cm/s2|cm/s^2|galileo'],
      ['m/s²', 1, 'metre per second squared', 'M', 'm/s2|m/s^2|mps2|m/sec2|m/sec²'],
      ['gn', GN, 'standard gravity (g-force)', 'O', 'gₙ|g0|g₀|g-force|G-force|gee|~g|~G'],
      ['in/s²', IN, 'inch per second squared', 'U', 'in/s2|in/s^2|ips2'],
      ['ft/s²', FT, 'foot per second squared', 'U', 'ft/s2|ft/s^2|fps2'],
    ] },
  { id: 'flow', name: 'Flow (volume)', group: 'Mechanics', si: 'm³/s', ex: '10 L/min',
    notes: ['sccm and slm are gas flows at standard conditions: read here as mL/min and L/min at those conditions.',
      'GPM is US gallons unless marked UK.'],
    units: [
      ['mL/min', 1e-6 / 60, 'millilitre per minute', 'M', 'ml/min|cc/min|ccm/min|~sccm'],
      ['mL/s', 1e-6, 'millilitre per second', 'M', 'ml/s|cc/s'],
      ['L/h', 1e-3 / 3600, 'litre per hour', 'M', 'l/h|LPH|lph|l/hr|L/hr'],
      ['L/min', 1e-3 / 60, 'litre per minute', 'M', 'l/min|lpm|LPM|~slm|~slpm'],
      ['L/s', 1e-3, 'litre per second', 'M', 'l/s|lps|LPS'],
      ['m³/h', 1 / 3600, 'cubic metre per hour', 'M', 'm3/h|m3/hr|m³/hr|cmh|CMH'],
      ['m³/min', 1 / 60, 'cubic metre per minute', 'M', 'm3/min'],
      ['m³/s', 1, 'cubic metre per second', 'M', 'm3/s|cumec'],
      ['gal/h', USGAL / 3600, 'US gallon per hour', 'U', 'gph|GPH'],
      ['GPM', USGAL / 60, 'US gallon per minute', 'U', 'gpm|gal/min|US gpm|USgpm'],
      ['UK GPM', UKGAL / 60, 'imperial gallon per minute', 'U', 'imp gpm|igpm|IGPM'],
      ['CFH', FT ** 3 / 3600, 'cubic foot per hour', 'U', 'cfh|ft³/h|ft3/h|scfh'],
      ['CFM', FT ** 3 / 60, 'cubic foot per minute', 'U', 'cfm|ft³/min|ft3/min|cu ft/min|~scfm'],
      ['ft³/s', FT ** 3, 'cubic foot per second', 'U', 'cfs|ft3/s'],
      ['bbl/d', (42 * USGAL) / 86400, 'oil barrel per day', 'O', 'bpd|BPD|bbl/day'],
    ] },
  { id: 'viscosity', name: 'Viscosity (dynamic)', group: 'Mechanics', si: 'Pa·s', ex: '1 cP',
    units: [
      ['µPa·s', 1e-6, 'micropascal second', 'M', 'uPa·s|µPas|uPas|uPa.s'],
      ['mPa·s', 1e-3, 'millipascal second', 'M', 'mPas|mPa.s|mPa s|mPa-s'],
      ['cP', 1e-3, 'centipoise', 'M', 'centipoise|cPs|cps?'],
      ['P', 0.1, 'poise', 'M', 'poise'],
      ['Pa·s', 1, 'pascal second', 'M', 'Pas|Pa.s|Pa s|Pa-s|N·s/m²|N s/m2|kg/(m·s)'],
      ['lb/(ft·s)', LB / FT, 'pound per foot second', 'U', 'lb/ft·s|lbm/(ft·s)|lb/ft/s|lb/(ft s)'],
      ['reyn', LBF / IN ** 2, 'reyn (lbf·s/in²)', 'U', 'lbf·s/in²|lbf s/in2|psi·s|psi s|reyns'],
    ] },
  { id: 'kviscosity', name: 'Viscosity (kinematic)', group: 'Mechanics', si: 'm²/s', ex: '46 cSt',
    units: [
      ['mm²/s', 1e-6, 'square millimetre per second', 'M', 'mm2/s|mm^2/s'],
      ['cSt', 1e-6, 'centistokes', 'M', 'cst|centistokes|centistoke'],
      ['St', 1e-4, 'stokes', 'M', 'stokes|stoke'],
      ['m²/s', 1, 'square metre per second', 'M', 'm2/s|m^2/s'],
      ['in²/s', IN ** 2, 'square inch per second', 'U', 'in2/s|in^2/s'],
      ['ft²/s', FT ** 2, 'square foot per second', 'U', 'ft2/s|ft^2/s'],
    ] },

  // ---------------- time ----------------
  { id: 'time', name: 'Time', group: 'Time & frequency', si: 's', ex: '1 day', draw: 'log',
    notes: ['A year here is the Julian year, 365.25 days; a month is a twelfth of it.'],
    units: [
      ['ps', 1e-12, 'picosecond', 'M', 'picosecond|picoseconds'],
      ['ns', 1e-9, 'nanosecond', 'M', 'nanosecond|nanoseconds|nsec'],
      ['µs', 1e-6, 'microsecond', 'M', 'us|μs|usec|µsec|microsecond|microseconds'],
      ['ms', 1e-3, 'millisecond', 'M', 'msec|millisecond|milliseconds'],
      ['s', 1, 'second', 'M', 'sec|secs|second|seconds', { pre: 1 }],
      ['min', 60, 'minute', 'M', 'mins|minute|minutes|mn'],
      ['h', 3600, 'hour', 'M', 'hr|hrs|hour|hours'],
      ['d', 86400, 'day', 'M', 'day|days'],
      ['wk', 604800, 'week', 'O', 'week|weeks'],
      ['mo', 2629800, 'month (1/12 Julian year)', 'O', 'month|months'],
      ['yr', 31557600, 'year (Julian, 365.25 d)', 'O', 'year|years|yrs'],
    ] },
  { id: 'frequency', name: 'Frequency & rotation', group: 'Time & frequency', si: 'Hz', ex: '3000 rpm', draw: 'log',
    notes: ['rad/s is angular frequency ω = 2π f; rpm counts revolutions (1 rpm = 1/60 Hz).'],
    units: [
      ['mHz', 1e-3, 'millihertz', 'M', ''],
      ['rpm', 1 / 60, 'revolution per minute', 'O', 'RPM|r/min|rev/min|1/min|cpm'],
      ['deg/s', 1 / 360, 'degree per second', 'O', '°/s|dps'],
      ['rad/s', 1 / (2 * PI), 'radian per second (ω)', 'O', 'rad/sec|rads/s'],
      ['Hz', 1, 'hertz', 'M', 'hz|HZ|hertz|cps|1/s|rps|rev/s|r/s', { pre: 1 }],
      ['kHz', 1e3, 'kilohertz', 'M', 'khz|KHz|KHZ|kilohertz'],
      ['MHz', 1e6, 'megahertz', 'M', 'mhz|Mhz|MHZ|megahertz'],
      ['GHz', 1e9, 'gigahertz', 'M', 'ghz|Ghz|GHZ|gigahertz'],
      ['THz', 1e12, 'terahertz', 'M', 'thz|terahertz'],
    ] },

  // ---------------- thermal ----------------
  { id: 'temperature', name: 'Temperature', group: 'Thermal', si: 'K', ex: '25 °C', draw: 'thermo',
    notes: ['These are temperatures (points on a scale). For a difference, such as a rise of 10 °C, write Δ10 °C: then 1 K = 1 °C = 1.8 °F.'],
    units: [
      ['K', affine(1, 0), 'kelvin', 'M', 'kelvin|kelvins|°K|degK|deg K'],
      ['°C', affine(1, 273.15), 'degree Celsius', 'M', 'C|degC|deg C|celsius|centigrade|℃|oC|ºC|Celsius'],
      ['°F', affine(5 / 9, 459.67), 'degree Fahrenheit', 'U', 'F|degF|deg F|fahrenheit|℉|oF|ºF|Fahrenheit'],
      ['°R', affine(5 / 9, 0), 'degree Rankine', 'U', '~R|degR|deg R|rankine|°Ra|Rankine'],
    ] },
  { id: 'dtemp', name: 'Temperature difference', group: 'Thermal', si: 'K', ex: 'Δ10 °C',
    notes: ['A difference (a rise, a tolerance, a gradient): 1 K = 1 °C = 1.8 °F = 1.8 °R, with no offset.'],
    units: [
      ['mK', 1e-3, 'millikelvin (difference)', 'M', 'ΔmK'],
      ['ΔK', 1, 'kelvin (difference)', 'M', 'K (diff)'],
      ['Δ°C', 1, 'degree Celsius (difference)', 'M', 'ΔC|ΔdegC|Δ℃|°C (diff)'],
      ['Δ°F', 5 / 9, 'degree Fahrenheit (difference)', 'U', 'ΔF|ΔdegF|Δ℉|°F (diff)'],
      ['Δ°R', 5 / 9, 'degree Rankine (difference)', 'U', 'ΔR|ΔdegR|°R (diff)'],
    ] },
  { id: 'thermres', name: 'Thermal resistance', group: 'Thermal', si: 'K/W', ex: '40 °C/W',
    notes: ['Per watt of heat through the part (θJA, θJC, a heatsink). K/W and °C/W are the same number.'],
    units: [
      ['K/kW', 1e-3, 'kelvin per kilowatt', 'M', ''],
      ['K/W', 1, 'kelvin per watt', 'M', 'K/w'],
      ['°C/W', 1, 'degree Celsius per watt', 'M', 'C/W|degC/W|℃/W|°C/w'],
      ['°F/W', 5 / 9, 'degree Fahrenheit per watt', 'U', 'F/W|degF/W'],
      ['°F·h/BTU', (5 / 9) / (BTU / 3600), 'degree Fahrenheit hour per BTU', 'U', 'F·h/Btu|°F·hr/BTU|F-hr/BTU|h·°F/Btu|°F·h/Btu'],
    ] },
  { id: 'thermcond', name: 'Thermal conductivity', group: 'Thermal', si: 'W/(m·K)', ex: '1 W/(m·K)',
    units: [
      ['mW/(m·K)', 1e-3, 'milliwatt per metre kelvin', 'M', 'mW/mK|mW/m·K'],
      ['W/(m·K)', 1, 'watt per metre kelvin', 'M', 'W/mK|W/m·K|W/(m K)|W/m-K|W/m/K|W/(m·°C)|W/m°C|W/mC|W/m.K'],
      ['W/(cm·K)', 100, 'watt per centimetre kelvin', 'M', 'W/cmK|W/cm·K|W/cm-K|W/(cm·°C)'],
      ['cal/(s·cm·K)', 418.4, 'calorie per second centimetre kelvin', 'O', 'cal/s·cm·K|cal/(s cm °C)|cal/s/cm/K|cal/(cm·s·°C)|cal/(s·cm·°C)'],
      ['BTU·in/(h·ft²·°F)', (BTU / 3600) * IN / (FT ** 2 * (5 / 9)), 'BTU inch per hour square foot °F', 'U', 'Btu·in/(h·ft²·°F)|BTU-in/hr-ft2-F|Btu in/h ft2 F|BTU·in/hr·ft²·°F'],
      ['BTU/(h·ft·°F)', (BTU / 3600) / (FT * (5 / 9)), 'BTU per hour foot °F', 'U', 'BTU/hr·ft·°F|Btu/(h ft F)|BTU/h-ft-F|Btu/hr-ft-F|Btu/(h·ft·°F)'],
    ] },

  // ---------------- electrical ----------------
  { id: 'voltage', name: 'Voltage', group: 'Electrical', si: 'V', ex: '3.3 V', draw: 'log',
    notes: ['dBV, dBu, dBmV and dBµV read the voltage as rms: 0 dBu = √0.6 V ≈ 0.775 V (1 mW into 600 Ω).'],
    units: [
      ['nV', 1e-9, 'nanovolt', 'M', 'nv'],
      ['µV', 1e-6, 'microvolt', 'M', 'uV|μV|uv|microvolt|microvolts'],
      ['mV', 1e-3, 'millivolt', 'M', 'mv|millivolt|millivolts'],
      ['V', 1, 'volt', 'M', 'volt|volts|v|Vdc|VDC|Vac|VAC|Vrms', { pre: 1 }],
      ['kV', 1e3, 'kilovolt', 'M', 'kv|KV|kilovolt|kilovolts'],
      ['MV', 1e6, 'megavolt', 'M', ''],
      ['dBµV', log(20, 1e-6), 'decibel-microvolt', 'L', 'dBuV|dbuv|dBμV'],
      ['dBmV', log(20, 1e-3), 'decibel-millivolt', 'L', 'dbmv|dBmv'],
      ['dBu', log(20, Math.sqrt(0.6)), 'dBu (0 dBu = 0.7746 V rms)', 'L', 'dbu|dBv'],
      ['dBV', log(20, 1), 'decibel-volt (0 dBV = 1 V rms)', 'L', 'dbV|DBV'],
    ] },
  { id: 'current', name: 'Current', group: 'Electrical', si: 'A', ex: '20 mA', draw: 'log',
    units: [
      ['pA', 1e-12, 'picoampere', 'M', 'pa?'],
      ['nA', 1e-9, 'nanoampere', 'M', 'na?'],
      ['µA', 1e-6, 'microampere', 'M', 'uA|μA|ua|microamp|microamps'],
      ['mA', 1e-3, 'milliampere', 'M', 'ma|milliamp|milliamps|milliampere|milliamperes'],
      ['A', 1, 'ampere', 'M', 'amp|amps|ampere|amperes|Adc|Arms', { pre: 1 }],
      ['abA', 10, 'abampere (biot, CGS)', 'O', 'biot|abampere'],
      ['kA', 1e3, 'kiloampere', 'M', 'ka?|kiloamp'],
      ['dBµA', log(20, 1e-6), 'decibel-microampere', 'L', 'dBuA|dbua'],
    ] },
  { id: 'resistance', name: 'Resistance', group: 'Electrical', si: 'Ω', ex: '4k7 Ω', draw: 'log',
    notes: ['4k7 and 4R7 read the resistor way: 4.7 kΩ and 4.7 Ω.'],
    units: [
      ['µΩ', 1e-6, 'micro-ohm', 'M', 'uohm|uΩ|µohm|micro ohm|microohm|microohms'],
      ['mΩ', 1e-3, 'milliohm', 'M', 'mohm|mOhm|milliohm|milliohms|mR'],
      ['Ω', 1, 'ohm', 'M', 'ohm|ohms|Ohm|Ohms|R|OHM', { pre: 1 }],
      ['kΩ', 1e3, 'kilohm', 'M', 'kohm|kOhm|kohms|kilohm|kilohms|kiloohm|KOhm|Kohm|kR'],
      ['MΩ', 1e6, 'megohm', 'M', 'Mohm|MOhm|megohm|megohms|meg|MEG'],
      ['GΩ', 1e9, 'gigohm', 'M', 'Gohm|gigohm|gigaohm'],
    ] },
  { id: 'conductance', name: 'Conductance', group: 'Electrical', si: 'S', ex: '1 mS',
    units: [
      ['nS', 1e-9, 'nanosiemens', 'M', ''],
      ['µS', 1e-6, 'microsiemens', 'M', 'uS|μS|µmho|umho'],
      ['mS', 1e-3, 'millisiemens', 'M', 'mmho|millisiemens'],
      ['S', 1, 'siemens (mho)', 'M', 'siemens|mho|mhos|℧|1/Ω|Ω⁻¹', { pre: 1 }],
      ['kS', 1e3, 'kilosiemens', 'M', ''],
    ] },
  { id: 'capacitance', name: 'Capacitance', group: 'Electrical', si: 'F', ex: '100 nF', draw: 'log',
    notes: ['F alone reads as °F; write farad, or with a prefix (µF, nF, pF).'],
    units: [
      ['fF', 1e-15, 'femtofarad', 'M', 'ff?'],
      ['pF', 1e-12, 'picofarad', 'M', 'pf|puF|uuF|mmfd|mmf|picofarad|picofarads'],
      ['nF', 1e-9, 'nanofarad', 'M', 'nf|nanofarad|nanofarads'],
      ['µF', 1e-6, 'microfarad', 'M', 'uF|uf|μF|µf|mfd|MFD|microfarad|microfarads'],
      ['mF', 1e-3, 'millifarad', 'M', 'millifarad|millifarads'],
      ['F', 1, 'farad', 'M', 'farad|farads', { pre: 1, lo: 1 }],
    ] },
  { id: 'inductance', name: 'Inductance', group: 'Electrical', si: 'H', ex: '10 µH', draw: 'log',
    units: [
      ['nH', 1e-9, 'nanohenry', 'M', 'nh|nanohenry|nanohenries'],
      ['µH', 1e-6, 'microhenry', 'M', 'uH|uh|μH|microhenry|microhenries'],
      ['mH', 1e-3, 'millihenry', 'M', 'mh|millihenry|millihenries'],
      ['H', 1, 'henry', 'M', 'henry|henries|henrys', { pre: 1 }],
    ] },
  { id: 'charge', name: 'Charge & battery capacity', group: 'Electrical', si: 'C', ex: '2000 mAh',
    notes: ['C alone reads as °C; write coulomb (or a prefix: mC, µC) for charge.'],
    units: [
      ['e', QE, 'elementary charge', 'O', 'elementary charge|elementary charges|qe'],
      ['pC', 1e-12, 'picocoulomb', 'M', ''],
      ['nC', 1e-9, 'nanocoulomb', 'M', ''],
      ['µC', 1e-6, 'microcoulomb', 'M', 'uC|μC'],
      ['mC', 1e-3, 'millicoulomb', 'M', ''],
      ['µAh', 3.6e-3, 'microampere-hour', 'O', 'uAh|μAh'],
      ['C', 1, 'coulomb (A·s)', 'M', 'coulomb|coulombs|A·s|As|A-s', { pre: 1, lo: 1 }],
      ['mAh', 3.6, 'milliampere-hour', 'O', 'mah|mAH|MAH|mA·h|mA-h|mAhr'],
      ['Ah', 3600, 'ampere-hour', 'O', 'ah|AH|A·h|A-h|Ahr|amp hour|amp hours'],
      ['kC', 1e3, 'kilocoulomb', 'M', ''],
    ] },
  { id: 'resistivity', name: 'Resistivity', group: 'Electrical', si: 'Ω·m', ex: '1.72 µΩ·cm',
    notes: ['Annealed copper (IACS) is 1.7241 µΩ·cm = 0.017241 Ω·mm²/m at 20 °C.'],
    units: [
      ['nΩ·m', 1e-9, 'nano-ohm metre', 'M', 'nohm·m|nΩm|nohm-m|nOhm·m'],
      ['µΩ·cm', 1e-8, 'micro-ohm centimetre', 'M', 'uohm·cm|µΩcm|uohm-cm|uΩ·cm|µohm·cm|µohm-cm|uΩcm|uohm cm'],
      ['Ω·mm²/m', 1e-6, 'ohm square millimetre per metre', 'M', 'ohm·mm²/m|ohm mm2/m|Ωmm²/m|ohm*mm^2/m|Ω·mm2/m|ohm-mm2/m'],
      ['Ω·cm', 1e-2, 'ohm centimetre', 'M', 'ohm·cm|ohm-cm|Ωcm|ohm cm|Ohm·cm'],
      ['Ω·m', 1, 'ohm metre', 'M', 'ohm·m|ohm-m|Ωm|ohm m|Ohm·m'],
      ['Ω·cmil/ft', CMIL / FT, 'ohm circular mil per foot', 'U', 'ohm·cmil/ft|ohm-cmil/ft|Ω-cmil/ft|ohm cmil/ft'],
    ] },
  { id: 'conductivity', name: 'Conductivity', group: 'Electrical', si: 'S/m', ex: '100 %IACS',
    notes: ['100 % IACS = 58 MS/m exactly (1/58 Ω·mm²/m, the 1913 annealed copper standard).'],
    units: [
      ['µS/cm', 1e-4, 'microsiemens per centimetre', 'M', 'uS/cm|µmho/cm|umho/cm'],
      ['mS/cm', 0.1, 'millisiemens per centimetre', 'M', 'mmho/cm'],
      ['S/m', 1, 'siemens per metre', 'M', 'mho/m'],
      ['S/cm', 100, 'siemens per centimetre', 'M', ''],
      ['MS/m', 1e6, 'megasiemens per metre (= m/(Ω·mm²))', 'M', 'm/(Ω·mm²)|S·m/mm²|m/Ωmm2'],
      ['%IACS', 58e6 / 100, 'percent IACS', 'O', '% IACS|IACS|%iacs'],
    ] },

  // ---------------- magnetic ----------------
  { id: 'flux', name: 'Magnetic flux', group: 'Magnetic', si: 'Wb', ex: '1 mWb',
    units: [
      ['Mx', 1e-8, 'maxwell (CGS)', 'O', 'maxwell|maxwells|G·cm²|line|lines'],
      ['µWb', 1e-6, 'microweber', 'M', 'uWb|μWb'],
      ['mWb', 1e-3, 'milliweber', 'M', ''],
      ['Wb', 1, 'weber (V·s)', 'M', 'weber|webers|V·s|Vs|T·m²', { pre: 1 }],
    ] },
  { id: 'fluxdensity', name: 'Flux density (B)', group: 'Magnetic', si: 'T', ex: '1 G',
    units: [
      ['nT', 1e-9, 'nanotesla (gamma)', 'M', 'gamma|γ'],
      ['mG', 1e-7, 'milligauss', 'O', 'milligauss'],
      ['µT', 1e-6, 'microtesla', 'M', 'uT|μT|microtesla'],
      ['G', 1e-4, 'gauss (CGS)', 'O', 'gauss|Gs'],
      ['mT', 1e-3, 'millitesla', 'M', 'millitesla'],
      ['kG', 0.1, 'kilogauss', 'O', 'kilogauss|kGs'],
      ['T', 1, 'tesla (Wb/m²)', 'M', 'tesla|teslas|Wb/m²|Wb/m2', { pre: 1 }],
    ] },
  { id: 'hfield', name: 'Field strength (H)', group: 'Magnetic', si: 'A/m', ex: '1 Oe',
    notes: ['1 Oe = 1000/(4π) A/m; in air, 1 Oe of H goes with 1 G of B.'],
    units: [
      ['A/m', 1, 'ampere (turn) per metre', 'M', 'At/m|A·t/m|A-turn/m'],
      ['Oe', 1000 / (4 * PI), 'oersted (CGS)', 'O', 'oersted|oersteds|oe'],
      ['A/cm', 100, 'ampere per centimetre', 'M', 'At/cm'],
      ['kA/m', 1e3, 'kiloampere per metre', 'M', 'kAt/m'],
      ['kOe', 1e6 / (4 * PI), 'kilo-oersted', 'O', 'kilooersted'],
    ] },

  // ---------------- digital ----------------
  { id: 'datasize', name: 'Data size', group: 'Digital', si: 'bit', ex: '64 KiB',
    notes: ['kB, MB, GB are powers of 1000; KiB, MiB, GiB powers of 1024 (IEC 80000-13). A capital KB is read as 1024 bytes, the JEDEC habit.'],
    units: [
      ['bit', 1, 'bit', 'M', 'bits|b|Bit|Bits'],
      ['nibble', 4, 'nibble (4 bits)', 'O', 'nybble|nibbles|nybbles'],
      ['B', 8, 'byte (octet)', 'M', 'byte|bytes|octet|octets|Byte|Bytes'],
      ['kbit', 1e3, 'kilobit', 'M', 'kb|Kb|kilobit|kilobits|kbits'],
      ['Kibit', 1024, 'kibibit', 'M', 'Kib|kibit|kibibit'],
      ['kB', 8e3, 'kilobyte (1000 B)', 'M', 'kilobyte|kilobytes|kbyte|kByte'],
      ['KiB', 8192, 'kibibyte (1024 B)', 'M', 'kibibyte|kibibytes|KB|KByte|Kbyte|KBytes'],
      ['Mbit', 1e6, 'megabit', 'M', 'Mb|megabit|megabits|mbit'],
      ['Mibit', 2 ** 20, 'mebibit', 'M', 'Mib|mebibit'],
      ['MB', 8e6, 'megabyte (10⁶ B)', 'M', 'megabyte|megabytes|MByte|Mbyte'],
      ['MiB', 8 * 2 ** 20, 'mebibyte (2²⁰ B)', 'M', 'mebibyte|mebibytes'],
      ['Gbit', 1e9, 'gigabit', 'M', 'Gb|gigabit|gigabits|gbit'],
      ['Gibit', 2 ** 30, 'gibibit', 'M', 'Gib|gibibit'],
      ['GB', 8e9, 'gigabyte (10⁹ B)', 'M', 'gigabyte|gigabytes|GByte'],
      ['GiB', 8 * 2 ** 30, 'gibibyte (2³⁰ B)', 'M', 'gibibyte|gibibytes'],
      ['TB', 8e12, 'terabyte (10¹² B)', 'M', 'terabyte|terabytes'],
      ['TiB', 8 * 2 ** 40, 'tebibyte (2⁴⁰ B)', 'M', 'tebibyte|tebibytes'],
      ['PB', 8e15, 'petabyte (10¹⁵ B)', 'M', 'petabyte|petabytes'],
      ['PiB', 8 * 2 ** 50, 'pebibyte (2⁵⁰ B)', 'M', 'pebibyte|pebibytes'],
    ] },
  { id: 'datarate', name: 'Data rate', group: 'Digital', si: 'bit/s', ex: '115200 Bd',
    notes: ['Baud counts symbols per second; it equals bit/s only for one bit per symbol (a UART, NRZ). A UART frame of 8N1 is 10 bits per byte.'],
    units: [
      ['bit/s', 1, 'bit per second', 'M', 'bps|b/s|bits/s|bit/sec'],
      ['Bd', 1, 'baud (1 bit per symbol)', 'O', 'baud|Baud|bd|BD', { pre: 1 }],
      ['B/s', 8, 'byte per second', 'M', 'Bps|byte/s|bytes/s|B/sec'],
      ['kbit/s', 1e3, 'kilobit per second', 'M', 'kbps|kb/s|Kbps|kbit/sec|Kb/s'],
      ['kB/s', 8e3, 'kilobyte per second', 'M', 'kBps|kbyte/s'],
      ['KiB/s', 8192, 'kibibyte per second', 'M', 'KB/s|KBps'],
      ['Mbit/s', 1e6, 'megabit per second', 'M', 'Mbps|Mb/s|mbps|Mbit/sec'],
      ['MB/s', 8e6, 'megabyte per second', 'M', 'MBps|Mbyte/s'],
      ['MiB/s', 8 * 2 ** 20, 'mebibyte per second', 'M', ''],
      ['Gbit/s', 1e9, 'gigabit per second', 'M', 'Gbps|Gb/s|gbps'],
      ['GB/s', 8e9, 'gigabyte per second', 'M', 'GBps'],
      ['GiB/s', 8 * 2 ** 30, 'gibibyte per second', 'M', ''],
    ] },

  // ---------------- ratios ----------------
  { id: 'ratio', name: 'Ratio, %, ppm', group: 'Ratio & level', si: '×', ex: '50 ppm',
    notes: ['The dB rows read the ratio as a power ratio (10·log) and as an amplitude ratio of volts or amps (20·log).'],
    units: [
      ['ppt', 1e-12, 'parts per trillion', 'M', 'PPT'],
      ['ppb', 1e-9, 'parts per billion', 'M', 'PPB'],
      ['ppm', 1e-6, 'parts per million', 'M', 'PPM'],
      ['‱', 1e-4, 'basis point (per ten thousand)', 'O', 'bp|basis point|basis points|permyriad'],
      ['‰', 1e-3, 'per mille', 'M', 'permille|per mille|promille'],
      ['%', 1e-2, 'percent', 'M', 'percent|pct|per cent'],
      ['×', 1, 'ratio (times)', 'M', 'x|X|times|ratio|:1|fold'],
      ['dB(P)', log(10, 1), 'decibels, as a power ratio', 'L', 'dB power|dB (power)|dBpwr'],
      ['dB(V)', log(20, 1), 'decibels, as an amplitude ratio', 'L', 'dB amplitude|dB (amplitude)|dB (voltage)|dBvolt'],
    ] },
  { id: 'db', name: 'Decibels', group: 'Ratio & level', si: 'dB', ex: '3 dB',
    notes: ['A decibel figure is the same whether it is power or amplitude; the ratio it stands for is not: 3 dB is ×2 in power but ×1.41 in volts.',
      '1 Np = 20/ln 10 dB ≈ 8.686 dB, for field (amplitude) quantities.'],
    units: [
      ['dB', 1, 'decibel', 'L', 'db|DB|decibel|decibels'],
      ['bel', 10, 'bel', 'L', 'bels'],
      ['Np', 20 / Math.LN10, 'neper', 'L', 'neper|nepers'],
      ['×P', { to: (x) => (x > 0 ? 10 * Math.log10(x) : x === 0 ? -Infinity : NaN), from: (d) => 10 ** (d / 10) }, 'power ratio', 'M', 'power ratio|xP|P ratio'],
      ['×V', { to: (x) => (x > 0 ? 20 * Math.log10(x) : x === 0 ? -Infinity : NaN), from: (d) => 10 ** (d / 20) }, 'amplitude ratio (volts, amps)', 'M', 'amplitude ratio|voltage ratio|xV|V ratio|field ratio|current ratio'],
      ['%P', { to: (x) => (x > 0 ? 10 * Math.log10(x / 100) : NaN), from: (d) => 100 * 10 ** (d / 10) }, 'power, in percent', 'M', '% power'],
      ['%V', { to: (x) => (x > 0 ? 20 * Math.log10(x / 100) : NaN), from: (d) => 100 * 10 ** (d / 20) }, 'amplitude, in percent', 'M', '% amplitude|% voltage'],
    ] },

  // ---------------- light ----------------
  { id: 'illuminance', name: 'Illuminance', group: 'Light', si: 'lx', ex: '500 lx',
    units: [
      ['lx', 1, 'lux (lm/m²)', 'M', 'lux|lm/m²|lm/m2', { pre: 1 }],
      ['fc', 1 / FT ** 2, 'foot-candle (lm/ft²)', 'U', 'footcandle|footcandles|foot-candle|foot-candles|ft-c|fcd|lm/ft²|lm/ft2'],
      ['klx', 1e3, 'kilolux', 'M', 'klux|kilolux'],
      ['ph', 1e4, 'phot (lm/cm²)', 'O', 'phot|phots'],
    ] },
  { id: 'luminance', name: 'Luminance', group: 'Light', si: 'cd/m²', ex: '300 nit',
    units: [
      ['cd/m²', 1, 'candela per m² (nit)', 'M', 'cd/m2|nit|nits|nt'],
      ['fL', 1 / (PI * FT ** 2), 'foot-lambert', 'U', 'foot-lambert|foot-lamberts|ftL|ft-L'],
      ['cd/ft²', 1 / FT ** 2, 'candela per square foot', 'U', 'cd/ft2'],
      ['cd/in²', 1 / IN ** 2, 'candela per square inch', 'U', 'cd/in2'],
      ['kcd/m²', 1e3, 'kilocandela per m²', 'M', 'kcd/m2|knit|knits'],
      ['lambert', 1e4 / PI, 'lambert', 'O', 'lamberts|La'],
      ['sb', 1e4, 'stilb (cd/cm²)', 'O', 'stilb|stilbs|cd/cm²|cd/cm2'],
    ] },
  { id: 'intensity', name: 'Luminous intensity', group: 'Light', si: 'cd', ex: '20 mcd',
    units: [
      ['mcd', 1e-3, 'millicandela', 'M', 'millicandela'],
      ['cd', 1, 'candela', 'M', 'candela|candelas', { pre: 1 }],
      ['cp', 1, 'candlepower (≈ 1 cd)', 'O', 'candlepower|candle power'],
      ['kcd', 1e3, 'kilocandela', 'M', ''],
    ] },
  { id: 'lumflux', name: 'Luminous flux', group: 'Light', si: 'lm', ex: '800 lm',
    units: [
      ['mlm', 1e-3, 'millilumen', 'M', ''],
      ['lm', 1, 'lumen (cd·sr)', 'M', 'lumen|lumens', { pre: 1 }],
      ['klm', 1e3, 'kilolumen', 'M', 'kilolumen|kilolumens'],
    ] },
];

// The embedded modes, listed with the quantities in the page's rail.
export const MODES = [
  { id: 'bases', name: 'Number bases', blurb: 'hex, binary, two\'s complement' },
  { id: 'uart', name: 'UART baud divider', blurb: 'BRR and baud error' },
  { id: 'timer', name: 'Timer PSC / ARR', blurb: 'prescaler and period' },
];

export const PREFIXES = [
  ['Q', 1e30, 'quetta'], ['R', 1e27, 'ronna'], ['Y', 1e24, 'yotta'], ['Z', 1e21, 'zetta'], ['E', 1e18, 'exa'],
  ['P', 1e15, 'peta'], ['T', 1e12, 'tera'], ['G', 1e9, 'giga'], ['M', 1e6, 'mega'], ['k', 1e3, 'kilo'],
  ['h', 1e2, 'hecto'], ['da', 1e1, 'deca'], ['d', 1e-1, 'deci'], ['c', 1e-2, 'centi'], ['m', 1e-3, 'milli'],
  ['µ', 1e-6, 'micro'], ['u', 1e-6, 'micro'], ['μ', 1e-6, 'micro'], ['n', 1e-9, 'nano'], ['p', 1e-12, 'pico'],
  ['f', 1e-15, 'femto'], ['a', 1e-18, 'atto'], ['z', 1e-21, 'zepto'], ['y', 1e-24, 'yocto'], ['r', 1e-27, 'ronto'], ['q', 1e-30, 'quecto'],
];

// Built once: each unit as an object, and every alias pointing at its units.
for (const q of QUANTITIES) {
  q.units = q.units.map(([sym, size, name, sys, aliases = '', o = {}], i) => {
    const u = { q: q.id, sym, name: name || sym, sys, i, ...o };
    if (typeof size === 'number') u.f = size; else u.fn = size;
    u.aliases = String(aliases).split('|').filter(Boolean).filter((a) => !a.endsWith('?'));
    return u;
  });
  q.bySym = new Map(q.units.map((u) => [u.sym, u]));
}
export const BY_ID = new Map(QUANTITIES.map((q) => [q.id, q]));

export const unitCount = () => QUANTITIES.reduce((n, q) => n + q.units.length, 0);
