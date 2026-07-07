#include <jni.h>
#include <string.h>
#include "android_ir_send.h"

extern "C" {

JNIEXPORT jobject JNICALL
Java_com_anonymous_natrlremote_ir_InfraredEncoderModule_nativeEncode(
    JNIEnv* env, jobject, jstring brand, jint temp, jstring mode, jstring fan)
{
    const char* bc = env->GetStringUTFChars(brand, nullptr);
    const char* m  = env->GetStringUTFChars(mode, nullptr);
    const char* fs = env->GetStringUTFChars(fan, nullptr);

    AndroidIRsend sender;
    ir_timing_result r = sender.encodeAC(bc, temp, m, fs);
    uint32_t freq = sender.getCarrierFreq(bc);

    env->ReleaseStringUTFChars(brand, bc);
    env->ReleaseStringUTFChars(mode, m);
    env->ReleaseStringUTFChars(fan, fs);

    // Build HashMap result
    jclass mapClass = env->FindClass("java/util/HashMap");
    jmethodID init = env->GetMethodID(mapClass, "<init>", "()V");
    jmethodID put = env->GetMethodID(mapClass, "put",
        "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
    jobject result = env->NewObject(mapClass, init);

    jclass intClass = env->FindClass("java/lang/Integer");
    jmethodID intInit = env->GetMethodID(intClass, "<init>", "(I)V");

    jobject freqObj = env->NewObject(intClass, intInit, (jint)freq);
    env->CallObjectMethod(result, put, env->NewStringUTF("carrierFreq"), freqObj);

    jintArray pattern = env->NewIntArray(r.timing.size());
    env->SetIntArrayRegion(pattern, 0, r.timing.size(), (jint*)r.timing.data());
    env->CallObjectMethod(result, put, env->NewStringUTF("pattern"), pattern);

    return result;
}

JNIEXPORT jint JNICALL
Java_com_anonymous_natrlremote_ir_InfraredEncoderModule_nativeGetCarrierFreq(
    JNIEnv* env, jobject, jstring brand)
{
    const char* bc = env->GetStringUTFChars(brand, nullptr);
    uint32_t freq = AndroidIRsend::getCarrierFreq(bc);
    env->ReleaseStringUTFChars(brand, bc);
    return (jint)freq;
}

// TV encoding JNI
JNIEXPORT jobject JNICALL
Java_com_anonymous_natrlremote_ir_InfraredEncoderModule_nativeEncodeTV(
    JNIEnv* env, jobject, jstring brand, jstring command)
{
    const char* bc = env->GetStringUTFChars(brand, nullptr);
    const char* cmd = env->GetStringUTFChars(command, nullptr);

    AndroidIRsend sender;
    ir_timing_result r = sender.encodeTV(bc, cmd);

    env->ReleaseStringUTFChars(brand, bc);
    env->ReleaseStringUTFChars(command, cmd);

    jclass mapClass = env->FindClass("java/util/HashMap");
    jmethodID init = env->GetMethodID(mapClass, "<init>", "()V");
    jmethodID put = env->GetMethodID(mapClass, "put",
        "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
    jobject result = env->NewObject(mapClass, init);

    jclass intClass = env->FindClass("java/lang/Integer");
    jmethodID intInit = env->GetMethodID(intClass, "<init>", "(I)V");

    jobject freqObj = env->NewObject(intClass, intInit, (jint)r.carrier_freq);
    env->CallObjectMethod(result, put, env->NewStringUTF("carrierFreq"), freqObj);

    jintArray pattern = env->NewIntArray(r.timing.size());
    env->SetIntArrayRegion(pattern, 0, r.timing.size(), (jint*)r.timing.data());
    env->CallObjectMethod(result, put, env->NewStringUTF("pattern"), pattern);

    return result;
}

} // extern "C"
