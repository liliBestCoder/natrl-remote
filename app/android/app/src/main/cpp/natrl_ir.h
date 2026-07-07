/**
 * natrl_ir.h — IR AC frame encoder (ported from IRremoteESP8266)
 *
 * Compiled into libnatrl_ir.so, packaged with the Android APK.
 * The mobile app calls these functions via JNI to generate raw IR timing
 * arrays locally, then emits them through Android's ConsumerIrManager.
 *
 * Supports 17 AC brands with brand-specific encoding logic.
 */
#ifndef NATRL_IR_H
#define NATRL_IR_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    int* timing;
    int  length;
} ir_timing_t;

ir_timing_t* encode_ac_frame(const char* brand_code, int temperature,
                             const char* mode, const char* fan_speed);
int get_carrier_freq(const char* brand_code);
void free_timing(ir_timing_t* t);

#ifdef __cplusplus
}
#endif
#endif
