"""One adapter per emulator (backend/sim/SPEC.md §2)."""

from .qemu_esp32 import QemuEsp32

ADAPTERS = {QemuEsp32.name: QemuEsp32}
from .renode import Renode; ADAPTERS[Renode.name] = Renode  # noqa: E402,E702
