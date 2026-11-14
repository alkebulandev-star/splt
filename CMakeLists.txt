cmake_minimum_required(VERSION 3.22)
project(SplitTracker VERSION 0.2.0)

set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "")
set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "")

add_subdirectory(JUCE)

# Formats per desktop platform. Together these cover every mainstream desktop DAW:
#   VST3  - FL Studio, Ableton Live, Cubase/Nuendo, Studio One, Reaper, Bitwig, Cakewalk, Waveform ... (all platforms)
#   AU    - Logic Pro, GarageBand, MainStage, Digital Performer (macOS only)
#   LV2   - Ardour, Mixbus, Reaper and Bitwig on Linux
#   AAX   - Pro Tools. Needs the Avid AAX SDK (developer.avid.com) and Avid's signing tools:
#           configure with  -DSPLIT_TRACKER_AAX_SDK=/path/to/AAX_SDK
if(APPLE)
    set(PLUGIN_FORMATS VST3 AU Standalone)
elseif(WIN32)
    set(PLUGIN_FORMATS VST3 Standalone)
else()
    set(PLUGIN_FORMATS VST3 LV2 Standalone)
endif()

set(SPLIT_TRACKER_AAX_SDK "" CACHE PATH "Path to the Avid AAX SDK; adds the Pro Tools (AAX) format when set")
if(SPLIT_TRACKER_AAX_SDK AND NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
    juce_set_aax_sdk_path(${SPLIT_TRACKER_AAX_SDK})
    list(APPEND PLUGIN_FORMATS AAX)
endif()
# Split Tag only makes sense inside a DAW, so it has no standalone app.
set(TAG_FORMATS ${PLUGIN_FORMATS})
list(REMOVE_ITEM TAG_FORMATS Standalone)

set(COMMON_DEFS
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0)

#==============================================================================
# Split Tracker: goes on the master track
juce_add_plugin(SplitTracker
    COMPANY_NAME "TBA"
    PRODUCT_NAME "Split Tracker"
    BUNDLE_ID "com.tba.splittracker"
    LV2URI "https://example.com/plugins/split-tracker"
    AAX_IDENTIFIER "com.tba.splittracker"
    PLUGIN_MANUFACTURER_CODE Tbaa
    PLUGIN_CODE Sptr
    FORMATS ${PLUGIN_FORMATS}
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    COPY_PLUGIN_AFTER_BUILD TRUE
    VST3_CATEGORIES Fx Analyzer
    AU_MAIN_TYPE kAudioUnitType_Effect)

target_sources(SplitTracker PRIVATE
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp)

target_compile_features(SplitTracker PRIVATE cxx_std_20)
target_compile_definitions(SplitTracker PUBLIC ${COMMON_DEFS} JUCE_USE_MP3AUDIOFORMAT=1)

target_link_libraries(SplitTracker
    PRIVATE juce::juce_audio_utils
            juce::juce_dsp
            juce::juce_cryptography
    PUBLIC juce::juce_recommended_config_flags
           juce::juce_recommended_lto_flags
           juce::juce_recommended_warning_flags)

#==============================================================================
# Split Tag: goes on each track, reports to Split Tracker
juce_add_plugin(TrackTag
    COMPANY_NAME "TBA"
    PRODUCT_NAME "Split Tag"
    BUNDLE_ID "com.tba.tracktag"
    LV2URI "https://example.com/plugins/split-tag"
    AAX_IDENTIFIER "com.tba.tracktag"
    PLUGIN_MANUFACTURER_CODE Tbaa
    PLUGIN_CODE Trtg
    FORMATS ${TAG_FORMATS}
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    COPY_PLUGIN_AFTER_BUILD TRUE
    VST3_CATEGORIES Fx Analyzer
    AU_MAIN_TYPE kAudioUnitType_Effect)

target_sources(TrackTag PRIVATE Source/Tag/TrackTag.cpp)
target_compile_features(TrackTag PRIVATE cxx_std_20)
target_compile_definitions(TrackTag PUBLIC ${COMMON_DEFS})

target_link_libraries(TrackTag
    PRIVATE juce::juce_audio_utils
            juce::juce_dsp
            juce::juce_cryptography
    PUBLIC juce::juce_recommended_config_flags
           juce::juce_recommended_lto_flags
           juce::juce_recommended_warning_flags)

#==============================================================================
# Fingerprint test tool: cmake -B build -DSPLIT_TRACKER_TESTS=ON
option(SPLIT_TRACKER_TESTS "Build the fingerprint test tool" OFF)
if(SPLIT_TRACKER_TESTS)
    juce_add_console_app(FingerprintTest PRODUCT_NAME "FingerprintTest")
    target_sources(FingerprintTest PRIVATE tests/FingerprintTest.cpp)
    target_compile_features(FingerprintTest PRIVATE cxx_std_20)
    target_compile_definitions(FingerprintTest PRIVATE JUCE_USE_CURL=0 JUCE_WEB_BROWSER=0 JUCE_USE_MP3AUDIOFORMAT=1)
    target_link_libraries(FingerprintTest PRIVATE juce::juce_audio_formats juce::juce_dsp
                          juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

    # Prints which DAW project the plugin would find and sign by itself right now.
    juce_add_console_app(FindProject PRODUCT_NAME "FindProject")
    target_sources(FindProject PRIVATE tests/FindProject.cpp)
    target_compile_features(FindProject PRIVATE cxx_std_20)
    target_compile_definitions(FindProject PRIVATE JUCE_USE_CURL=0 JUCE_WEB_BROWSER=0)
    target_link_libraries(FindProject PRIVATE juce::juce_core juce::juce_cryptography juce::juce_recommended_config_flags)

    if(APPLE)   # the host test and the snapshot tools use macOS frameworks
    # Host test: loads the built VST3/AU plugins like a DAW would (run after building the plugins).
    juce_add_console_app(HostTest PRODUCT_NAME "HostTest")
    target_sources(HostTest PRIVATE tests/HostTest.cpp)
    target_compile_features(HostTest PRIVATE cxx_std_20)
    target_compile_definitions(HostTest PRIVATE JUCE_USE_CURL=0 JUCE_WEB_BROWSER=0 JUCE_USE_MP3AUDIOFORMAT=1
                               JUCE_PLUGINHOST_VST3=1 JUCE_PLUGINHOST_AU=1 JUCE_MODAL_LOOPS_PERMITTED=1)
    target_link_libraries(HostTest PRIVATE juce::juce_audio_processors juce::juce_audio_formats juce::juce_dsp juce::juce_cryptography
                          juce::juce_recommended_config_flags "-framework CoreAudioKit")

    # UI snapshots: render the plugin windows to PNG with example people (design checks without a DAW).
    foreach(pair "UiShot;SplitTracker;0" "TagShot;TrackTag;1")
        list(GET pair 0 exe)
        list(GET pair 1 lib)
        list(GET pair 2 isTag)
        add_executable(${exe} tests/UiShot.cpp)
        target_compile_features(${exe} PRIVATE cxx_std_20)
        target_include_directories(${exe} PRIVATE $<TARGET_PROPERTY:${lib},INCLUDE_DIRECTORIES>)
        target_compile_definitions(${exe} PRIVATE $<TARGET_PROPERTY:${lib},COMPILE_DEFINITIONS> TAG_SHOT=${isTag})
        target_link_libraries(${exe} PRIVATE ${lib})
    endforeach()
    endif()
endif()
