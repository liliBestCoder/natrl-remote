#include "android_ir_send.h"
#include "arduino_stub/Arduino.h"
#include "IRremoteESP8266.h"
#include "IRsend.h"
#include "IRac.h"
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

// ─── CaptureIRsend: IRsend subclass that collects timing into vector ───

class CaptureIRsend : public IRsend {
public:
    std::vector<uint32_t> timing;

    CaptureIRsend() : IRsend(0, false, true), _on(false) {
        timing.reserve(2048);
    }

    void _delayMicroseconds(uint32_t usec) override {
        if (usec > 0) timing.push_back(usec);
    }

    void ledOn()  override { _on = true; }
    void ledOff() override { _on = false; }

private:
    bool _on;
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

ir_timing_result AndroidIRsend::encodeAC(
    const char* brand, int temp, const char* mode, const char* fan)
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

    CaptureIRsend* s = static_cast<CaptureIRsend*>(_irsend);
    s->timing.clear();

    IRac ac(0);
    ac.next.protocol = brandToProto(brand);
    ac.next.model = 1;
    ac.next.mode = m;
    ac.next.degrees = temp;
    ac.next.fanspeed = f;
    ac.next.power = true;
    ac.sendAc();

    r.timing = s->timing;
    if (!strcmp(brand,"panasonic")) r.carrier_freq = 36700;
    if (!strcmp(brand,"whirlpool")) r.carrier_freq = 38400;
    return r;
}

uint32_t AndroidIRsend::getCarrierFreq(const char* brand) {
    if (!strcmp(brand,"panasonic")) return 36700;
    if (!strcmp(brand,"whirlpool")) return 38400;
    return 38000;
}
