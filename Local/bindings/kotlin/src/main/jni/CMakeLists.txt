# The Android JNI shim for Despia Local.
#
# Copyright Despia. Licensed under the Apache License, Version 2.0.
#
# It builds the package's OWN CMakeLists as a subdirectory rather than restating
# any of it here. That matters more than it looks: the export map, the hidden
# default visibility, the SQLITE_* build defines and the 16 KiB page-size floor
# all live in the package CMakeLists, and a second recipe for the same library is
# a second thing to keep honest - the day it drifts, the Android build is the one
# that quietly starts exporting sqlite3_* into a process a sync vendor also lives
# in.
#
# The shim itself is the SAME source the JVM lane compiles
# (bindings/kotlin-jvm/src/main/jni/despia_local_jni.cpp), so the two Kotlin faces
# reach the ABI through one translation unit instead of two that agree by
# inspection.

cmake_minimum_required(VERSION 3.22)
project(despia_local_jni LANGUAGES CXX)

set(DESPIA_LOCAL_PACKAGE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../..")

# The library itself: vectors ON, the ABI test OFF (it is a host-side executable
# and has no business in an app's jniLibs).
set(DESPIA_LOCAL_VEC ON CACHE BOOL "" FORCE)
set(DESPIA_LOCAL_BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory("${DESPIA_LOCAL_PACKAGE_ROOT}" despia_local_build)

add_library(despia_local_jni SHARED
    "${DESPIA_LOCAL_PACKAGE_ROOT}/bindings/kotlin-jvm/src/main/jni/despia_local_jni.cpp")

target_include_directories(despia_local_jni
    PRIVATE "${DESPIA_LOCAL_PACKAGE_ROOT}/engine/include")

# Linked against the SHARED library, so this translation unit can only reach the
# eight exported symbols. A binding that started needing a ninth would fail to
# link here rather than quietly widening the surface.
target_link_libraries(despia_local_jni PRIVATE despia_local)

set_target_properties(despia_local_jni PROPERTIES CXX_VISIBILITY_PRESET hidden)

if(ANDROID)
    # Same floor the package applies to its own library: an app is rejected for
    # the worst-aligned .so it ships, so the shim has to clear it too.
    include(CheckLinkerFlag)
    check_linker_flag(CXX "-Wl,-z,max-page-size=16384" DESPIA_LOCAL_JNI_HAS_MAX_PAGE_SIZE)
    if(DESPIA_LOCAL_JNI_HAS_MAX_PAGE_SIZE)
        target_link_options(despia_local_jni PRIVATE "-Wl,-z,max-page-size=16384")
    endif()
endif()
