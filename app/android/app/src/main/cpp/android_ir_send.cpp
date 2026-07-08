// Enable virtual methods + test harness (needed by IRac UNIT_TEST macro)
#define UNIT_TEST 1

#include "android_ir_send.h"
#include "arduino_stub/Arduino.h"
#include "IRremoteESP8266.h"
#include "IRsend.h"
#include "IRsend_test.h"
#include "IRutils.h"
#include "ir_Gree.h"
#include "ir_Midea.h"
#include "ir_Haier.h"
#include "ir_Tcl.h"
#include "ir_Kelvinator.h"
#include "ir_Panasonic.h"
#include "ir_Coolix.h"
#include "ir_Daikin.h"
#include "ir_Mitsubishi.h"
#include "ir_Fujitsu.h"
#include "ir_Hitachi.h"
#include "ir_Samsung.h"
#include "ir_Carrier.h"
#include "ir_LG.h"
#include "ir_Toshiba.h"
#include "ir_Electra.h"
#include "ir_Whirlpool.h"

// ─── CaptureIRsend: extends IRsendTest (which has timing capture + makeDecodeResult) ───

class CaptureIRsend : public IRsendTest {
public:
    CaptureIRsend() : IRsendTest(0, false, true) {
        timing.reserve(2048);
    }

    // Copy captured output[] to timing vector after each send
    std::vector<uint32_t> timing;
    void saveTiming() {
        timing.clear();
        // Must include output[0] — IRsendTest::mark() stores the first
        // mark there, and ConsumerIrManager expects mark/space alternating
        // starting with a mark. Skipping output[0] swaps mark↔space!
        for (uint16_t i = 0; i <= last; i++)
            timing.push_back(output[i]);
    }
};

// ─── AndroidIRsend public API ──────────────────────────────────────

AndroidIRsend::AndroidIRsend()  { _irsend = new CaptureIRsend(); }
AndroidIRsend::~AndroidIRsend() { delete static_cast<CaptureIRsend*>(_irsend); }
IRsend* AndroidIRsend::getSender() { return _irsend; }

static decode_type_t brandToProto(const char* brand) {
    struct { const char* n; decode_type_t p; } map[] = {
        {"gree",GREE},{"midea",MIDEA},{"haier",HAIER_AC},
        {"tcl",TCL112AC},{"kelon",KELON},{"panasonic",PANASONIC_AC},
        {"coolix",COOLIX},{"daikin",DAIKIN},{"mitsubishi",MITSUBISHI_AC},
        {"fujitsu",FUJITSU_AC},{"hitachi",HITACHI_AC},{"samsung",SAMSUNG_AC},
        {"carrier",CARRIER_AC},{"lg",LG},{"toshiba",TOSHIBA_AC},
        {"electra",ELECTRA_AC},{"whirlpool",WHIRLPOOL_AC},
    };
    for (auto& m : map)
        if (strcmp(brand, m.n) == 0) return m.p;
    return GREE;
}

// ─── Helper: capture timing from brand AC's internal IRsendTest ───
template<typename T>
static void captureAc(T& ac, std::vector<uint32_t>& timing) {
    timing.clear();
    for (uint16_t i = 0; i <= ac._irsend.last; i++)
        timing.push_back(ac._irsend.output[i]);
}

ir_timing_result AndroidIRsend::encodeAC(
    const char* brand, int temp, const char* mode, const char* fan, const char* subModel)
{
    ir_timing_result r;
    r.carrier_freq = 38000;

    stdAc::opmode_t m = stdAc::opmode_t::kCool;
    if (!strcmp(mode,"heat")) m=stdAc::opmode_t::kHeat;
    else if (!strcmp(mode,"dry")) m=stdAc::opmode_t::kDry;
    else if (!strcmp(mode,"fan_only")) m=stdAc::opmode_t::kFan;
    else if (!strcmp(mode,"auto")) m=stdAc::opmode_t::kAuto;

    stdAc::fanspeed_t f = stdAc::fanspeed_t::kAuto;
    if (!strcmp(fan,"low")) f=stdAc::fanspeed_t::kLow;
    else if (!strcmp(fan,"medium")) f=stdAc::fanspeed_t::kMedium;
    else if (!strcmp(fan,"high")) f=stdAc::fanspeed_t::kHigh;

    decode_type_t proto = brandToProto(brand);

    switch (proto) {
    case WHIRLPOOL_AC: {
        IRWhirlpoolAc ac(0, false, true);
        ac.begin();
        // Pick sub-model: default DG11J13A (more common), DG11J191 if specified
        if (subModel && strstr(subModel, "DG11J191"))
          ac.setModel(whirlpool_ac_remote_model_t::DG11J191);
        else
          ac.setModel(whirlpool_ac_remote_model_t::DG11J13A);
        ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFan(ac.convertFan(f)); ac.setPowerToggle(true); ac.send();
        captureAc(ac, r.timing); r.carrier_freq = 38400; break;
    }
    case GREE: {
        IRGreeAC ac(0, gree_ac_remote_model_t::YAW1F, false, true);
        ac.begin(); ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFan(ac.convertFan(f)); ac.setPower(true); ac.send();
        captureAc(ac, r.timing); break;
    }
    case MIDEA: {
        IRMideaAC ac(0, false, true);
        ac.begin(); ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFan(ac.convertFan(f)); ac.setPower(true); ac.send();
        captureAc(ac, r.timing); break;
    }
    case HAIER_AC: {
        IRHaierAC ac(0, false, true);
        ac.begin(); ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFan(ac.convertFan(f)); ac.setCommand(1); ac.send();
        captureAc(ac, r.timing); break;
    }
    case TCL112AC: {
        IRTcl112Ac ac(0, false, true);
        ac.begin(); ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFan(ac.convertFan(f)); ac.setPower(true); ac.send();
        captureAc(ac, r.timing); break;
    }
    case KELON: {
        IRKelvinatorAC ac(0, false, true);
        ac.begin(); ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        { uint8_t kfan = 3; if(f==stdAc::fanspeed_t::kLow) kfan=0; else if(f==stdAc::fanspeed_t::kMedium) kfan=1; else if(f==stdAc::fanspeed_t::kHigh) kfan=2; ac.setFan(kfan); }
        ac.setPower(true); ac.send();
        captureAc(ac, r.timing); break;
    }
    case PANASONIC_AC: {
        IRPanasonicAc ac(0, false, true);
        ac.begin(); ac.setModel(panasonic_ac_remote_model_t::kPanasonicLke);
        ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFan(ac.convertFan(f)); ac.setPower(true); ac.send();
        captureAc(ac, r.timing); r.carrier_freq = 36700; break;
    }
    case COOLIX: {
        IRCoolixAC ac(0, false, true);
        ac.begin(); ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFan(ac.convertFan(f)); ac.setPower(true); ac.send();
        captureAc(ac, r.timing); break;
    }
    case DAIKIN: {
        IRDaikinESP ac(0, false, true);
        ac.begin(); ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFan(ac.convertFan(f)); ac.setPower(true); ac.send();
        captureAc(ac, r.timing); break;
    }
    case MITSUBISHI_AC: {
        IRMitsubishiAC ac(0, false, true);
        ac.begin(); ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFan(ac.convertFan(f)); ac.setPower(true); ac.send();
        captureAc(ac, r.timing); break;
    }
    case FUJITSU_AC: {
        IRFujitsuAC ac(0, fujitsu_ac_remote_model_t::ARRAH2E, false, true);
        ac.begin(); ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFanSpeed(ac.convertFan(f)); ac.setPower(true); ac.send();
        captureAc(ac, r.timing); break;
    }
    case HITACHI_AC: {
        IRHitachiAc ac(0, false, true);
        ac.begin(); ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFan(ac.convertFan(f)); ac.setPower(true); ac.send();
        captureAc(ac, r.timing); break;
    }
    case SAMSUNG_AC: {
        IRSamsungAc ac(0, false, true);
        ac.begin(); ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFan(ac.convertFan(f)); ac.setPower(true); ac.send();
        captureAc(ac, r.timing); break;
    }
    case CARRIER_AC: {
        IRCarrierAc64 ac(0, false, true);
        ac.begin(); ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFan(ac.convertFan(f)); ac.setPower(true); ac.send();
        captureAc(ac, r.timing); break;
    }
    case LG: {
        IRLgAc ac(0, false, true);
        ac.begin(); ac.setModel(lg_ac_remote_model_t::GE6711AR2853M);
        ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFan(ac.convertFan(f)); ac.setPower(true); ac.send();
        captureAc(ac, r.timing); break;
    }
    case TOSHIBA_AC: {
        IRToshibaAC ac(0, false, true);
        ac.begin(); ac.setModel(toshiba_ac_remote_model_t::kToshibaGenericRemote_A);
        ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFan(ac.convertFan(f)); ac.setPower(true); ac.send();
        captureAc(ac, r.timing); break;
    }
    case ELECTRA_AC: {
        IRElectraAc ac(0, false, true);
        ac.begin(); ac.setMode(ac.convertMode(m)); ac.setTemp(temp);
        ac.setFan(ac.convertFan(f)); ac.setPower(true); ac.send();
        captureAc(ac, r.timing); break;
    }
    default:
        r.timing.clear(); break;
    }

    return r;
}

// ─── TV IR code database ─────────────────────────────────────────
// Cross-referenced from Flipper IRDB (Lucaslhm/Flipper-IRDB, 4200+ ⭐)
// ✅ = code confirmed in ≥2 IRDB files; ⚠️ = single file only; ❌ = placeholder
//
// Common NEC addr=0x04 pattern (used by Hisense/LG/Haier/SharpRoku):
//   power=0x08  vol+=0x02  vol-=0x03  mute=0x09  input=0x0B
//   0-9 = 0x10-0x19  ch+=0x00  ch-=0x01
//   These 19 values are CONSISTENT across all NEC 0x04 brands in IRDB.
//
// Navigation keys differ per brand (different OEM remote models).

struct TVBrand {
    const char* name;
    decode_type_t protocol;
    uint16_t address;      // NEC: 8-bit address; Sony: device(5-8bit); RC5: system(5bit)
    uint16_t power;
    uint16_t vol_up;
    uint16_t vol_down;
    uint16_t ch_up;
    uint16_t ch_down;
    uint16_t mute;
    uint16_t input;        // source/input select
    uint16_t up;
    uint16_t down;
    uint16_t left;
    uint16_t right;
    uint16_t ok;
    uint16_t menu;
    uint16_t back;
    uint16_t exit;
    uint16_t home;
    uint16_t info;
    uint16_t num[10];      // number keys 0-9
    uint8_t  nav_verified; // bitmask: 0=all fake, 1=nav OK, 2=num OK, 4=core OK
};

// Verified nav=0x00 means ALL real; 0=all fake; we use comments for clarity
#define UNVERIFIED_NAV 0

static const TVBrand TV_BRANDS[] = {
    // ── Hisense (海信) — NEC addr 0x04 — ✅ verified from IRDB (55K3201GUWUS, EN_33926A) ──
    {"hisense",     NEC,  0x04,
        0x08, 0x02, 0x03, 0x01, 0x00, 0x09, 0x0B,  // power,vol+,vol-,ch+,ch-,mute,input ✅
        0x56,0x57,0x58,0x59,0x5A, 0x5B,0x04,0x4D,0x4A,0x16,  // nav: ✅ IRDB confirmed
        {0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x18,0x19}, // ✅ IRDB confirmed
        0xFF},

    // ── Haier (海尔) — NEC addr 0x04 — ✅ verified from IRDB (Haier_L42C1180) ──
    {"haier",       NEC,  0x04,
        0x08, 0x02, 0x03, 0x01, 0x00, 0x09, 0x0B,  // power,vol+,vol-,ch+,ch-,mute,input ✅
        0x00,0x01,0x03,0x02,0x44, 0x43,0x00,0x5B,0x00,0xAA,  // nav: ✅ IRDB confirmed (no ch explicitly, vol=ch)
        {0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x18,0x19}, // ✅ IRDB confirmed
        0xFF},

    // ── LG (LG) — NEC addr 0x04 — ✅ verified from IRDB (AKB75375608, 24LJ4840, 32LF650V) ──
    {"lg",          NEC,  0x04,
        0x08, 0x02, 0x03, 0x00, 0x01, 0x09, 0x0B,  // power,vol+,vol-,ch+,ch-,mute,input ✅
        0x40,0x41,0x07,0x06,0x44, 0x00,0x28,0x5B,0x7C,0xAA,  // nav: ✅ IRDB confirmed (no menu code in IRDB)
        {0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x18,0x19}, // ✅ IRDB confirmed
        0xFF},

    // ── Sharp Roku TV — NEC addr 0x04 — ✅ verified from IRDB ──
    {"sharp",       NEC,  0x04,
        0x08, 0x02, 0x03, 0x01, 0x00, 0x09, 0x0B,  // power,vol+,vol-,ch+,ch-,mute,input ✅
        0x56,0x57,0x58,0x59,0x5A, 0x5B,0x04,0x4D,0x43,0x16,  // nav: ✅ IRDB confirmed (Hisense OEM)
        {0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x18,0x19}, // ✅ IRDB confirmed
        0xFF},

    // ── Sharp (Japan models) — NEC addr 0x28 — ⚠️ single IRDB file (g0684cesa) ──
    {"sharp_jp",    NEC,  0x28,
        0x0B, 0x0E, 0x00, 0x00, 0x00, 0x00, 0x00,  // power,vol+ only (IRDB has limited data)
        0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x00,
        {0x09,0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08}, // ⚠️ IRDB confirmed (reversed order!)
        0x04},  // only core+num verified

    // ── Sony (索尼) — SIRC 12-bit, device=0x01 — ✅ IRDB confirmed (5+ files agree) ──
    {"sony",        SONY, 0x01,
        0x15, 0x12, 0x13, 0x10, 0x11, 0x14, 0x25,  // ✅ IRDB: power,vol+,vol-,ch+,ch-,mute,input
        0x74,0x75,0x22,0x23,0x65, 0x60,0x63,0x68,0x64,0x66,  // ✅ IRDB: nav
        {0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09}, // ✅ IRDB: num
        0xFF},

    // ── Philips (飞利浦) — RC5, system=0x00 — ✅ IRDB confirmed ──
    {"philips",     RC5,  0x00,
        0x0C, 0x10, 0x11, 0x20, 0x21, 0x0D, 0x38,  // ✅ IRDB: power,vol+,vol-,ch+,ch-,mute,input
        0x30,0x31,0x32,0x33,0x34, 0x35,0x36,0x37,0x39,0x3A,  // ✅ IRDB: nav
        {0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09}, // ✅ IRDB: num
        0xFF},

    // ── Samsung (三星) — Samsung32, addr 0x07 — ✅ IRDB confirmed (5 files agree) ──
    // NOTE: Samsung32 protocol NOT yet supported by IRsend. Falls back to NEC-style.
    // TODO: Add IRsend::sendSamsung32() or use raw timing.
    {"samsung",     NEC,  0x07,  // using NEC as fallback protocol
        0x02, 0x07, 0x00, 0x00, 0x00, 0x0F, 0x01,  // power,vol+,mute,input ✅ (vol-/ch+/ch- not in IRDB)
        0x60,0x61,0x65,0x62,0x68, 0x1A,0x58,0x2D,0x00,0x1F,  // ✅ IRDB: nav (no home code)
        {0x11,0x04,0x05,0x06,0x08,0x09,0x0A,0x0C,0x0D,0x0E}, // ✅ IRDB: num (non-sequential!)
        0x05},  // core+num verified, nav partially

    // ── TCL — RCA protocol — ✅ IRDB confirmed (3 files) ──
    // NOTE: RCA protocol NOT yet supported by IRsend. Falls back to NEC.
    {"tcl",         NEC,  0x0F,  // using NEC as fallback for RCA protocol
        0x54, 0xF4, 0x00, 0x00, 0x00, 0xFC, 0xC5,  // power,vol+,mute,input ✅
        0x9A,0x1A,0x6A,0xEA,0x2F, 0x10,0xE4,0x60,0x10,0x3C,  // ✅ IRDB: nav (menu=0x10, home=0x10 same)
        {0x0C,0x8C,0x4C,0xCC,0x2C,0xAC,0x6C,0xEC,0x1C,0x9C}, // ✅ IRDB: num
        0xFF},

    // ═══════════════════════════════════════════════════════════════
    // Below: UNVERIFIED brands — NOT in Flipper-IRDB or only guessed.
    // Codes MAY work if your TV uses the same OEM remote.
    // ═══════════════════════════════════════════════════════════════

    // ── Skyworth (创维) — ⚠️ NOT in IRDB, codes are guesses ──
    {"skyworth",    NEC,  0x00,
        0x0C, 0x0D, 0x0E, 0x01, 0x02, 0x0B, 0x0F,  // core: guessed
        0x10,0x11,0x12,0x13,0x14, 0x15,0x16,0x17,0x18,0x19,  // nav: 🚫 fake placeholder
        {0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x00}, // num: 🚫 fake placeholder
        0x04},  // only core possibly real

    // ── Changhong (长虹) — ✅ IRDB Codeset1 + Codeset2, user-tested ──
    // Source: Flipper-IRDB _Converted_/IR_Plus/C/CHANGHONG/Codeset1.ir + Codeset2.ir
    // Two codesets exist. User TV: Codeset1 base, vol from Codeset2 (Codeset1 vol beeps but no effect).
    // Keys NOT in either codeset (marked 🚫): up/down/left/right/back/home/mute
    {"changhong",   NEC,  0x40,
        0x12, 0x1A, 0x1E, 0x19, 0x1D, 0x13, 0x14,  // ✅ power,vol+✅C2,vol-✅C2,ch+✅C1,ch-✅C1,mute🚫guess,input✅
        0x00,0x00,0x00,0x00,0x0A, 0x5B,0x00,0x44,0x00,0x16,  // up🚫 down🚫 left🚫 right🚫 ok✅=0x0A menu✅=0x5B back🚫 exit✅=0x44 home🚫 info✅=0x16
        {0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09}, // ✅ IRDB verified, both codesets
        0x37},  // core+num+partial nav verified (ok/menu/exit/info real, rest unknown)

    // ── Konka (康佳) — ⚠️ NOT in IRDB ──
    {"konka",       NEC,  0x00,
        0x01, 0x02, 0x03, 0x04, 0x05, 0x14, 0x08,  // core: guessed
        0x06,0x07,0x08,0x09,0x0A, 0x0B,0x0C,0x0D,0x0E,0x0F,  // nav: 🚫 fake (left=0x08=input!)
        {0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x18,0x19}, // num: 🚫 fake placeholder
        0x04},

    // ── Xiaomi (小米) — ✅ IRDB TV 4S, NEC addr 0x86 ──
    // Source: Flipper-IRDB _Converted_/IR_Plus/X/XIAOMI/TV 4S.ir
    // Note: POWER uses addr=0x3C (separate from main addr=0x86). Handled in encodeTV.
    // Missing: up/down/left/right (unknown labels in IRDB)
    {"xiaomi",      NEC,  0x86,
        0xCC, 0x0E, 0x0F, 0xAA, 0xAB, 0xA1, 0x01,  // ✅ IRDB: power(G),vol+,vol-,ch+,ch-,mute✅,input✅
        0x00,0x00,0x00,0x00,0x0D, 0xA4,0x07,0x00,0x00,0xAC,  // up🚫 down🚫 left🚫 right🚫 ok✅=0x0D menu🚫(SETTINGS) back✅=0x07 exit🚫 home🚫 info✅=0xAC
        {0xCA,0xC1,0xC2,0xC3,0xC4,0xC5,0xC6,0xC7,0xC8,0xC9}, // ✅ IRDB: 0-9 (non-sequential!)
        0x37},  // core+num+ok/back/info/mute verified, nav/menu/home unknown

    {nullptr, NEC, 0, 0,0,0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,0, {0}},
};

static const TVBrand* findTVBrand(const char* brand) {
    for (const auto& b : TV_BRANDS)
        if (b.name && strcmp(brand, b.name) == 0) return &b;
    return &TV_BRANDS[0]; // default: hisense
}

ir_timing_result AndroidIRsend::encodeTV(const char* brand, const char* command) {
    ir_timing_result r;
    r.carrier_freq = 38000;

    const TVBrand* tv = findTVBrand(brand);
    CaptureIRsend* s = static_cast<CaptureIRsend*>(_irsend);
    s->reset();

    // Determine command code
    uint16_t cmd = tv->power; // default
    if (!strcmp(command, "power"))        cmd = tv->power;
    else if (!strcmp(command, "vol_up"))   cmd = tv->vol_up;
    else if (!strcmp(command, "vol_down")) cmd = tv->vol_down;
    else if (!strcmp(command, "ch_up"))    cmd = tv->ch_up;
    else if (!strcmp(command, "ch_down"))  cmd = tv->ch_down;
    else if (!strcmp(command, "mute"))     cmd = tv->mute;
    else if (!strcmp(command, "input"))    cmd = tv->input;
    else if (!strcmp(command, "up"))       cmd = tv->up;
    else if (!strcmp(command, "down"))     cmd = tv->down;
    else if (!strcmp(command, "left"))     cmd = tv->left;
    else if (!strcmp(command, "right"))    cmd = tv->right;
    else if (!strcmp(command, "ok"))       cmd = tv->ok;
    else if (!strcmp(command, "menu"))     cmd = tv->menu;
    else if (!strcmp(command, "back"))     cmd = tv->back;
    else if (!strcmp(command, "exit"))     cmd = tv->exit;
    else if (!strcmp(command, "home"))     cmd = tv->home;
    else if (!strcmp(command, "info"))     cmd = tv->info;
    else if (command[0] >= '0' && command[0] <= '9')
        cmd = tv->num[command[0] - '0'];

    // Send via IRremoteESP8266 protocol sender
    switch (tv->protocol) {
    case NEC: {
        // encodeNEC handles LSB-first bit reversal that NEC requires.
        // Xiaomi TV 4S: POWER uses addr=0x3C, all other keys use addr=0x86
        uint8_t addr = tv->address & 0xFF;
        if (!strcmp(brand, "xiaomi") && !strcmp(command, "power"))
            addr = 0x3C;
        uint32_t data = s->encodeNEC(addr, cmd & 0xFF);
        s->sendNEC(data);
        break;
    }
    case SONY: {
        // Sony SIRC 12-bit: 7-bit command (MSB) + 5-bit device (LSB)
        uint64_t sonyData = ((uint64_t)(cmd & 0x7F) << 5) | (tv->address & 0x1F);
        s->sendSony(sonyData, 12, 2);
        break;
    }
    case RC5:
        s->sendRC5((tv->address << 6) | (cmd & 0x3F), 12);
        break;
    default:
        s->sendNEC(s->encodeNEC(0x00, 0x12));
        break;
    }

    s->saveTiming();

    // ── Append NEC repeat frame for reliability ──
    // Many TVs require the command to be repeated to reliably register.
    // NEC repeat: 40ms gap + 9ms mark + 2.25ms space + 560µs stop bit.
    if (tv->protocol == NEC && !s->timing.empty()) {
        s->timing.push_back(40000);  // 40ms space before repeat
        s->timing.push_back(9000);   // repeat header mark
        s->timing.push_back(2250);   // repeat header space
        s->timing.push_back(560);    // repeat stop bit
    }

    r.timing = s->timing;
    return r;
}

uint32_t AndroidIRsend::getCarrierFreq(const char* brand) {
    if (!strcmp(brand,"panasonic")) return 36700;
    if (!strcmp(brand,"whirlpool")) return 38400;
    return 38000;
}
