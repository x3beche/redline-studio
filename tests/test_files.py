"""Files: kept as they came; what they are is read from the name and the header."""
from backend import access, files


def test_a_bom_is_known_by_its_header():
    head = b"Designator,Comment,Footprint,LCSC Part\nU1,ESP32-C3,QFN-32,C2838500\n"
    assert files.kind_of("export.csv", head) == "bom"
    # EasyEDA writes UTF-16 with tabs
    head = "ID\tName\tDesignator\tFootprint\tQuantity\n".encode("utf-16")
    assert files.kind_of("BOM_Board1.csv", head) == "bom"


def test_pick_and_place_is_not_a_bom():
    head = b"Designator,Mid X,Mid Y,Layer,Rotation\nU1,10mm,20mm,T,90\n"
    assert files.kind_of("PickAndPlace_PCB1.csv", head) == "pick-place"


def test_a_spreadsheet_goes_by_its_name():
    assert files.kind_of("BOM_DemoBoard.xlsx") == "bom"
    assert files.kind_of("prices.xlsx") == "table"
    assert files.kind_of("plain.csv", b"a,b,c\n1,2,3\n") == "table"


def test_kinds_by_suffix():
    assert files.kind_of("Gerber_TopLayer.GTL") == "gerber"
    assert files.kind_of("Drill_PTH_Through.DRL") == "drill"
    assert files.kind_of("fan.STEP") == "step"
    assert files.kind_of("datasheet.pdf") == "pdf"
    assert files.kind_of("bench.jpg") == "image"
    assert files.kind_of("gerbers.zip") == "archive"
    assert files.kind_of("weird.xyz") == "other"


def test_names_lose_their_folders():
    assert files.clean_name("../../etc/passwd") == "passwd"
    assert files.clean_name("C:\\Users\\me\\BOM.csv") == "BOM.csv"
    assert files.clean_name("a\x00b.csv") == "ab.csv"
    assert files.clean_name("") == "file"


def test_the_agent_is_told_how_to_fetch_it():
    doc = {"_id": "abc123", "name": "BOM.csv", "kind": "bom", "bytes": 2048,
           "context": {"board": "demoboard"}, "note": "from EasyEDA"}
    msg = files.as_message(doc)
    assert "files get abc123" in msg
    assert "board convert demoboard --bom BOM.csv --run" in msg
    assert "from EasyEDA" in msg


def test_reviewers_bring_files_viewers_do_not():
    for m, p in (("POST", "/api/files"), ("PATCH", "/api/files/f1"), ("DELETE", "/api/files/f1"),
                 ("POST", "/api/files/f1/send")):
        a = access.action(m, p)
        assert access.allowed("reviewer", a) and not access.allowed("viewer", a)
    assert access.allowed("viewer", access.action("GET", "/api/files/f1"))


def test_an_easyeda_bom_survives_the_trip_to_the_server():
    """`board convert --bom` sends the BOM as text: EasyEDA's UTF-16 has to
    be decoded as UTF-16, or every row is noise and every part a guess."""
    from backend.imports.parts import _text, parse_bom
    raw = ("No.\tQuantity\tComment\tDesignator\tFootprint\tSupplier Part\n"
           "1\t1\tSIQ-02FVS3\tU1\tSW-SMD_SIQ-02FVS3_1\tC2925423\n").encode("utf-16")
    sent = _text(raw).encode()            # what the server gets and encodes again
    assert parse_bom(sent)["U1"]["part"] == "C2925423"
