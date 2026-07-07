cmake_minimum_required(VERSION 3.22.1)
project("natrl_ir")

# Path to real IRremoteESP8266 source (git submodule)
set(IR_ESP_SRC "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../../firmware/IRremoteESP8266/src")

# Include paths: our Arduino stub first (shadows real Arduino.h), then IRremoteESP8266 src
include_directories(
    "${CMAKE_CURRENT_SOURCE_DIR}/arduino_stub"
    "${CMAKE_CURRENT_SOURCE_DIR}/arduino_stub/driver"
    "${IR_ESP_SRC}"
)

# Compile ALL .cpp files from IRremoteESP8266 src/
file(GLOB IR_SOURCES "${IR_ESP_SRC}/*.cpp")

# Our code
set(NATRL_SOURCES
    android_ir_send.cpp
    jni_encoder.cpp
)

# Build shared library
add_library(natrl_ir SHARED
    ${NATRL_SOURCES}
    ${IR_SOURCES}
)

target_compile_options(natrl_ir PRIVATE -Wall -O2 -fPIC -fexceptions -frtti -std=c++17)
