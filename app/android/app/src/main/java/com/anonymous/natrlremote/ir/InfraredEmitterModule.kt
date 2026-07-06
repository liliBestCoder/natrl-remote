package com.anonymous.natrlremote.ir

import android.content.Context
import android.hardware.ConsumerIrManager
import com.facebook.react.bridge.*

class InfraredEmitterModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var irManager: ConsumerIrManager? = null

    override fun getName(): String = "InfraredEmitter"

    init {
        reactContext.getSystemService(Context.CONSUMER_IR_SERVICE)?.let {
            irManager = it as ConsumerIrManager
        }
    }

    @ReactMethod
    fun hasIrEmitter(promise: Promise) {
        try {
            val hasIr = irManager?.hasIrEmitter() ?: false
            promise.resolve(hasIr)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun transmit(carrierFrequency: Int, pattern: ReadableArray, promise: Promise) {
        try {
            val mgr = irManager
            if (mgr == null || !mgr.hasIrEmitter()) {
                promise.resolve(false)
                return
            }

            // Convert ReadableArray to int[]
            val patternInt = IntArray(pattern.size())
            for (i in 0 until pattern.size()) {
                patternInt[i] = pattern.getInt(i)
            }

            mgr.transmit(carrierFrequency, patternInt)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }
}
