"""The MCU panel's readers: IDF's GPIO page and soc_caps dump, sdkconfig,
CubeMX's part files, and what a register-level firmware says of itself."""

from pathlib import Path

import pytest

from backend import mcuinfo

GPIO_INC = """
.. gpio-summary

.. list-table::
    :header-rows: 1
    :widths: 8 12 12 20

    * - GPIO
      - Analog Function
      - RTC GPIO
      - Comments

    * - GPIO0
      - ADC2_CH1
      - RTC_GPIO11
      - Strapping pin

    * - GPIO6
      -
      -
      - SPI0/1

    * - GPIO12
      - ADC2_CH5
      - RTC_GPIO15
      - Strapping pin; JTAG

    * - GPIO34
      - ADC1_CH6
      - RTC_GPIO4
      - GPI

.. note::

    - Strapping pin: GPIO0, GPIO2, GPIO5, GPIO12 (MTDI), and GPIO15 (MTDO) are strapping pins. For more information, please refer to `ESP32 datasheet <{IDF_TARGET_DATASHEET_EN_URL}>`_.
    - GPI: GPIO34-39 can only be set as input mode and do not have software-enabled pullup or pulldown functions.
    - ADC2: ADC2 pins cannot be used when Wi-Fi is used. See :ref:`Hardware Limitations <hardware_limitations_adc_oneshot>`.

---
"""


def test_gpio_doc_table_and_notes():
    got = mcuinfo.parse_gpio_doc(GPIO_INC)
    assert got["pins"]["GPIO0"] == {"analog": "ADC2_CH1", "rtc": "RTC_GPIO11", "comments": ["Strapping pin"]}
    assert got["pins"]["GPIO6"] == {"analog": None, "rtc": None, "comments": ["SPI0/1"]}
    assert got["pins"]["GPIO12"]["comments"] == ["Strapping pin", "JTAG"]
    assert "GPIO" not in got["pins"]                          # the header row
    assert got["notes"]["Strapping pin"].endswith("refer to ESP32 datasheet.")
    assert got["notes"]["ADC2"].startswith("ADC2 pins cannot be used when Wi-Fi")
    assert "<" not in got["notes"]["ADC2"]


DUMP = """@@version
v5.3.1
@@lines
158:#define SOC_CPU_CORES_NUM               2
198:#define SOC_I2C_NUM                (2U)
@@caps
{"SOC_CPU_CORES_NUM": 2,"SOC_I2C_NUM": 2,"SOC_GPIO_VALID_GPIO_MASK": 1095468318719,"SOC_GPIO_VALID_OUTPUT_GPIO_MASK": 13136560127,"SOC_ADC_PERIPH_NUM": 2,"SOC_ADC_CHANNEL_NUM(0)": 8,"SOC_ADC_CHANNEL_NUM(1)": 10,"SOC_LEDC_CHANNEL_NUM": 8,"SOC_LEDC_SUPPORT_HS_MODE": 1,"SOC_LEDC_TIMER_BIT_WIDTH": 20,"_": 0}
@@core
189:#define XCHAL_HW_VERSION_NAME\t\t"LX6.0.3"\t/* full version name */
@@kcpu
    config ESP_DEFAULT_CPU_FREQ_MHZ_40
        bool "40 MHz"
        depends on IDF_ENV_FPGA
    config ESP_DEFAULT_CPU_FREQ_MHZ_80
        bool "80 MHz"
    config ESP_DEFAULT_CPU_FREQ_MHZ_240
        bool "240 MHz"
@@sram
29:    There is 520 KB of available SRAM (320 KB of DRAM and 200 KB of IRAM) on the ESP32. However
@@uartpins
23:#define U0TXD_GPIO_NUM  (1)
24:#define U0RXD_GPIO_NUM  (3)
@@alias
156:4       SENSOR_VP (FSVP)   I       | GPIO36, ADC1_CH0, RTC_GPIO0
@@gpio
""" + GPIO_INC + "@@end\n"


def test_esp_dump():
    f = mcuinfo.parse_esp("esp32", DUMP)
    assert f["idf"] == "v5.3.1" and f["caps"]["SOC_I2C_NUM"] == 2 and "_" not in f["caps"]
    assert f["caps_line"] == {"SOC_CPU_CORES_NUM": 158, "SOC_I2C_NUM": 198}
    assert f["core"] == {"name": "LX6.0.3", "line": 189}
    assert f["mhz_options"] == [80, 240]                      # the FPGA-only 40 MHz is not a choice
    assert f["sram"] == {"kb": 520, "line": 29}
    assert f["alias"]["TXD0"]["gpio"] == "GPIO1" and f["alias"]["SENSOR_VP"]["gpio"] == "GPIO36"
    rows = {r["kind"]: r for r in mcuinfo.esp_peripherals(f["caps"], f["caps_line"],
                                                          ["ledc_timer_config", "gpio_config"], "nm x.elf")}
    assert rows["GPIO"]["have"] == 35 and "6 input-only" in rows["GPIO"]["detail"][0]
    assert rows["LEDC PWM"]["have"] == 16 and rows["LEDC PWM"]["linked"] is True
    assert rows["ADC"]["have"] == 18 and rows["I2C"]["linked"] is False
    assert rows["I2C"]["have_src"] == "soc_caps.h:198 SOC_I2C_NUM"


def test_esp_cautions():
    gpio = mcuinfo.parse_gpio_doc(GPIO_INC)
    caps = {"SOC_GPIO_VALID_OUTPUT_GPIO_MASK": 13136560127}
    warn, _ = mcuinfo.esp_cautions("GPIO0", gpio, caps, {"GPIO"}, False, "doc")
    assert [(c["level"], c["text"]) for c in warn] == [("warn", "Strapping pin")]
    driven, sig = mcuinfo.esp_cautions("GPIO34", gpio, caps, {"PWM"}, False, "doc")
    assert sig == ["ADC1_CH6", "RTC_GPIO4"]
    assert ("warn", "input only") in [(c["level"], c["text"]) for c in driven]


def test_sdkconfig_build_first_then_project(tmp_path):
    proj, build = tmp_path / "p", tmp_path / "b"
    (build / "config").mkdir(parents=True)
    proj.mkdir()
    (build / "config" / "sdkconfig.json").write_text('{"FREERTOS_HZ": 1000}')
    (proj / "sdkconfig").write_text("CONFIG_FREERTOS_HZ=100\nCONFIG_ESP_DEFAULT_CPU_FREQ_MHZ=160\n")
    (proj / "sdkconfig.defaults").write_text('CONFIG_ESPTOOLPY_FLASHSIZE="4MB"\n')
    v, where = mcuinfo.read_sdkconfig(proj, build, str(tmp_path))
    assert v == {"FREERTOS_HZ": 1000, "ESP_DEFAULT_CPU_FREQ_MHZ": 160, "ESPTOOLPY_FLASHSIZE": "4MB"}
    assert where["ESP_DEFAULT_CPU_FREQ_MHZ"] == "p/sdkconfig:2"
    assert where["ESPTOOLPY_FLASHSIZE"] == "p/sdkconfig.defaults:1"
    assert mcuinfo._flash_bytes("4MB") == 4 * 1024 * 1024


def test_register_level_source(tmp_path):
    (tmp_path / "chip.h").write_text("#define HSI_HZ 8000000u   /* the oscillator */\n")
    main = tmp_path / "main.c"
    main.write_text("/* TIM3_CH1 in a comment does not count */\n"
                    "void f(void) {\n  SYST_RVR = HSI_HZ / 1000u - 1u;\n  TIM14_CR1 = 1u;\n"
                    "  USART1->BRR = 69;  // USART2_ in a comment\n  GPIOA_MODER = 0;\n}\n")
    assert mcuinfo._source_clock([main], str(tmp_path)) == (8000000, "chip.h:1 HSI_HZ")
    assert mcuinfo._source_tick([main], str(tmp_path)) == (1000, "main.c:3 SysTick reload = clock / 1000")
    chip = {"io": 16, "ips": [{"instance": i, "name": i} for i in
                              ("USART1", "USART2", "TIM3", "TIM14", "I2C1", "GPIO", "NVIC")],
            "pins": [{"name": "PA0", "type": "I/O", "signals": ["ADC_IN0", "SYS_WKUP1"]}]}
    rows = {r["kind"]: r for r in mcuinfo.stm_peripherals(chip, "x.xml", [], [main], str(tmp_path))}
    assert rows["USART"]["have"] == 2 and rows["USART"]["used_instances"] == ["USART1"]
    assert rows["Timers"]["used_instances"] == ["TIM14"]
    assert rows["I2C"]["linked"] is False and rows["GPIO"]["linked"] is True
    assert "ADC" not in rows                                  # no ADC instance on this made-up chip


@pytest.mark.skipif(not (mcuinfo.CUBEMX_DB / "mcu").is_dir(), reason="no STM32CubeMX database here")
def test_cubemx_part_files():
    assert mcuinfo.cubemx_file("STM32F042F6P6").name == "STM32F042F6Px.xml"
    assert mcuinfo.cubemx_file("STM32F042K6T6").name == "STM32F042K(4-6)Tx.xml"
    assert mcuinfo.cubemx_file("STM32F042") is None
    c = mcuinfo.cubemx(str(mcuinfo.cubemx_file("STM32F042F6P6")))
    assert (c["core"], c["mhz"], c["flash_kb"], c["ram_kb"], c["package"]) == \
        ("Arm Cortex-M0", 48, 32, 6, "TSSOP20")
    pa9 = next(p for p in c["pins"] if p["name"] == "PA9")
    assert "USART1_TX" in pa9["signals"]
    assert [x["text"] for x in mcuinfo.stm_cautions(next(p for p in c["pins"] if p["name"] == "PA13"), "x")] \
        == ["SWD"]


def test_no_cubemx_db_is_not_an_error(tmp_path):
    assert mcuinfo.cubemx_file("STM32F042F6P6", db=tmp_path / "nowhere") is None


def test_esp_caps_c_names_each_macro_once():
    c = mcuinfo._caps_c()
    for name in mcuinfo.CAPS:
        assert c.count(f'"\\"{name}\\"') == 1
    assert "SOC_ADC_CHANNEL_NUM(1)" in c
    assert Path(mcuinfo.__file__).name == "mcuinfo.py"


def test_psram_from_the_module_ordering_code():
    from backend.mcuinfo import has_psram
    assert not has_psram("WIFIM-SMD_ESP32-WROOM-32-N4")
    assert has_psram("ESP32-WROOM-32E-N4R2") and has_psram("ESP32-WROVER-E")
    assert has_psram(None) and has_psram("some-custom-board")
