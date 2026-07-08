package com.anonymous.natrlremote.voice

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * In-app voice recognition using Baidu ASR API (百度语音识别).
 * Records PCM audio via AudioRecord, sends to Baidu cloud for transcription.
 * No system dialog, no Google service, no SpeechRecognizer engine required.
 * Works on ANY Android phone — only needs network + RECORD_AUDIO permission.
 */
class VoiceRecognitionModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "VoiceRecognition"

    // ── Baidu API credentials ──
    companion object {
        private const val BAIDU_API_KEY    = "YAUD6UJivnilszsUd4Xgbhif"
        private const val BAIDU_SECRET_KEY = "2JiLRJMzmn9u5DAqlw9OmgioXkXJLIBw"
        private const val TOKEN_URL  = "https://aip.baidubce.com/oauth/2.0/token"
        private const val ASR_URL    = "https://vop.baidu.com/server_api"
        private const val DEV_PID    = 80001  // 极速版 普通话, 精度更高
    }

    // ── State ──
    private var recording = false
    private var recordThread: Thread? = null
    private var audioData: ByteArray? = null
    private var cachedToken: String? = null
    private var tokenExpiry: Long = 0

    // ── AudioRecord config ──
    private val sampleRate = 16000
    private val channelConfig = AudioFormat.CHANNEL_IN_MONO
    private val audioFormat = AudioFormat.ENCODING_PCM_16BIT
    private val minBufSize: Int by lazy {
        AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
    }

    private fun sendEvent(eventName: String, params: WritableMap?) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params ?: Arguments.createMap())
    }

    // ═══════════════════════════════════════════════════════════════
    //  Public API (exposed to JS via @ReactMethod)
    // ═══════════════════════════════════════════════════════════════

    @ReactMethod
    fun isAvailable(promise: Promise) {
        // Baidu ASR is always available — needs only network + permission.
        promise.resolve(true)
    }

    @ReactMethod
    fun startListening(lang: String, promise: Promise) {
        if (recording) {
            recordThread?.interrupt()
            recording = false
        }

        try {
            val recorder = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate, channelConfig, audioFormat,
                minBufSize * 4
            )

            if (recorder.state != AudioRecord.STATE_INITIALIZED) {
                promise.reject("RECORDER_ERROR", "麦克风初始化失败")
                return
            }

            recording = true
            val buf = ByteArray(minBufSize)
            val output = ByteArrayOutputStream()

            recorder.startRecording()
            sendEvent("voiceStart", null)

            recordThread = thread {
                try {
                    while (recording && !Thread.currentThread().isInterrupted) {
                        val n = recorder.read(buf, 0, buf.size)
                        if (n > 0) output.write(buf, 0, n)
                        else if (n == AudioRecord.ERROR_INVALID_OPERATION) break
                    }
                } catch (_: Exception) {
                } finally {
                    try { recorder.stop(); recorder.release() } catch (_: Exception) {}
                    audioData = output.toByteArray()
                    try { output.close() } catch (_: Exception) {}
                }
            }

            promise.resolve(true)
        } catch (e: SecurityException) {
            promise.reject("PERMISSION", "麦克风权限未授权")
        } catch (e: Exception) {
            promise.reject("RECORDER_ERROR", e.message ?: "录音启动失败")
        }
    }

    @ReactMethod
    fun stopListening(promise: Promise) {
        recording = false
        recordThread?.interrupt()
        recordThread?.join(2000)

        val data = audioData
        audioData = null

        if (data == null || data.size < 1600) { // < 100ms
            val err = Arguments.createMap()
            err.putString("error", "录音太短或无声音")
            sendEvent("voiceError", err)
            promise.resolve(false)
            return
        }

        thread {
            try {
                val token = getAccessToken()
                val text = callBaiduASR(token, data)
                val params = Arguments.createMap()
                params.putString("transcript", text)
                params.putBoolean("isFinal", true)
                sendEvent("voiceResult", params)
                promise.resolve(true)
            } catch (e: Exception) {
                val err = Arguments.createMap()
                err.putString("error", e.message ?: "语音识别失败")
                sendEvent("voiceError", err)
                promise.resolve(false)
            }
        }
    }

    @ReactMethod
    fun cancel(promise: Promise) {
        recording = false
        recordThread?.interrupt()
        audioData = null
        promise.resolve(true)
    }

    // ═══════════════════════════════════════════════════════════════
    //  Baidu ASR HTTP API
    // ═══════════════════════════════════════════════════════════════

    @Synchronized
    private fun getAccessToken(): String {
        if (cachedToken != null && System.currentTimeMillis() < tokenExpiry - 3600_000) {
            return cachedToken!!
        }

        val url = URL(
            "$TOKEN_URL?grant_type=client_credentials" +
            "&client_id=$BAIDU_API_KEY" +
            "&client_secret=$BAIDU_SECRET_KEY"
        )
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 10000
        conn.readTimeout = 10000

        val text = conn.inputStream.bufferedReader().readText()
        conn.disconnect()

        val json = JSONObject(text)
        if (json.has("error")) {
            throw RuntimeException("Token获取失败: ${json.optString("error_description", text)}")
        }

        cachedToken = json.getString("access_token")
        tokenExpiry = System.currentTimeMillis() + json.optInt("expires_in", 2592000) * 1000L
        return cachedToken!!
    }

    private fun callBaiduASR(token: String, pcmData: ByteArray): String {
        val url = URL("$ASR_URL?dev_pid=$DEV_PID&cuid=${getCUID()}&token=$token")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 15000
        conn.readTimeout = 15000
        conn.setRequestProperty("Content-Type", "audio/pcm;rate=$sampleRate;channel=1")

        val os: OutputStream = conn.outputStream
        os.write(pcmData)
        os.flush()
        os.close()

        val code = conn.responseCode
        val body = if (code == 200)
            conn.inputStream.bufferedReader().readText()
        else
            conn.errorStream?.bufferedReader()?.readText() ?: "HTTP $code"
        conn.disconnect()

        val json = JSONObject(body)
        val errNo = json.optInt("err_no", -1)
        if (errNo != 0) {
            val msg = json.optString("err_msg", "未知错误")
            throw RuntimeException("百度ASR[$errNo]: $msg")
        }

        val results = json.optJSONArray("result")
        if (results == null || results.length() == 0) {
            throw RuntimeException("未识别到语音")
        }

        return results.getString(0)
    }

    private fun getCUID(): String = try {
        android.provider.Settings.Secure.getString(
            reactApplicationContext.contentResolver,
            android.provider.Settings.Secure.ANDROID_ID
        ) ?: "natrl-${Build.MODEL}"
    } catch (_: Exception) { "natrl-${Build.MODEL}" }
}
