#pragma once
#include <stdint.h>
#define INPUT 0x01
#define OUTPUT 0x02
#define INPUT_PULLUP 0x05
#define digitalPinToInterrupt(p) (p)
inline void pinMode(uint8_t, uint8_t) {}
inline void digitalWrite(uint8_t, uint8_t) {}
inline int digitalRead(uint8_t) { return 0; }
