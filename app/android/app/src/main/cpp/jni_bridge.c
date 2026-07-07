/**
 * jni_bridge.c — JNI bridge for natrl_ir native library.
 *
 * Exposes encode_ac_frame() and get_carrier_freq() to Java/Kotlin
 * via JNI, so React Native can call them through a native module.
 */
#include <jni.h>
#include <string.h>
#include "natrl_ir.h"

/* Package: com.anonymous.natrlremote.ir */
#define JNI_PREFIX(pre) Java_com_anonymous_natrlremote_ir_InfraredEncoderModule_##pre

JNIEXPORT jobject JNICALL
JNI_PREFIX(nativeEncode)(JNIEnv* env, jobject thiz,
                          jstring brandCode, jint temperature,
                          jstring mode, jstring fanSpeed) {
    const char* bc = (*env)->GetStringUTFChars(env, brandCode, NULL);
    const char* m  = (*env)->GetStringUTFChars(env, mode, NULL);
    const char* fs = (*env)->GetStringUTFChars(env, fanSpeed, NULL);

    ir_timing_t* t = encode_ac_frame(bc, temperature, m, fs);
    int freq = get_carrier_freq(bc);

    (*env)->ReleaseStringUTFChars(env, brandCode, bc);
    (*env)->ReleaseStringUTFChars(env, mode, m);
    (*env)->ReleaseStringUTFChars(env, fanSpeed, fs);

    if (!t) {
        /* Return null on error */
        return NULL;
    }

    /* Build result: { carrierFreq: int, pattern: int[] } */
    jclass hashMapClass = (*env)->FindClass(env, "java/util/HashMap");
    jmethodID init = (*env)->GetMethodID(env, hashMapClass, "<init>", "()V");
    jmethodID put = (*env)->GetMethodID(env, hashMapClass, "put",
        "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
    jobject result = (*env)->NewObject(env, hashMapClass, init);

    /* Put carrierFreq */
    jclass intClass = (*env)->FindClass(env, "java/lang/Integer");
    jmethodID intInit = (*env)->GetMethodID(env, intClass, "<init>", "(I)V");
    jobject freqObj = (*env)->NewObject(env, intClass, intInit, freq);
    jstring freqKey = (*env)->NewStringUTF(env, "carrierFreq");
    (*env)->CallObjectMethod(env, result, put, freqKey, freqObj);

    /* Put pattern (int[]) */
    jintArray pattern = (*env)->NewIntArray(env, t->length);
    (*env)->SetIntArrayRegion(env, pattern, 0, t->length, (jint*)t->timing);
    jstring patKey = (*env)->NewStringUTF(env, "pattern");
    (*env)->CallObjectMethod(env, result, put, patKey, pattern);

    free_timing(t);
    return result;
}

JNIEXPORT jint JNICALL
JNI_PREFIX(nativeGetCarrierFreq)(JNIEnv* env, jobject thiz, jstring brandCode) {
    const char* bc = (*env)->GetStringUTFChars(env, brandCode, NULL);
    int freq = get_carrier_freq(bc);
    (*env)->ReleaseStringUTFChars(env, brandCode, bc);
    return freq;
}
