package com.anonymous.natrlremote.voice

import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * In-app voice recognition using Android SpeechRecognizer API.
 * No system dialog, no IME dependency. Works on Chinese phones using
 * the manufacturer's built-in speech engine (Xiaomi/Huawei/OPPO etc.).
 */
class VoiceRecognitionModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var recognizer: SpeechRecognizer? = null
    private var listening = false

    override fun getName(): String = "VoiceRecognition"

    private fun sendEvent(eventName: String, params: WritableMap?) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params ?: Arguments.createMap())
    }

    @ReactMethod
    fun isAvailable(promise: Promise) {
        val ok = SpeechRecognizer.isRecognitionAvailable(reactApplicationContext)
        promise.resolve(ok)
    }

    @ReactMethod
    fun startListening(lang: String, promise: Promise) {
        if (listening) {
            recognizer?.cancel()
        }

        try {
            recognizer = SpeechRecognizer.createSpeechRecognizer(reactApplicationContext)
        } catch (e: Exception) {
            promise.reject("NO_ENGINE", "语音引擎不可用")
            return
        }

        recognizer?.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                sendEvent("voiceStart", null)
            }

            override fun onBeginningOfSpeech() {}

            override fun onRmsChanged(rmsdB: Float) {}

            override fun onBufferReceived(buffer: ByteArray?) {}

            override fun onEndOfSpeech() {
                sendEvent("voiceEnd", null)
            }

            override fun onError(error: Int) {
                listening = false
                recognizer?.destroy()
                recognizer = null
                val msg = when (error) {
                    SpeechRecognizer.ERROR_AUDIO -> "麦克风错误"
                    SpeechRecognizer.ERROR_CLIENT -> "客户端错误"
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "权限不足"
                    SpeechRecognizer.ERROR_NETWORK -> "网络错误"
                    SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "网络超时"
                    SpeechRecognizer.ERROR_NO_MATCH -> "未识别到语音"
                    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "引擎繁忙"
                    SpeechRecognizer.ERROR_SERVER -> "服务端错误"
                    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "语音超时"
                    else -> "未知错误($error)"
                }
                val params = Arguments.createMap()
                params.putString("error", msg)
                sendEvent("voiceError", params)
            }

            override fun onResults(results: Bundle?) {
                listening = false
                recognizer?.destroy()
                recognizer = null
                val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                if (matches != null && matches.isNotEmpty()) {
                    val params = Arguments.createMap()
                    params.putString("transcript", matches[0])
                    params.putBoolean("isFinal", true)
                    sendEvent("voiceResult", params)
                }
            }

            override fun onPartialResults(partialResults: Bundle?) {
                val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                if (matches != null && matches.isNotEmpty()) {
                    val params = Arguments.createMap()
                    params.putString("transcript", matches[0])
                    params.putBoolean("isFinal", false)
                    sendEvent("voiceResult", params)
                }
            }

            override fun onEvent(eventType: Int, params: Bundle?) {}
        })

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, if (lang.isNotEmpty()) lang else "zh-CN")
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "zh-CN")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
        }

        listening = true
        recognizer?.startListening(intent)
        promise.resolve(true)
    }

    @ReactMethod
    fun stopListening(promise: Promise) {
        listening = false
        recognizer?.stopListening()
        recognizer?.destroy()
        recognizer = null
        promise.resolve(true)
    }

    @ReactMethod
    fun cancel(promise: Promise) {
        listening = false
        recognizer?.cancel()
        recognizer?.destroy()
        recognizer = null
        promise.resolve(true)
    }
}
