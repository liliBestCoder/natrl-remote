/**
 * natrl_ir.c — IR AC frame encoder implementations
 *
 * Ported from IRremoteESP8266 (via Python reference in waveform.py).
 * Each brand has a dedicated encoder that mirrors the C++ source:
 *   https://github.com/crankyoldgit/IRremoteESP8266
 *
 * The raw_timing is a [mark_us, space_us, ...] array suitable for
 * Android ConsumerIrManager.transmit().
 */
#include "natrl_ir.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* ─── Helpers ──────────────────────────────────────────────────── */

static int* alloc_timing(int capacity) {
    int* t = (int*)malloc(capacity * sizeof(int));
    return t;
}

static ir_timing_t* make_timing(int* arr, int len) {
    ir_timing_t* t = (ir_timing_t*)malloc(sizeof(ir_timing_t));
    t->timing = arr;
    t->length = len;
    return t;
}

static int reverse8(int x) {
    int r = 0;
    for (int i = 0; i < 8; i++) { r = (r << 1) | (x & 1); x >>= 1; }
    return r;
}

/* Build NEC timing from state bytes (LSB-first, with header + footer) */
static ir_timing_t* nec_timing(const int* state, int nbytes,
                                int hdr_mark, int hdr_space,
                                int bit_mark, int one_space, int zero_space,
                                int gap, int footer_mark) {
    int capacity = 2 + nbytes * 8 * 2 + 2 + 1 + 64;
    int* timing = alloc_timing(capacity);
    int pos = 0;
    timing[pos++] = hdr_mark;
    timing[pos++] = hdr_space;
    for (int i = 0; i < nbytes; i++) {
        int b = state[i];
        for (int j = 0; j < 8; j++) {
            timing[pos++] = bit_mark;
            timing[pos++] = (b & 1) ? one_space : zero_space;
            b >>= 1;
        }
    }
    if (footer_mark) timing[pos++] = bit_mark;
    if (gap) timing[pos++] = gap;
    return make_timing(timing, pos);
}

/* MSB-first NEC timing (for Midea etc.) */
static ir_timing_t* nec_timing_msb(const int* state, int nbytes,
                                    int hdr_mark, int hdr_space,
                                    int bit_mark, int one_space, int zero_space,
                                    int gap) {
    int capacity = 2 + nbytes * 8 * 2 + 2 + 1;
    int* timing = alloc_timing(capacity);
    int pos = 0;
    timing[pos++] = hdr_mark;
    timing[pos++] = hdr_space;
    for (int i = 0; i < nbytes; i++) {
        int b = state[i];
        for (int j = 7; j >= 0; j--) {
            timing[pos++] = bit_mark;
            timing[pos++] = ((b >> j) & 1) ? one_space : zero_space;
        }
    }
    timing[pos++] = bit_mark;
    if (gap) timing[pos++] = gap;
    return make_timing(timing, pos);
}

/* Mode & Fan maps */
static int mode_map(const char* mode) {
    if (!strcmp(mode, "auto"))     return 0;
    if (!strcmp(mode, "cool"))     return 1;
    if (!strcmp(mode, "dry"))      return 2;
    if (!strcmp(mode, "fan_only")) return 3;
    if (!strcmp(mode, "heat"))     return 4;
    return 1;
}

static int fan_map(const char* fan) {
    if (!strcmp(fan, "auto"))   return 0;
    if (!strcmp(fan, "low"))    return 1;
    if (!strcmp(fan, "medium")) return 2;
    if (!strcmp(fan, "high"))   return 3;
    return 0;
}

/* ─── Gree ─────────────────────────────────────────────────────── */
static ir_timing_t* encode_gree(int temp, const char* mode, const char* fan) {
    int m = mode_map(mode);
    int f = fan_map(fan);
    int state[8] = {0};
    state[0] = (m & 0x7) | (1 << 3) | ((f & 0x3) << 4);
    state[1] = (temp - 16) & 0xF;
    state[2] = 0x20;
    state[3] = 0x50;
    int xor_sum = 0;
    for (int i = 0; i < 7; i++) xor_sum ^= state[i];
    state[7] = (((xor_sum >> 4) + (xor_sum & 0xF) + 4) & 0xF) << 4;
    return nec_timing(state, 8, 9000, 4500, 620, 1600, 540, 19980, 1);
}

/* ─── Midea ────────────────────────────────────────────────────── */
static ir_timing_t* encode_midea(int temp, const char* mode, const char* fan) {
    int midea_m = 0;
    if (!strcmp(mode, "auto"))     midea_m = 2;
    else if (!strcmp(mode, "cool"))     midea_m = 0;
    else if (!strcmp(mode, "dry"))      midea_m = 1;
    else if (!strcmp(mode, "fan_only")) midea_m = 4;
    else if (!strcmp(mode, "heat"))     midea_m = 3;
    int f = fan_map(fan);
    int state[6] = {0};
    state[1] = 0xFF;
    state[2] = 0xFF;
    state[3] = (temp - 17) & 0x1F;
    state[4] = ((midea_m & 0x7) << 5) | ((f & 0x3) << 3) | 0x01;
    state[5] = 0x34;
    int total = 0;
    for (int i = 1; i < 6; i++) total += reverse8(state[i]);
    state[0] = reverse8((256 - (total & 0xFF)) & 0xFF);
    return nec_timing_msb(state, 6, 4480, 4480, 560, 1680, 560, 8100);
}

/* ─── Haier ────────────────────────────────────────────────────── */
static ir_timing_t* encode_haier(int temp, const char* mode, const char* fan) {
    int m = 0xA5;
    if (!strcmp(mode, "auto"))     m = 0xA0;
    else if (!strcmp(mode, "cool"))     m = 0xA5;
    else if (!strcmp(mode, "dry"))      m = 0xA9;
    else if (!strcmp(mode, "fan_only")) m = 0xAB;
    else if (!strcmp(mode, "heat"))     m = 0xA7;
    int f = fan_map(fan);
    int state[9] = {0};
    state[0] = m;
    state[1] = ((temp - 16) & 0x0F) | ((f & 0x3) << 4);
    int sum = 0;
    for (int i = 0; i < 8; i++) sum += state[i];
    state[8] = sum & 0xFF;
    return nec_timing(state, 9, 3000, 4300, 520, 1650, 650, 150000, 1);
}

/* ─── TCL ──────────────────────────────────────────────────────── */
static ir_timing_t* encode_tcl(int temp, const char* mode, const char* fan) {
    int tcl_m = 3;
    if (!strcmp(mode, "heat"))     tcl_m = 1;
    else if (!strcmp(mode, "dry"))      tcl_m = 2;
    else if (!strcmp(mode, "cool"))     tcl_m = 3;
    else if (!strcmp(mode, "fan_only")) tcl_m = 7;
    else if (!strcmp(mode, "auto"))     tcl_m = 8;
    int f = fan_map(fan);
    int state[12] = {0};
    state[0] = 0x01;
    state[1] = (temp - 16) & 0x1F;
    state[2] = tcl_m & 0x0F;
    state[3] = f & 0x03;
    int sum = 0;
    for (int i = 0; i < 11; i++) sum += state[i];
    state[11] = sum & 0xFF;
    return nec_timing(state, 12, 3000, 1650, 500, 1050, 325, 20000, 1);
}

/* ─── Kelon ────────────────────────────────────────────────────── */
static ir_timing_t* encode_kelon(int temp, const char* mode, const char* fan) {
    int kelon_m = 2;
    if (!strcmp(mode, "heat"))     kelon_m = 0;
    else if (!strcmp(mode, "auto"))     kelon_m = 1;
    else if (!strcmp(mode, "cool"))     kelon_m = 2;
    else if (!strcmp(mode, "dry"))      kelon_m = 3;
    else if (!strcmp(mode, "fan_only")) kelon_m = 4;
    int f = fan_map(fan);
    int state[8] = {0};
    state[0] = 0x09;
    state[1] = ((temp - 16) << 4) | (kelon_m & 0x0F);
    state[2] = 0x50;
    state[5] = (f & 0x3) << 6;
    int xor_sum = 0;
    for (int i = 0; i < 7; i++) xor_sum ^= state[i];
    state[7] = (((xor_sum >> 4) + (xor_sum & 0xF) + 4) & 0xF) << 4;
    return nec_timing(state, 8, 9000, 4600, 560, 1680, 600, 19950, 1);
}

/* ─── Panasonic ────────────────────────────────────────────────── */
static ir_timing_t* encode_panasonic(int temp, const char* mode, const char* fan) {
    int pana_m = 3;
    if (!strcmp(mode, "auto"))     pana_m = 0;
    else if (!strcmp(mode, "dry"))      pana_m = 2;
    else if (!strcmp(mode, "cool"))     pana_m = 3;
    else if (!strcmp(mode, "heat"))     pana_m = 4;
    else if (!strcmp(mode, "fan_only")) pana_m = 6;
    int fan_val;
    if (!strcmp(fan, "auto"))   fan_val = 7;
    else if (!strcmp(fan, "low"))    fan_val = 4;
    else if (!strcmp(fan, "medium")) fan_val = 5;
    else                             fan_val = 6;
    int state[27] = {0};
    state[0] = 0x02; state[1] = 0x20; state[2] = 0xE0; state[3] = 0x04;
    state[6] = ((pana_m & 0x7) << 5) | ((temp - 16) & 0x1F);
    state[7] = (fan_val & 0x7) << 5;
    state[20] = 0x01;
    int sum = 0;
    for (int i = 0; i < 22; i++) sum += state[i];
    state[22] = sum & 0xFF;
    return nec_timing(state, 27, 3456, 1728, 432, 1296, 432, 10000, 1);
}

/* ─── Coolix ───────────────────────────────────────────────────── */
static ir_timing_t* encode_coolix(int temp, const char* mode, const char* fan) {
    int tmap[] = {0x0,0x1,0x3,0x2,0x6,0x7,0x5,0x4,0xC,0xD,0x9,0x8,0xA,0xB};
    int tc = tmap[(temp - 17 >= 0 && temp - 17 <= 13) ? (temp - 17) : 6];
    int coolix_m = 0;
    if (!strcmp(mode, "auto"))     coolix_m = 2;
    else if (!strcmp(mode, "cool"))     coolix_m = 0;
    else if (!strcmp(mode, "dry"))      coolix_m = 1;
    else if (!strcmp(mode, "fan_only")) coolix_m = 4;
    else if (!strcmp(mode, "heat"))     coolix_m = 3;
    int coolix_f = 5;
    if (!strcmp(fan, "auto"))   coolix_f = 5;
    else if (!strcmp(fan, "low"))    coolix_f = 4;
    else if (!strcmp(fan, "medium")) coolix_f = 2;
    else if (!strcmp(fan, "high"))   coolix_f = 1;
    int b0 = ((coolix_m & 0x3) << 6) | (tc & 0xF);
    int b1 = (0x1F << 3) | (coolix_f & 0x7);
    int b2 = 0x0B;
    int state24 = (b0 << 16) | (b1 << 8) | b2;
    int inv24 = ~state24;
    int* t = alloc_timing(300);
    int pos = 0;
    t[pos++] = 4692; t[pos++] = 4416;
    for (int shift = 16; shift >= 0; shift -= 8) {
        int b = (state24 >> shift) & 0xFF;
        for (int bit = 7; bit >= 0; bit--) {
            t[pos++] = 552;
            t[pos++] = ((b >> bit) & 1) ? 1656 : 552;
        }
    }
    for (int shift = 16; shift >= 0; shift -= 8) {
        int b = (inv24 >> shift) & 0xFF;
        for (int bit = 7; bit >= 0; bit--) {
            t[pos++] = 552;
            t[pos++] = ((b >> bit) & 1) ? 1656 : 552;
        }
    }
    t[pos++] = 552; t[pos++] = 5244;
    return make_timing(t, pos);
}

/* ─── Daikin ───────────────────────────────────────────────────── */
static ir_timing_t* encode_daikin(int temp, const char* mode, const char* fan) {
    int daikin_m = 1;
    if (!strcmp(mode, "auto"))     daikin_m = 0;
    else if (!strcmp(mode, "cool"))     daikin_m = 1;
    else if (!strcmp(mode, "dry"))      daikin_m = 2;
    else if (!strcmp(mode, "fan_only")) daikin_m = 6;
    else if (!strcmp(mode, "heat"))     daikin_m = 4;
    int daikin_f = 0xA;
    if (!strcmp(fan, "auto"))   daikin_f = 0xA;
    else if (!strcmp(fan, "low"))    daikin_f = 3;
    else if (!strcmp(fan, "medium")) daikin_f = 5;
    else if (!strcmp(fan, "high"))   daikin_f = 7;
    int state[35] = {0};
    state[0] = 0x11; state[1] = 0xDA; state[2] = 0x27;
    state[5] = 0x41 | ((daikin_m & 0x7) << 4);
    state[6] = (temp - 10) & 0x3F;
    int s1 = 0; for (int i = 0; i < 7; i++) s1 += state[i];
    state[7] = s1 & 0xFF;
    state[11] = (daikin_f & 0xF) << 4;
    int s2 = 0; for (int i = 8; i < 15; i++) s2 += state[i];
    state[15] = s2 & 0xFF;
    state[16] = 0xC0; state[21] = 0x08;
    int s3 = 0; for (int i = 16; i < 34; i++) s3 += state[i];
    state[34] = s3 & 0xFF;
    return nec_timing(state, 35, 3650, 1623, 428, 1280, 428, 29500, 1);
}

/* ─── Mitsubishi ───────────────────────────────────────────────── */
static ir_timing_t* encode_mitsubishi(int temp, const char* mode, const char* fan) {
    int mitsu_m = 0x18;
    if (!strcmp(mode, "auto"))     mitsu_m = 0x20;
    else if (!strcmp(mode, "cool"))     mitsu_m = 0x18;
    else if (!strcmp(mode, "dry"))      mitsu_m = 0x10;
    else if (!strcmp(mode, "heat"))     mitsu_m = 0x08;
    else if (!strcmp(mode, "fan_only")) mitsu_m = 0x38;
    int mitsu_f = 0;
    if (!strcmp(fan, "auto"))   mitsu_f = 0;
    else if (!strcmp(fan, "low"))    mitsu_f = 2;
    else if (!strcmp(fan, "medium")) mitsu_f = 3;
    else if (!strcmp(fan, "high"))   mitsu_f = 4;
    int state[18] = {0};
    state[0] = 0x23; state[1] = 0xCB; state[2] = 0x26; state[3] = 0x01;
    state[5] = 0x20;
    state[6] = (temp - 16) & 0x0F;
    state[7] = mitsu_m;
    state[8] = mitsu_f & 0x7;
    int sum = 0; for (int i = 0; i < 17; i++) sum += state[i];
    state[17] = sum & 0xFF;
    return nec_timing(state, 18, 3400, 1750, 450, 1300, 420, 17500, 1);
}

/* ─── Fujitsu ──────────────────────────────────────────────────── */
static ir_timing_t* encode_fujitsu(int temp, const char* mode, const char* fan) {
    int fuj_m = 1;
    if (!strcmp(mode, "auto"))     fuj_m = 0;
    else if (!strcmp(mode, "cool"))     fuj_m = 1;
    else if (!strcmp(mode, "dry"))      fuj_m = 2;
    else if (!strcmp(mode, "fan_only")) fuj_m = 3;
    else if (!strcmp(mode, "heat"))     fuj_m = 4;
    int fuj_f = 0;
    if (!strcmp(fan, "auto"))   fuj_f = 0;
    else if (!strcmp(fan, "low"))    fuj_f = 3;
    else if (!strcmp(fan, "medium")) fuj_f = 2;
    else if (!strcmp(fan, "high"))   fuj_f = 1;
    int state[16] = {0};
    state[0] = 0x14; state[1] = 0x63; state[3] = 0x10;
    state[4] = ((temp - 16) << 4) & 0xF0;
    state[5] = (fuj_m & 0x7) << 4;
    state[6] = fuj_f & 0x7;
    state[8] = 0x20;
    int sum = 0; for (int i = 0; i < 15; i++) sum += state[i];
    state[15] = sum & 0xFF;
    return nec_timing(state, 16, 3324, 1574, 448, 1188, 420, 10500, 1);
}

/* ─── Hitachi ──────────────────────────────────────────────────── */
static ir_timing_t* encode_hitachi(int temp, const char* mode, const char* fan) {
    int hit_m = 4;
    if (!strcmp(mode, "auto"))     hit_m = 2;
    else if (!strcmp(mode, "cool"))     hit_m = 4;
    else if (!strcmp(mode, "dry"))      hit_m = 5;
    else if (!strcmp(mode, "fan_only")) hit_m = 0;
    else if (!strcmp(mode, "heat"))     hit_m = 3;
    int hit_f = 1;
    if (!strcmp(fan, "auto"))   hit_f = 1;
    else if (!strcmp(fan, "low"))    hit_f = 2;
    else if (!strcmp(fan, "medium")) hit_f = 3;
    else if (!strcmp(fan, "high"))   hit_f = 5;
    int state[28] = {0};
    state[0] = 0x01; state[1] = 0x10; state[3] = 0x40;
    state[4] = 0xBF; state[5] = 0xFF; state[7] = 0xCC;
    state[8] = 0x30 | ((temp - 16) & 0x0F);
    state[9] = (hit_m & 0x7) << 4;
    state[10] = hit_f & 0x7;
    int sum = 0; for (int i = 0; i < 27; i++) sum += state[i];
    state[27] = sum & 0xFF;
    return nec_timing(state, 28, 3300, 1700, 400, 1250, 500, 44500, 1);
}

/* ─── Samsung ──────────────────────────────────────────────────── */
static ir_timing_t* encode_samsung(int temp, const char* mode, const char* fan) {
    int sam_m = 1;
    if (!strcmp(mode, "auto"))     sam_m = 0;
    else if (!strcmp(mode, "cool"))     sam_m = 1;
    else if (!strcmp(mode, "dry"))      sam_m = 2;
    else if (!strcmp(mode, "fan_only")) sam_m = 3;
    else if (!strcmp(mode, "heat"))     sam_m = 4;
    int sam_f = 0;
    if (!strcmp(fan, "auto"))   sam_f = 0;
    else if (!strcmp(fan, "low"))    sam_f = 2;
    else if (!strcmp(fan, "medium")) sam_f = 4;
    else if (!strcmp(fan, "high"))   sam_f = 5;
    int state[14] = {0};
    state[0] = 0x02; state[6] = 0x10;
    int s1_sum = 0; for (int i = 0; i < 7; i++) s1_sum += state[i];
    state[2] = (state[2] & 0xF0) | ((s1_sum >> 4) & 0x0F);
    state[1] = (state[1] & 0xF0) | (s1_sum & 0x0F);
    state[7] = 0x02;
    state[11] = ((temp - 16) & 0x0F) << 4;
    state[12] = ((sam_f & 0x7) << 4) | ((sam_m & 0x7) << 1);
    state[13] = 0x10;
    int s2_sum = 0; for (int i = 7; i < 14; i++) s2_sum += state[i];
    state[9] = (state[9] & 0xF0) | ((s2_sum >> 4) & 0x0F);
    state[8] = (state[8] & 0xF0) | (s2_sum & 0x0F);
    return nec_timing(state, 14, 4500, 4500, 590, 1690, 590, 45000, 1);
}

/* ─── Carrier ──────────────────────────────────────────────────── */
static ir_timing_t* encode_carrier(int temp, const char* mode, const char* fan) {
    int car_m = 0;
    if (!strcmp(mode, "cool"))     car_m = 0;
    else if (!strcmp(mode, "heat"))     car_m = 1;
    else if (!strcmp(mode, "fan_only")) car_m = 2;
    int f = fan_map(fan);
    int state[8] = {0};
    state[0] = 0x09;
    state[1] = (temp - 16) & 0x0F;
    state[2] = (car_m & 0x7) | ((f & 0x3) << 3);
    int sum = 0; for (int i = 0; i < 7; i++) sum += state[i];
    state[7] = (sum & 0xF) << 4;
    return nec_timing(state, 8, 4500, 4500, 570, 1670, 570, 20000, 1);
}

/* ─── LG ───────────────────────────────────────────────────────── */
static ir_timing_t* encode_lg(int temp, const char* mode, const char* fan) {
    int lg_m = 0;
    if (!strcmp(mode, "cool"))     lg_m = 0;
    else if (!strcmp(mode, "dry"))      lg_m = 1;
    else if (!strcmp(mode, "fan_only")) lg_m = 2;
    else if (!strcmp(mode, "auto"))     lg_m = 3;
    else if (!strcmp(mode, "heat"))     lg_m = 4;
    int lg_f = 5;
    if (!strcmp(fan, "auto"))   lg_f = 5;
    else if (!strcmp(fan, "low"))    lg_f = 1;
    else if (!strcmp(fan, "medium")) lg_f = 2;
    else if (!strcmp(fan, "high"))   lg_f = 10;
    int state32 = (0x88 << 20) | ((lg_m & 0x7) << 12) |
                  (((temp - 15) & 0xF) << 8) | ((lg_f & 0xF) << 4);
    int nib_sum = 0, val = state32 >> 4;
    for (int i = 0; i < 7; i++) { nib_sum += val & 0xF; val >>= 4; }
    state32 |= nib_sum & 0xF;
    int* t = alloc_timing(200);
    int pos = 0;
    t[pos++] = 8500; t[pos++] = 4250;
    for (int bp = 0; bp < 4; bp++) {
        int b = (state32 >> (24 - bp * 8)) & 0xFF;
        int bits = (bp == 0) ? 4 : 8;
        for (int bit = bits - 1; bit >= 0; bit--) {
            t[pos++] = 550;
            t[pos++] = ((b >> bit) & 1) ? 1600 : 550;
        }
    }
    t[pos++] = 550; t[pos++] = 50000;
    return make_timing(t, pos);
}

/* ─── Toshiba ──────────────────────────────────────────────────── */
static ir_timing_t* encode_toshiba(int temp, const char* mode, const char* fan) {
    int tosh_m = 1;
    if (!strcmp(mode, "auto"))     tosh_m = 0;
    else if (!strcmp(mode, "cool"))     tosh_m = 1;
    else if (!strcmp(mode, "dry"))      tosh_m = 2;
    else if (!strcmp(mode, "heat"))     tosh_m = 3;
    else if (!strcmp(mode, "fan_only")) tosh_m = 4;
    int tosh_f = 0;
    if (!strcmp(fan, "auto"))   tosh_f = 0;
    else if (!strcmp(fan, "low"))    tosh_f = 1;
    else if (!strcmp(fan, "medium")) tosh_f = 3;
    else if (!strcmp(fan, "high"))   tosh_f = 5;
    int state[9] = {0};
    state[0] = 0xF2; state[1] = 0x0D; state[2] = 0x03; state[3] = 0xFC;
    state[4] = 0x01;
    state[5] = 0x20 | ((temp - 17) & 0x1F);
    state[6] = (tosh_f & 0x7) << 3 | (tosh_m & 0x7);
    int ck = 0;
    for (int i = 0; i < 8; i++) ck ^= state[i];
    state[8] = ck;
    return nec_timing(state, 9, 4400, 4300, 540, 1620, 540, 15000, 1);
}

/* ─── Electra ──────────────────────────────────────────────────── */
static ir_timing_t* encode_electra(int temp, const char* mode, const char* fan) {
    int el_m = 1;
    if (!strcmp(mode, "auto"))     el_m = 7;
    else if (!strcmp(mode, "cool"))     el_m = 1;
    else if (!strcmp(mode, "dry"))      el_m = 2;
    else if (!strcmp(mode, "heat"))     el_m = 3;
    else if (!strcmp(mode, "fan_only")) el_m = 4;
    int el_f = 0;
    if (!strcmp(fan, "auto"))   el_f = 0;
    else if (!strcmp(fan, "low"))    el_f = 3;
    else if (!strcmp(fan, "medium")) el_f = 2;
    else if (!strcmp(fan, "high"))   el_f = 1;
    int state[13] = {0};
    state[0] = 0x09; state[1] = 0x10; state[3] = 0x20;
    state[4] = (temp - 16 + 8) & 0xFF;
    state[5] = el_m & 0x7;
    state[6] = el_f & 0x3;
    int sum = 0; for (int i = 0; i < 12; i++) sum += state[i];
    state[12] = sum & 0xFF;
    return nec_timing(state, 13, 9160, 4510, 646, 1645, 646, 20000, 1);
}

/* ─── Whirlpool ────────────────────────────────────────────────── */
static ir_timing_t* encode_whirlpool(int temp, const char* mode, const char* fan) {
    int wp_m = 2;
    if (!strcmp(mode, "heat"))     wp_m = 0;
    else if (!strcmp(mode, "auto"))     wp_m = 1;
    else if (!strcmp(mode, "cool"))     wp_m = 2;
    else if (!strcmp(mode, "dry"))      wp_m = 3;
    else if (!strcmp(mode, "fan_only")) wp_m = 4;
    int wp_f = 0;
    if (!strcmp(fan, "auto"))   wp_f = 0;
    else if (!strcmp(fan, "high"))   wp_f = 1;
    else if (!strcmp(fan, "medium")) wp_f = 2;
    else if (!strcmp(fan, "low"))    wp_f = 3;

    int state[21] = {0};
    state[0] = 0x83; state[1] = 0x06;
    state[2] = wp_f & 0x3;
    state[3] = (wp_m & 0x7) | (((temp - 18) & 0xF) << 4);
    state[6] = 0x80;

    int sum1 = 0;
    for (int i = 2; i < 13; i++) sum1 ^= state[i];
    state[13] = sum1;

    state[15] = 0x02;  /* Temp command */

    int sum2 = 0;
    for (int i = 14; i < 20; i++) sum2 ^= state[i];
    state[20] = sum2;

    /* 3-section send, repeated twice */
    int hdr_m = 9092, hdr_s = 4556;
    int bit_m = 610, one_s = 1670, zero_s = 525;
    int gap = 8030;

    int* t = alloc_timing(800);
    int pos = 0;

    for (int repeat = 0; repeat < 2; repeat++) {
        /* Section 1: header + bytes 0-5 + gap */
        t[pos++] = hdr_m; t[pos++] = hdr_s;
        for (int i = 0; i < 6; i++) {
            int b = state[i];
            for (int j = 0; j < 8; j++) {
                t[pos++] = bit_m;
                t[pos++] = (b & 1) ? one_s : zero_s;
                b >>= 1;
            }
            t[pos++] = bit_m;
        }
        t[pos++] = gap;

        /* Section 2: bytes 6-13 + gap */
        for (int i = 6; i < 14; i++) {
            int b = state[i];
            for (int j = 0; j < 8; j++) {
                t[pos++] = bit_m;
                t[pos++] = (b & 1) ? one_s : zero_s;
                b >>= 1;
            }
            t[pos++] = bit_m;
        }
        t[pos++] = gap;

        /* Section 3: bytes 14-20 */
        for (int i = 14; i < 21; i++) {
            int b = state[i];
            for (int j = 0; j < 8; j++) {
                t[pos++] = bit_m;
                t[pos++] = (b & 1) ? one_s : zero_s;
                b >>= 1;
            }
            t[pos++] = bit_m;
        }
        if (repeat == 0) t[pos++] = gap;
    }

    return make_timing(t, pos);
}

/* ─── Generic NEC fallback ─────────────────────────────────────── */
static ir_timing_t* encode_generic(int temp, const char* mode, const char* fan) {
    int m = mode_map(mode);
    int f = fan_map(fan);
    int tb = temp - 16;
    int state[4];
    state[0] = (m & 0x7) | ((f & 0x3) << 3) | ((tb & 0x1) << 6);
    state[1] = (tb >> 1) & 0xF;
    state[2] = 0x00;
    state[3] = (state[0] ^ state[1] ^ state[2]) & 0xFF;
    return nec_timing(state, 4, 9000, 4500, 560, 1690, 560, 20000, 1);
}


/* ─── Dispatch Table ───────────────────────────────────────────── */

typedef ir_timing_t* (*encoder_fn)(int temp, const char* mode, const char* fan);

typedef struct {
    const char* name;
    encoder_fn  fn;
    int         carrier_freq;
} brand_entry_t;

static const brand_entry_t BRANDS[] = {
    {"gree",        encode_gree,        38000},
    {"midea",       encode_midea,       38000},
    {"haier",       encode_haier,       38000},
    {"tcl",         encode_tcl,         38000},
    {"kelon",       encode_kelon,       38000},
    {"panasonic",   encode_panasonic,   36700},
    {"coolix",      encode_coolix,      38000},
    {"daikin",      encode_daikin,      38000},
    {"mitsubishi",  encode_mitsubishi,  38000},
    {"fujitsu",     encode_fujitsu,     38000},
    {"hitachi",     encode_hitachi,     38000},
    {"samsung",     encode_samsung,     38000},
    {"carrier",     encode_carrier,     38000},
    {"lg",          encode_lg,          38000},
    {"toshiba",     encode_toshiba,     38000},
    {"electra",     encode_electra,     38000},
    {"whirlpool",   encode_whirlpool,   38400},
    /* Legacy aliases */
    {"gree_nec_v1",      encode_gree,        38000},
    {"midea_nec_v1",     encode_midea,       38000},
    {"haier_nec_v1",     encode_haier,       38000},
    {"aux_nec_v1",       encode_gree,        38000},
    {"daikin_nec_v1",    encode_daikin,      38000},
    {"panasonic_nec_v1", encode_panasonic,   36700},
    {NULL, NULL, 0}
};

/* ─── Public API ───────────────────────────────────────────────── */

ir_timing_t* encode_ac_frame(const char* brand_code, int temperature,
                             const char* mode, const char* fan_speed) {
    if (!brand_code || !mode || !fan_speed) return NULL;
    if (temperature < 16) temperature = 16;
    if (temperature > 30) temperature = 30;

    /* Look up brand-specific encoder */
    for (int i = 0; BRANDS[i].name != NULL; i++) {
        if (!strcmp(brand_code, BRANDS[i].name)) {
            return BRANDS[i].fn(temperature, mode, fan_speed);
        }
    }

    /* Fallback: generic NEC */
    return encode_generic(temperature, mode, fan_speed);
}

int get_carrier_freq(const char* brand_code) {
    if (!brand_code) return 38000;
    for (int i = 0; BRANDS[i].name != NULL; i++) {
        if (!strcmp(brand_code, BRANDS[i].name)) {
            return BRANDS[i].carrier_freq;
        }
    }
    return 38000;
}

void free_timing(ir_timing_t* t) {
    if (t) {
        if (t->timing) free(t->timing);
        free(t);
    }
}
