#pragma once
#include <stdint.h>
typedef enum { RF_DEFAULT } rf_mode_t;
inline bool wifi_set_sleep_type(rf_mode_t) { return true; }
