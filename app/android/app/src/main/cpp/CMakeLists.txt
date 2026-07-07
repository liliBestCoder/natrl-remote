cmake_minimum_required(VERSION 3.22.1)

project("natrl_ir")

# Build the native IR encoder library
add_library(natrl_ir SHARED
    natrl_ir.c
    jni_bridge.c
)

# Link against JNI and log
find_library(log-lib log)

target_link_libraries(natrl_ir
    ${log-lib}
)

# Compiler flags
target_compile_options(natrl_ir PRIVATE
    -Wall
    -O2
    -fPIC
)
