package com.anonymous.natrlremote.voice

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import com.facebook.react.bridge.*
import java.util.*

class VoiceRecognitionModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    companion object {
        private const val REQUEST_CODE = 9001
    }

    private var voicePromise: Promise? = null
    private var pendingActivityResult: Boolean = false

    override fun getName(): String = "VoiceRecognition"

    init {
        reactContext.addActivityEventListener(this)
    }

    @ReactMethod
    fun startListening(lang: String, promise: Promise) {
        val activity = currentActivity
        if (activity == null) {
            promise.reject("NO_ACTIVITY", "Activity not available")
            return
        }
        if (voicePromise != null) {
            voicePromise?.reject("CANCELLED", "New request started")
        }
        voicePromise = promise
        pendingActivityResult = true

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, if (lang.isNotEmpty()) lang else "zh-CN")
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "zh-CN")
            putExtra(RecognizerIntent.EXTRA_PROMPT, "请说话...")
        }

        try {
            activity.startActivityForResult(intent, REQUEST_CODE)
        } catch (e: Exception) {
            pendingActivityResult = false
            voicePromise?.reject("NO_ENGINE", "设备不支持语音识别: ${e.message}")
            voicePromise = null
        }
    }

    @ReactMethod
    fun isAvailable(promise: Promise) {
        val activity = currentActivity ?: run { promise.resolve(false); return }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        val activities = activity.packageManager.queryIntentActivities(intent, 0)
        promise.resolve(activities.isNotEmpty())
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST_CODE || !pendingActivityResult) return
        pendingActivityResult = false
        val promise = voicePromise
        voicePromise = null
        if (resultCode == Activity.RESULT_OK && data != null) {
            val results = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            if (results != null && results.isNotEmpty()) {
                val map = Arguments.createMap()
                map.putString("transcript", results[0])
                map.putBoolean("isFinal", true)
                promise?.resolve(map)
                return
            }
        }
        promise?.reject("CANCELLED", "用户取消或未识别")
    }

    override fun onNewIntent(intent: Intent?) {}
}
