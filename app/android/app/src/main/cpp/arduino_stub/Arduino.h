// Arduino.h stub — provides types IRremoteESP8266 needs without Arduino framework
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <math.h>

typedef unsigned char boolean;
typedef uint8_t byte;

#define HIGH 0x1
#define LOW  0x0
#define INPUT 0x0
#define OUTPUT 0x1
#define INPUT_PULLUP 0x2

#define PROGMEM
#define PGM_P const char*
#define PSTR(x) x
#define FPSTR(x) x
#define F(x) x
#define strlen_P strlen
#define strncpy_P strncpy

#define min(a,b) ((a)<(b)?(a):(b))
#define max(a,b) ((a)>(b)?(a):(b))
#define abs(x) ((x)>0?(x):-(x))

inline unsigned long millis() { return 0; }
inline unsigned long micros() { return 0; }
inline void delay(unsigned long ms) {}
inline void delayMicroseconds(unsigned int us) {}
inline void yield() {}

#define digitalPinToPort(pin) (0)
#define digitalPinToBitMask(pin) (0)
#define portOutputRegister(port) ((volatile uint8_t*)0)
#define portInputRegister(port) ((volatile uint8_t*)0)
#define portModeRegister(port) ((volatile uint8_t*)0)

typedef void (*voidFuncPtr)(void);

#define IRAM_ATTR
#define ICACHE_FLASH_ATTR
