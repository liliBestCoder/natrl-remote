// Arduino.h stub — provides types IRremoteESP8266 needs without Arduino framework
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <string>
#include <algorithm>

// Arduino types
typedef unsigned char boolean;
typedef uint8_t byte;

// String (IRremoteESP8266 uses std::string as String)
using String = std::string;
// Arduino String has substring(), std::string has substr()
#define substring substr

// Pin constants
#define HIGH 0x1
#define LOW  0x0
#define INPUT 0x0
#define OUTPUT 0x1
#define INPUT_PULLUP 0x2

// PROGMEM stubs
#define PROGMEM
#define PGM_P const char*
#define PSTR(x) x
#define FPSTR(x) x
#define strlen_P strlen
#define strncpy_P strncpy

// min/max/abs — use std:: versions, NOT macros (break STL <chrono>)
using std::min;
using std::max;
using std::abs;

// Time stubs
inline unsigned long millis() { return 0; }
inline unsigned long micros() { return 0; }
inline void delay(unsigned long) {}
inline void delayMicroseconds(unsigned int) {}

// GPIO stubs
inline void pinMode(uint8_t, uint8_t) {}
inline void digitalWrite(uint8_t, uint8_t) {}
inline int  digitalRead(uint8_t) { return 0; }

#define digitalPinToPort(pin) (0)
#define digitalPinToBitMask(pin) (0)
#define portOutputRegister(port) ((volatile uint8_t*)0)
#define portInputRegister(port) ((volatile uint8_t*)0)
#define portModeRegister(port) ((volatile uint8_t*)0)

typedef void (*voidFuncPtr)(void);

#define IRAM_ATTR
#define ICACHE_FLASH_ATTR
#define F(x) x
#define yield()
