// Runs the plugin's AcousticFingerprinter on real files.
// Usage: FingerprintTest <reference.wav>... -- <query files>...
// References are fed in 512-sample blocks (like the plugin during a bounce);
// queries are read in 16384-sample chunks (like the Evidence tab).
#include <juce_audio_formats/juce_audio_formats.h>
#include "../Source/Fingerprint.h"
#include <cstdio>

using namespace juce;

static bool fingerprint (const File& f, int blockSize, std::vector<uint32>& out, double& spf)
{
    // A .fingerprint file saved by the plugin next to a bounce receipt can be used directly.
    if (f.hasFileExtension ("fingerprint"))
        return AcousticFingerprinter::deserialise (f, out, spf);

    AudioFormatManager fm;
    fm.registerBasicFormats();
    std::unique_ptr<AudioFormatReader> r (fm.createReaderFor (f));
    if (r == nullptr) return false;

    AcousticFingerprinter fp;
    fp.prepare (r->sampleRate, (double) r->lengthInSamples / r->sampleRate + 5.0);
    AudioBuffer<float> buf ((int) r->numChannels, blockSize);
    for (int64 pos = 0; pos < r->lengthInSamples; pos += blockSize)
    {
        const int n = (int) jmin ((int64) blockSize, r->lengthInSamples - pos);
        r->read (&buf, 0, n, pos, true, true);
        fp.process (buf.getArrayOfReadPointers(), buf.getNumChannels(), n);
    }
    out = fp.getFrames();
    spf = fp.getSecondsPerFrame();
    return true;
}

int main (int argc, char** argv)
{
    std::vector<File> refs, queries;
    bool q = false;
    for (int i = 1; i < argc; ++i)
    {
        if (String (argv[i]) == "--") { q = true; continue; }
        (q ? queries : refs).push_back (File (String (CharPointer_UTF8 (argv[i]))));
    }

    struct Ref { String name; std::vector<uint32> fp; double spf; };
    std::vector<Ref> rs;
    for (auto& f : refs)
    {
        Ref r { f.getFileNameWithoutExtension(), {}, 0 };
        auto t0 = Time::getMillisecondCounterHiRes();
        if (! fingerprint (f, 512, r.fp, r.spf)) { std::printf ("can't read %s\n", f.getFullPathName().toRawUTF8()); return 1; }
        std::printf ("REF %-16s %6d frames  %.0f ms\n", r.name.toRawUTF8(), (int) r.fp.size(), Time::getMillisecondCounterHiRes() - t0);
        rs.push_back (std::move (r));
    }
    std::printf ("\n%-26s", "query");
    for (auto& r : rs) std::printf (" | %-24s", r.name.toRawUTF8());
    std::printf ("\n");

    for (auto& f : queries)
    {
        std::vector<uint32> qf; double spf;
        if (! fingerprint (f, 16384, qf, spf)) { std::printf ("%-26s unreadable\n", f.getFileName().toRawUTF8()); continue; }
        std::printf ("%-26s", f.getFileName().substring (0, 26).toRawUTF8());
        for (auto& r : rs)
        {
            auto t0 = Time::getMillisecondCounterHiRes();
            auto m = AcousticFingerprinter::compare (r.fp, qf, r.spf);
            const double ms = Time::getMillisecondCounterHiRes() - t0;
            std::printf (" | %s sim%3d%% cov%3d%% %4.0fms",
                         m.isStrong() ? "SAME " : (m.isMatch() ? "maybe" : "  no "), roundToInt (m.similarity * 100), roundToInt (m.coverage * 100), ms);
        }
        std::printf ("\n");
    }
    return 0;
}
