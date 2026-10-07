"""The parts drawer, sorted like one: group and branch from LCSC's category,
else from the designator prefix or the part number."""
from backend import lcsc


def test_category_decides():
    assert lcsc.drawer_place(["Multilayer Ceramic Capacitors MLCC - SMD/SMT"], "C?") == ("Passives", "Capacitors")
    assert lcsc.drawer_place(["Resistors"], "R?") == ("Passives", "Resistors")
    assert lcsc.drawer_place(["Power Inductors"], "L?") == ("Passives", "Inductors")
    assert lcsc.drawer_place(["ESD Protection Devices"], "D?") == ("Discretes", "Diodes")
    assert lcsc.drawer_place(["Light Emitting Diodes (LED)"], "LED?") == ("Discretes", "LEDs")
    assert lcsc.drawer_place(["MOSFETs"], "Q?") == ("Discretes", "Transistors")
    assert lcsc.drawer_place(["DC-DC Converters"], "U?") == ("ICs", "Power")
    assert lcsc.drawer_place(["Battery Management ICs"], "U?") == ("ICs", "Power")
    assert lcsc.drawer_place(["Linear Voltage Regulators (LDO)"], "LDO?") == ("ICs", "Power")
    assert lcsc.drawer_place(["USB ICs"], "U?") == ("ICs", "Interface")
    assert lcsc.drawer_place(["WiFi Modules"], "U?") == ("ICs", "Microcontrollers & modules")
    assert lcsc.drawer_place(["USB Connectors"], "USB?") == ("Electromechanical", "Connectors")
    assert lcsc.drawer_place(["Battery Connectors"], "BT?") == ("Electromechanical", "Battery holders")
    assert lcsc.drawer_place(["Tactile Switches"], "SW?") == ("Electromechanical", "Switches")
    assert lcsc.drawer_place(["OLED Displays Modules"], "U?") == ("Displays", "Displays")


def test_prefix_and_part_number_when_the_category_says_nothing():
    assert lcsc.drawer_place(["Pre-ordered Products"], "X?") == ("Frequency", "Crystals & oscillators")
    assert lcsc.drawer_place(["ST Microelectronics"], "U?", "STM32F103C8T6") == ("ICs", "Microcontrollers & modules")
    assert lcsc.drawer_place([], "U?", "X091-2832TSWFG02-H14") == ("Displays", "Displays")
    assert lcsc.drawer_place([], "U?", "SIQ-02FVS3") == ("Electromechanical", "Switches")
    assert lcsc.drawer_place([], "U?", "ABC123") == ("ICs", "Other ICs")
    assert lcsc.drawer_place([], "Q?") == ("Discretes", "Transistors")
    assert lcsc.drawer_place(None, None) == ("Other", "Other")
