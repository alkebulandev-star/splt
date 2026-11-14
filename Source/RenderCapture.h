#pragma once
#include <juce_audio_basics/juce_audio_basics.h>
#include "Fingerprint.h"

/** Fingerprints the audio passing through a plugin during an offline bounce.
    The audio thread feeds it; the message thread collects the finished render.
    Hosts (Logic) re-prepare plugins when a bounce ends, so a finished render is
    parked before prepare() can wipe it. */
class RenderCapture
{
public:
    void prepare (double sampleRate)
    {
        const juce::SpinLock::ScopedLockType sl (lock);
        if (active.load() && fp.getFrames().size() > parked.size())
        {
            parked = fp.getFrames();
            parkedSpf = fp.getSecondsPerFrame();
        }
        fp.prepare (sampleRate, 30.0 * 60.0);
        rate.store (sampleRate);
    }

    /** Audio thread. Read-only on the buffer. */
    void process (const juce::AudioBuffer<float>& buffer, bool offline)
    {
        if (! offline) { inRender.store (false); return; }

        const juce::SpinLock::ScopedTryLockType sl (lock);
        if (! inRender.load())
        {
            if (sl.isLocked()) { fp.reset(); parked.clear(); }
            samples.store (0);
            peak.store (0.0f);
        }
        inRender.store (true);
        active.store (true);

        if (sl.isLocked())
            fp.process (buffer.getArrayOfReadPointers(), buffer.getNumChannels(), buffer.getNumSamples());

        peak.store (juce::jmax (peak.load(), buffer.getMagnitude (0, buffer.getNumSamples())));
        samples.fetch_add (buffer.getNumSamples());
        lastMs.store (juce::Time::getMillisecondCounter());
    }

    /** True once a render has ended: realtime audio resumed, or offline blocks stopped coming. */
    bool finished() const
    {
        return active.load() && (! inRender.load() || juce::Time::getMillisecondCounter() - lastMs.load() > 1200);
    }

    struct Result { std::vector<juce::uint32> frames; double secondsPerFrame = 0, seconds = 0; float peak = 0; };

    /** Message thread: hand over the finished render and get ready for the next one. */
    Result take()
    {
        Result r;
        const juce::SpinLock::ScopedLockType sl (lock);
        if (parked.size() > fp.getFrames().size()) { r.frames = parked; r.secondsPerFrame = parkedSpf; }
        else                                       { r.frames = fp.getFrames(); r.secondsPerFrame = fp.getSecondsPerFrame(); }
        r.seconds = (double) samples.load() / juce::jmax (1.0, rate.load());
        r.peak = peak.load();
        parked.clear();
        fp.reset();
        active.store (false);
        inRender.store (false);
        return r;
    }

private:
    AcousticFingerprinter fp;
    juce::SpinLock lock;
    std::vector<juce::uint32> parked;
    double parkedSpf = 0.0;
    std::atomic<bool> active { false }, inRender { false };
    std::atomic<juce::int64> samples { 0 };
    std::atomic<float> peak { 0.0f };
    std::atomic<double> rate { 44100.0 };
    std::atomic<juce::uint32> lastMs { 0 };
};
