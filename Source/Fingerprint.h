#pragma once
#include <juce_dsp/juce_dsp.h>
#include <bit>

/** Shazam-style acoustic fingerprint (after Haitsma & Kalker, 2002).

    Audio is low-passed, resampled to exactly 11025 Hz and analysed in overlapping
    2048-point frames. For each frame, 33 log-spaced bands between 300 Hz and
    2 kHz are measured, and 32 bits record whether the energy difference
    between neighbouring bands went up or down compared with the previous
    frame. Those up/down patterns survive MP3/AAC encoding, volume changes,
    small EQ changes and re-recording through speakers, so a release can be
    matched back to a bounce.

    process() never allocates once prepare() has been called, so it is safe
    to run on the audio thread. */
class AcousticFingerprinter
{
public:
    static constexpr int fftOrder = 11, fftSize = 1 << fftOrder, hop = 64, numBands = 33;
    static constexpr double targetRate = 11025.0, lowHz = 300.0, highHz = 2000.0;
    static constexpr int framesPerSecondApprox = 172;

    AcousticFingerprinter() : fft (fftOrder) {}

    void prepare (double hostSampleRate, double maxSeconds)
    {
        // Resample to exactly targetRate (fractional step + linear interpolation)
        // so 44.1k, 48k, 96k... sources all produce comparable frames.
        step = hostSampleRate / targetRate;
        effectiveRate = targetRate;

        makeLowpass (hostSampleRate, juce::jmin (targetRate * 0.4, hostSampleRate * 0.45));

        for (int i = 0; i < fftSize; ++i)
            window[(size_t) i] = 0.5f - 0.5f * std::cos (juce::MathConstants<float>::twoPi * (float) i / (float) (fftSize - 1));

        for (int b = 0; b <= numBands; ++b)
        {
            const double f = lowHz * std::pow (highHz / lowHz, (double) b / numBands);
            bandEdge[(size_t) b] = juce::jlimit (1, fftSize / 2 - 1, (int) std::round (f / effectiveRate * fftSize));
        }

        frames.clear();
        frames.reserve ((size_t) (maxSeconds * effectiveRate / hop) + 16);
        reset();
    }

    void reset()
    {
        frames.clear();
        std::fill (std::begin (z), std::end (z), 0.0);
        ring.fill (0.0f);
        ringPos = 0; filled = 0; sinceHop = 0; havePrev = false;
        phase = 0.0; prevSample = 0.0;
    }

    /** Feed audio (any channel count). */
    void process (const float* const* channels, int numChannels, int numSamples)
    {
        if (numChannels <= 0) return;
        const float scale = 1.0f / (float) numChannels;

        for (int i = 0; i < numSamples; ++i)
        {
            float mono = 0.0f;
            for (int ch = 0; ch < numChannels; ++ch)
                mono += channels[ch][i];

            const double x = filter ((double) (mono * scale));

            // Emit every output sample whose time falls between prevSample and x.
            while (phase < 1.0)
            {
                pushResampled (prevSample + (x - prevSample) * phase);
                phase += step;
            }
            phase -= 1.0;
            prevSample = x;
        }
    }

    const std::vector<juce::uint32>& getFrames() const   { return frames; }
    double getSecondsPerFrame() const                   { return hop / effectiveRate; }

    //==============================================================================
    struct Match
    {
        double similarity = 0.0;   // 1 - bit error rate of matching blocks (0..1)
        double coverage = 0.0;     // fraction of query blocks that matched
        double offsetSeconds = 0.0;
        /** Shares material with the reference: a copy, OR a different song with the same beat/sample. */
        bool isMatch() const       { return coverage >= 0.5 && similarity >= 0.70; }
        /** Same recording (tested: WAV/MP3/AAC/resampled/volume-changed copies score 89-100%;
            a different song on the same beat scored ~73%). */
        bool isStrong() const      { return coverage >= 0.8 && similarity >= 0.85; }
    };

    /** Compares a query (e.g. a dropped MP3) against a reference (a bounce).
        Splits the query into ~3 s blocks and finds the best alignment of each
        within the reference. A block "matches" when its bit error rate < 0.35. */
    static Match compare (const std::vector<juce::uint32>& reference, const std::vector<juce::uint32>& query,
                          double secondsPerFrame)
    {
        Match m;
        constexpr int block = 256;
        if (reference.size() < (size_t) block || query.size() < (size_t) block)
            return m;

        const int numBlocks = (int) (query.size() / block);
        const int step = juce::jmax (1, numBlocks / 24);        // sample up to ~24 blocks
        int tested = 0, matched = 0;
        double berSum = 0.0, offsetSum = 0.0;

        for (int b = 0; b < numBlocks; b += step)
        {
            const auto* q = query.data() + (size_t) b * block;
            int bestErrors = block * 32 + 1, bestOffset = 0;

            for (size_t off = 0; off + block <= reference.size(); ++off)
            {
                int errors = 0;
                const auto* r = reference.data() + off;
                for (int k = 0; k < block && errors < bestErrors; ++k)
                    errors += std::popcount (r[k] ^ q[k]);

                if (errors < bestErrors) { bestErrors = errors; bestOffset = (int) off; }
            }

            ++tested;
            const double ber = bestErrors / (double) (block * 32);
            if (ber < 0.35)
            {
                ++matched;
                berSum += ber;
                offsetSum += (bestOffset - b * block) * secondsPerFrame;
            }
        }

        m.coverage = tested > 0 ? matched / (double) tested : 0.0;
        if (matched > 0)
        {
            m.similarity = 1.0 - berSum / matched;
            m.offsetSeconds = offsetSum / matched;
        }
        return m;
    }

    //==============================================================================
    static juce::MemoryBlock serialise (const std::vector<juce::uint32>& f, double secondsPerFrame)
    {
        juce::MemoryOutputStream out;
        out.write ("TBAFP1", 6);
        out.writeDouble (secondsPerFrame);
        out.writeInt ((int) f.size());
        for (auto v : f) out.writeInt ((int) v);
        return out.getMemoryBlock();
    }

    static bool deserialise (const juce::File& file, std::vector<juce::uint32>& f, double& secondsPerFrame)
    {
        juce::FileInputStream in (file);
        if (! in.openedOk()) return false;
        char magic[6] {};
        if (in.read (magic, 6) != 6 || std::memcmp (magic, "TBAFP1", 6) != 0) return false;
        secondsPerFrame = in.readDouble();
        const int n = in.readInt();
        if (n < 0 || n > 10'000'000) return false;
        f.resize ((size_t) n);
        for (auto& v : f) v = (juce::uint32) in.readInt();
        return true;
    }

private:
    void pushResampled (double x)
    {
        ring[(size_t) ringPos] = (float) x;
        ringPos = (ringPos + 1) % fftSize;
        if (filled < fftSize) ++filled;

        if (++sinceHop >= hop && filled == fftSize)
        {
            sinceHop = 0;
            analyseFrame();
        }
    }

    void analyseFrame()
    {
        for (int i = 0; i < fftSize; ++i)
            fftData[(size_t) i] = ring[(size_t) ((ringPos + i) % fftSize)] * window[(size_t) i];
        std::fill (fftData.begin() + fftSize, fftData.end(), 0.0f);

        fft.performFrequencyOnlyForwardTransform (fftData.data(), true);

        std::array<double, numBands> e {};
        for (int b = 0; b < numBands; ++b)
        {
            double sum = 0.0;
            for (int k = bandEdge[(size_t) b]; k < juce::jmax (bandEdge[(size_t) b] + 1, bandEdge[(size_t) b + 1]); ++k)
                sum += (double) fftData[(size_t) k] * fftData[(size_t) k];
            e[(size_t) b] = sum;
        }

        if (havePrev && frames.size() < frames.capacity())
        {
            juce::uint32 bits = 0;
            for (int m = 0; m < 32; ++m)
            {
                const double d = (e[(size_t) m] - e[(size_t) m + 1]) - (prev[(size_t) m] - prev[(size_t) m + 1]);
                if (d > 0) bits |= (1u << m);
            }
            frames.push_back (bits);
        }
        prev = e;
        havePrev = true;
    }

    // Two cascaded RBJ biquad low-passes (anti-alias before decimation).
    void makeLowpass (double sr, double cutoff)
    {
        const double w0 = juce::MathConstants<double>::twoPi * cutoff / sr;
        const double alpha = std::sin (w0) / (2.0 * 0.7071);
        const double cosw = std::cos (w0), a0 = 1.0 + alpha;
        b0 = (1.0 - cosw) / 2.0 / a0; b1 = (1.0 - cosw) / a0; b2 = b0;
        a1 = -2.0 * cosw / a0; a2 = (1.0 - alpha) / a0;
    }

    double filter (double x)
    {
        for (int s = 0; s < 2; ++s)
        {
            double* st = z + s * 2;
            const double y = b0 * x + st[0];
            st[0] = b1 * x - a1 * y + st[1];
            st[1] = b2 * x - a2 * y;
            x = y;
        }
        return x;
    }

    juce::dsp::FFT fft;
    std::array<float, fftSize> window {}, ring {};
    std::array<float, fftSize * 2> fftData {};
    std::array<int, numBands + 1> bandEdge {};
    std::array<double, numBands> prev {};
    std::vector<juce::uint32> frames;

    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z[4] {};
    double effectiveRate = targetRate, step = 4.0, phase = 0.0, prevSample = 0.0;
    int ringPos = 0, filled = 0, sinceHop = 0;
    bool havePrev = false;
};
