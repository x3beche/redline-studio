/* Redline virtual board: the firmware side of the bridge.
 *
 * Linked into an unmodified ESP-IDF app (EXTRA_COMPONENT_DIRS) only when it
 * runs in the simulator. Driver calls are wrapped with the linker's --wrap:
 * each wrapper calls the real driver and also reports to the bridge, a
 * second UART that carries one JSON object per line (backend/sim/SPEC.md).
 * Each wrapper family is its own file, so an archive member (and the driver
 * it calls) is linked only when the app uses that driver.
 */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SIM_PINS 49

/* Send one message: `fmt` is the JSON after `{"type":"<type>","t":<now>,` */
void sim_emit(const char *type, const char *fmt, ...);

/* Inputs the runtime drove, by GPIO number. */
int    sim_pin_in(int gpio);                 /* -1: not driven */
double sim_adc_in(int gpio);                 /* volts, -1: not driven */
double sim_pulses(int gpio);                 /* edges seen so far on a freq input */

/* A transaction (i2c): send it, block until the reply. Returns 1 ack,
 * 0 nack, -1 timeout. `rbuf` receives `rlen` bytes. */
int sim_transact(const char *bus, int addr, const uint8_t *w, size_t wlen,
                 uint8_t *rbuf, size_t rlen);
