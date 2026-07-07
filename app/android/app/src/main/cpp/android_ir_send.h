#pragma once
#include <vector>
#include <stdint.h>

struct ir_timing_result {
    std::vector<uint32_t> timing;
    uint32_t carrier_freq;
};

class AndroidIRsend {
public:
    AndroidIRsend();
    ~AndroidIRsend();
    ir_timing_result encodeAC(const char* brand, int temp, const char* mode, const char* fan);
    static uint32_t getCarrierFreq(const char* brand);
    class IRsend* getSender();
private:
    class IRsend* _irsend;
};
