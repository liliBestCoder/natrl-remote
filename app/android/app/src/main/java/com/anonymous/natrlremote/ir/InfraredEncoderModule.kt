package com.anonymous.natrlremote.ir

import com.facebook.react.bridge.*
import java.util.*

/**
 * InfraredEncoderModule — JNI bridge to libnatrl_ir.so
 *
 * Compiled from IRremoteESP8266 C++ source, ported to C.
 * Encodes AC IR frames locally on the phone using brand-specific algorithms.
 *
 * Exposed to React Native as NativeModules.InfraredEncoder:
 *   encode(brandCode, temperature, mode, fanSpeed) -> { carrierFreq: Int, pattern: IntArray }
 *   getCarrierFreq(brandCode) -> Int
 */
class InfraredEncoderModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        init {
            System.loadLibrary("natrl_ir")
        }
    }

    override fun getName(): String = "InfraredEncoder"

    /** Native method declarations — implemented in jni_bridge.c */
    private external fun nativeEncode(
        brandCode: String, temperature: Int, mode: String, fanSpeed: String
    ): java.util.HashMap<String, Any>?

    private external fun nativeGetCarrierFreq(brandCode: String): Int

    /**
     * Encode an AC IR frame locally.
     *
     * @param brandCode   e.g. "gree", "midea", "daikin"
     * @param temperature 16-30
     * @param mode        "cool", "heat", "dry", "fan_only", "auto"
     * @param fanSpeed    "auto", "low", "medium", "high"
     * @return WritableMap with { carrierFreq: Int, pattern: IntArray }
     */
    @ReactMethod
    fun encode(brandCode: String, temperature: Int, mode: String, fanSpeed: String, promise: Promise) {
        try {
            val result = nativeEncode(brandCode, temperature, mode, fanSpeed)
            if (result == null) {
                promise.reject("ENCODE_ERROR", "Failed to encode IR frame")
                return
            }
            val map = Arguments.createMap()
            map.putInt("carrierFreq", (result["carrierFreq"] as Int?) ?: 38000)
            map.putArray("pattern", Arguments.fromArray(result["pattern"] as IntArray))
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("ENCODE_ERROR", "IR encoding failed: ${e.message}")
        }
    }

    @ReactMethod
    fun getCarrierFreq(brandCode: String, promise: Promise) {
        try {
            promise.resolve(nativeGetCarrierFreq(brandCode))
        } catch (e: Exception) {
            promise.resolve(38000)
        }
    }
}
