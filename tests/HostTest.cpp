// Loads the BUILT Split Tracker and Split Tag plugins (VST3 and AU) the way a DAW
// does and checks: loading, untouched audio, master<->tag link, playback timing,
// an offline bounce (receipt + fingerprint), and saving/reopening the project.
// Usage: HostTest <song.wav> [copy-of-song.mp3]
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_cryptography/juce_cryptography.h>
#include "../Source/Fingerprint.h"
#include <cstdio>
#include <cstdlib>

using namespace juce;

static int passed = 0, failed = 0;
static void check (bool ok, const String& what, const String& detail = {})
{
    (ok ? passed : failed)++;
    std::printf ("%s  %s%s\n", ok ? "PASS" : "FAIL", what.toRawUTF8(),
                 detail.isNotEmpty() ? ("  [" + detail + "]").toRawUTF8() : "");
    std::fflush (stdout);
}

static void pump (int ms) { MessageManager::getInstance()->runDispatchLoopUntil (ms); }

struct Head : AudioPlayHead
{
    bool playing = false, recording = false;
    int64 samples = 0;
    double sr = 44100.0;
    Optional<PositionInfo> getPosition() const override
    {
        PositionInfo p;
        p.setIsPlaying (playing);
        p.setIsRecording (recording);
        p.setTimeInSamples (samples);
        p.setTimeInSeconds ((double) samples / sr);
        p.setBpm (120.0);
        return p;
    }
};

static std::unique_ptr<AudioPluginInstance> load (AudioPluginFormat& fmt, const String& id, double sr, int bs, String& err)
{
    OwnedArray<PluginDescription> types;
    fmt.findAllTypesForFile (types, id);
    if (types.isEmpty()) { err = "no plugin found at " + id; return {}; }
    AudioPluginFormatManager fm;
    return fmt.createInstanceFromDescription (*types[0], sr, bs, err);
}

static void setup (AudioPluginInstance& p, Head& head, double sr, int bs)
{
    p.setPlayHead (&head);
    p.enableAllBuses();
    p.setRateAndBufferSizeDetails (sr, bs);
    p.prepareToPlay (sr, bs);
}

/** Feeds noise through and checks the output is bit-for-bit the input. */
static bool passthroughExact (AudioPluginInstance& p, int bs, int blocks)
{
    Random rng (1234);
    const int chans = jmax (p.getTotalNumInputChannels(), p.getTotalNumOutputChannels());
    AudioBuffer<float> buf (chans, bs), ref (chans, bs);
    MidiBuffer midi;
    for (int b = 0; b < blocks; ++b)
    {
        for (int ch = 0; ch < chans; ++ch)
            for (int i = 0; i < bs; ++i)
                buf.setSample (ch, i, rng.nextFloat() * 2.0f - 1.0f);
        ref.makeCopyOf (buf);
        p.processBlock (buf, midi);
        for (int ch = 0; ch < 2 && ch < chans; ++ch)
            if (std::memcmp (buf.getReadPointer (ch), ref.getReadPointer (ch), sizeof (float) * (size_t) bs) != 0)
                return false;
    }
    return true;
}

static File newestFile (const File& dir, const String& pattern, Time after)
{
    File best;
    for (auto& f : dir.findChildFiles (File::findFiles, true, pattern))
        if (f.getLastModificationTime() >= after && ! f.getFileName().contains (" - stem - ")
            && (best == File() || f.getLastModificationTime() > best.getLastModificationTime()))
            best = f;
    return best;
}

static int countLog (const XmlElement& root, const String& type)
{
    int n = 0;
    if (auto* log = root.getChildByName ("Log"))
        for (auto* e : log->getChildIterator())
            if (e->getStringAttribute ("type") == type) ++n;
    return n;
}

int main (int argc, char** argv)
{
    ScopedJuceInitialiser_GUI gui;
    if (argc < 2) { std::printf ("usage: HostTest song.wav [copy.mp3]\n"); return 2; }
    const File songFile { String (CharPointer_UTF8 (argv[1])) };
    const File copyFile = argc > 2 ? File (String (CharPointer_UTF8 (argv[2]))) : File();

    const auto home = File::getSpecialLocation (File::userHomeDirectory);
    const auto vst3Dir = home.getChildFile ("Library/Audio/Plug-Ins/VST3");
    // A private link folder, so this test never mixes with a real session open in a DAW.
    const auto liveDir = File::getSpecialLocation (File::tempDirectory).getChildFile ("SplitTrackerHostTest-Live");
    liveDir.deleteRecursively();
    liveDir.createDirectory();
    setenv ("SPLIT_TRACKER_LIVE_DIR", liveDir.getFullPathName().toRawUTF8(), 1);
    // Never use a real linked account from a test: the saved account file is pointed somewhere empty.
    // (SPLIT_TRACKER_SERVER and SPLIT_TRACKER_KEY can still aim the test at a local test server.)
    // A pretend DAW project that this "host" keeps open, as a DAW would: the plugin should find and sign it by itself.
    const auto fakeProject = File::getSpecialLocation (File::userHomeDirectory).getChildFile ("SplitTrackerHostTest-" + String (Time::currentTimeMillis()) + ".flp");
    fakeProject.replaceWithText ("pretend FL Studio project, version 1");
    FileInputStream keepOpen (fakeProject);
    const auto fakeProjectSha = SHA256 (fakeProject).toHexString();
    setenv ("SPLIT_TRACKER_OWN_PROCESS_ONLY", "1", 1);
    setenv ("SPLIT_TRACKER_ACCOUNT_FILE", liveDir.getChildFile ("no-account.json").getFullPathName().toRawUTF8(), 1);
    const auto projDir = home.getChildFile ("Library/Application Support/TBA/SplitTracker/Projects");
    const auto receipts = home.getChildFile ("Documents/Split Tracker Receipts");
    const auto started = Time::getCurrentTime() - RelativeTime::seconds (2);

    VST3PluginFormat vst3;
    AudioUnitPluginFormat au;
    String err;
    Head head;

    //==========================================================================
    std::printf ("\n-- Audio Unit (what Logic loads) --\n");
    for (auto& [name, id] : { std::pair<String, String> { "Split Tracker", "AudioUnit:Effects/aufx,Sptr,Tbaa" },
                              std::pair<String, String> { "Split Tag",     "AudioUnit:Effects/aufx,Trtg,Tbaa" } })
    {
        auto p = load (au, id, 48000.0, 1024, err);
        check (p != nullptr, name + " AU loads", err);
        if (p == nullptr) continue;
        head.sr = 48000.0;
        setup (*p, head, 48000.0, 1024);
        check (passthroughExact (*p, 1024, 200), name + " AU: audio out is bit-identical to audio in (48 kHz)");
        MemoryBlock mb;
        p->getStateInformation (mb);
        check (mb.getSize() > 0, name + " AU: saves its state", String ((int) mb.getSize()) + " bytes");
        p->releaseResources();
        p.reset();
        pump (300);
    }
    pump (1500);

    //==========================================================================
    std::printf ("\n-- VST3 (FL Studio, Ableton) --\n");
    const double sr = 44100.0; const int bs = 512;
    head.sr = sr;
    auto master = load (vst3, vst3Dir.getChildFile ("Split Tracker.vst3").getFullPathName(), sr, bs, err);
    check (master != nullptr, "Split Tracker VST3 loads", err);
    if (master == nullptr) return 1;
    setup (*master, head, sr, bs);
    check (master->getLatencySamples() == 0, "Split Tracker adds no latency");
    check (passthroughExact (*master, bs, 300), "Split Tracker VST3: audio out is bit-identical to audio in");

    pump (3500);   // session starts on the 2nd timer tick
    auto masters = liveDir.findChildFiles (File::findFiles, false, "master-*.json");
    check (masters.size() == 1, "Master announces itself to Split Tags", String (masters.size()) + " master file(s)");
    String projectId;
    if (masters.size() > 0)
        projectId = JSON::parse (masters[0]).getProperty ("projectId", "").toString();

    auto tag = load (vst3, vst3Dir.getChildFile ("Split Tag.vst3").getFullPathName(), sr, bs, err);
    check (tag != nullptr, "Split Tag VST3 loads", err);
    if (tag != nullptr)
    {
        setup (*tag, head, sr, bs);
        tag->updateTrackProperties ({ String ("Lead Vox"), Colours::orange });
        check (passthroughExact (*tag, bs, 300), "Split Tag VST3: audio out is bit-identical to audio in");
        check (tag->getLatencySamples() == 0, "Split Tag adds no latency");
    }

    // A second tagged track: several Split Tags all report to the one master.
    auto tag2 = load (vst3, vst3Dir.getChildFile ("Split Tag.vst3").getFullPathName(), sr, bs, err);
    check (tag2 != nullptr, "Second Split Tag loads on another track", err);
    if (tag2 != nullptr)
    {
        setup (*tag2, head, sr, bs);
        tag2->updateTrackProperties ({ String ("808 Drums"), Colours::blue });
    }

    // Playback for ~4 s (realtime): all plugins see a playing transport with signal.
    head.playing = true;
    for (int i = 0; i < 40; ++i)
    {
        passthroughExact (*master, bs, 4);
        if (tag) passthroughExact (*tag, bs, 4);
        if (tag2) passthroughExact (*tag2, bs, 4);
        head.samples += bs * 4;
        pump (100);
    }

    // Record a take on the first track only: transport recording, signal on that track.
    head.recording = true;
    for (int i = 0; i < 35; ++i)
    {
        passthroughExact (*master, bs, 4);
        if (tag) passthroughExact (*tag, bs, 4);
        head.samples += bs * 4;
        pump (100);
    }
    head.recording = false;
    head.playing = false;
    for (int i = 0; i < 25; ++i) { passthroughExact (*master, bs, 2); if (tag) passthroughExact (*tag, bs, 2); pump (100); }

    auto tags = liveDir.findChildFiles (File::findFiles, false, "tag-*.json");
    bool linked = false; String tagJson;
    for (auto& f : tags)
    {
        // Both tags' status files are read; which one comes last depends on their random IDs.
        tagJson += f.loadFileAsString();
        if (projectId.isNotEmpty() && tagJson.contains (projectId)) linked = true;
    }
    check (tags.size() >= 1, "Split Tag reports its status", String (tags.size()) + " tag file(s)");
    check (linked, "Split Tag auto-linked to the master");
    check (tagJson.contains ("Lead Vox"), "Split Tag picked up the track name from the host");

    //==========================================================================
    std::printf ("\n-- Offline bounce of %s --\n", songFile.getFileName().toRawUTF8());
    AudioFormatManager afm; afm.registerBasicFormats();
    std::unique_ptr<AudioFormatReader> r (afm.createReaderFor (songFile));
    check (r != nullptr, "Test song opens");
    if (r != nullptr)
    {
        master->setNonRealtime (true);
        if (tag)  tag->setNonRealtime (true);
        if (tag2) tag2->setNonRealtime (true);
        head.playing = true; head.samples = 0;
        AudioBuffer<float> buf (2, bs), ref (2, bs), stemBuf (2, bs);
        MidiBuffer midi;
        bool exact = true;
        const int64 total = r->lengthInSamples;
        const int blocksPerPump = (int) jmax ((int64) 1, total / bs / 45);   // spread over ~4.5 s of wall clock
        int n = 0;
        for (int64 pos = 0; pos < total; pos += bs, ++n)
        {
            buf.clear();
            r->read (&buf, 0, (int) jmin ((int64) bs, total - pos), pos, true, true);
            ref.makeCopyOf (buf);
            // Track 1 carries the song itself; track 2 carries a different part of it.
            if (tag)  { stemBuf.makeCopyOf (ref); tag->processBlock (stemBuf, midi); }
            if (tag2)
            {
                stemBuf.clear();
                const int64 other = (pos + total / 2) % jmax ((int64) 1, total - bs);
                r->read (&stemBuf, 0, bs, other, true, true);
                tag2->processBlock (stemBuf, midi);
            }
            master->processBlock (buf, midi);
            exact = exact && std::memcmp (buf.getReadPointer (0), ref.getReadPointer (0), sizeof (float) * (size_t) bs) == 0;
            head.samples += bs;
            if (n % blocksPerPump == 0) pump (100);
        }
        master->setNonRealtime (false);
        // Logic re-prepares the plugin when a bounce ends, before the plugin's timer has
        // noticed: the fingerprint must survive that.
        master->releaseResources();
        master->prepareToPlay (sr, bs);
        for (auto* tg : { tag.get(), tag2.get() })
            if (tg != nullptr) { tg->setNonRealtime (false); tg->releaseResources(); tg->prepareToPlay (sr, bs); }
        head.playing = false;
        check (exact, "Bounced audio is bit-identical (plugin doesn't touch the master)");
        for (int i = 0; i < 80; ++i)    // back to realtime; tags hand over stems, then the master writes one receipt
        {
            passthroughExact (*master, bs, 2);
            if (tag)  passthroughExact (*tag, bs, 2);
            if (tag2) passthroughExact (*tag2, bs, 2);
            pump (100);
        }

        auto html = newestFile (receipts, "*.html", started);
        auto fpf  = newestFile (receipts, "*.fingerprint", started);
        check (html.existsAsFile(), "Bounce receipt was written", html.getFullPathName());
        check (fpf.existsAsFile(), "Fingerprint file was written next to it", fpf.getFileName());
        if (html.existsAsFile())
        {
            auto t = html.loadFileAsString();
            check (t.containsIgnoreCase ("not confirmed") || t.containsIgnoreCase ("unconfirmed") || t.containsIgnoreCase ("incomplete"),
                   "Receipt says the splits were not confirmed");
            check (t.contains ("Lead Vox"), "Receipt lists the tagged track");
            check (t.contains ("Stems in this bounce") && t.contains ("808 Drums"), "Receipt lists a stem for each tagged track");
            check (t.contains ("<h2>Takes</h2>"), "Receipt lists the recorded take");
        }

        // Stems: one fingerprint per tagged track, saved next to the master's, and it really is that track.
        Array<File> stemFiles;
        for (auto& f : receipts.findChildFiles (File::findFiles, true, "* - stem - *.fingerprint"))
            if (f.getLastModificationTime() >= started) stemFiles.add (f);
        check (stemFiles.size() == 2, "A stem fingerprint was saved for each of the two tracks", String (stemFiles.size()) + " stem file(s)");
        for (auto& sf : stemFiles)
        {
            if (! sf.getFileName().contains ("Lead Vox")) continue;
            std::vector<uint32> stemFp; double sspf = 0;
            std::unique_ptr<AudioFormatReader> qr (afm.createReaderFor (songFile));
            if (qr != nullptr && AcousticFingerprinter::deserialise (sf, stemFp, sspf))
            {
                AcousticFingerprinter f;
                f.prepare (qr->sampleRate, (double) qr->lengthInSamples / qr->sampleRate + 5.0);
                AudioBuffer<float> qb ((int) qr->numChannels, 16384);
                for (int64 pos = 0; pos < qr->lengthInSamples; pos += 16384)
                {
                    const int c = (int) jmin ((int64) 16384, qr->lengthInSamples - pos);
                    qr->read (&qb, 0, c, pos, true, true);
                    f.process (qb.getArrayOfReadPointers(), qb.getNumChannels(), c);
                }
                auto m = AcousticFingerprinter::compare (stemFp, f.getFrames(), sspf);
                check (m.isStrong(), "The \"Lead Vox\" stem fingerprint matches that track's audio",
                       "similarity " + String (m.similarity * 100.0, 0) + "%, coverage " + String (m.coverage * 100.0, 0) + "%");
            }
        }

        std::vector<uint32> bounceFp; double spf = 0;
        if (fpf.existsAsFile() && AcousticFingerprinter::deserialise (fpf, bounceFp, spf))
        {
            const double secs = (double) bounceFp.size() * spf, want = (double) total / r->sampleRate;
            check (std::abs (secs - want) < 2.0, "Fingerprint covers the whole bounce",
                   String (secs, 1) + " s of " + String (want, 1) + " s");

            for (auto& q : { songFile, copyFile })
            {
                if (! q.existsAsFile()) continue;
                std::unique_ptr<AudioFormatReader> qr (afm.createReaderFor (q));
                if (qr == nullptr) { check (false, "Could not open " + q.getFileName()); continue; }
                AcousticFingerprinter f;
                f.prepare (qr->sampleRate, (double) qr->lengthInSamples / qr->sampleRate + 5.0);
                AudioBuffer<float> qb ((int) qr->numChannels, 16384);
                for (int64 pos = 0; pos < qr->lengthInSamples; pos += 16384)
                {
                    const int c = (int) jmin ((int64) 16384, qr->lengthInSamples - pos);
                    qr->read (&qb, 0, c, pos, true, true);
                    f.process (qb.getArrayOfReadPointers(), qb.getNumChannels(), c);
                }
                auto m = AcousticFingerprinter::compare (bounceFp, f.getFrames(), spf);
                check (m.isStrong(), "Plugin's bounce fingerprint matches " + q.getFileName(),
                       "similarity " + String (m.similarity * 100.0, 0) + "%, coverage " + String (m.coverage * 100.0, 0) + "%");
            }
        }
    }

    //==========================================================================
    std::printf ("\n-- Save project, close, reopen --\n");

    if (tag) { tag->releaseResources(); tag.reset(); }
    if (tag2) { tag2->releaseResources(); tag2.reset(); }
    pump (6500);    // master should notice the tag is gone
    MemoryBlock saved;              // the project is saved after the tags were removed, as on closing a session
    master->getStateInformation (saved);
    check (saved.getSize() > 200, "Master saves its state into the project", String ((int) saved.getSize()) + " bytes");
    master->releaseResources();
    master.reset(); // writes the backup
    pump (500);
    check (liveDir.findChildFiles (File::findFiles, false, "master-*.json").isEmpty(), "Master cleans up its live file on close");
    check (liveDir.findChildFiles (File::findFiles, false, "tag-*.json").isEmpty(), "Split Tag cleans up its live file on close");

    auto backup = projDir.getChildFile (projectId + ".xml");
    auto xml = parseXML (backup);
    check (xml != nullptr, "Backup of the project log exists", backup.getFileName());
    int logBefore = 0;
    if (xml != nullptr)
    {
        auto* s = xml->getChildByName ("Song");
        check (s != nullptr && s->getIntAttribute ("bounceCount") == 1, "Exactly one bounce was counted",
               s ? s->getStringAttribute ("bounceCount") : String());
        check (s != nullptr && s->getIntAttribute ("playSeconds") >= 3, "Playback time was counted",
               s ? s->getStringAttribute ("playSeconds") + " s" : String());
        check (countLog (*xml, "SESSION") >= 2, "Log: session opened and closed");
        check (countLog (*xml, "BOUNCE") == 2, "Log: bounce started and finished", String (countLog (*xml, "BOUNCE")));
        check (countLog (*xml, "RECEIPT") == 1 && countLog (*xml, "FINGER") == 1, "Log: receipt and fingerprint recorded");
        check (countLog (*xml, "TRACK") >= 2, "Log: track tagged, then tag removed", String (countLog (*xml, "TRACK")) + " TRACK entries");
        check (countLog (*xml, "TAKE") == 1, "Log: one numbered take on the recorded track", String (countLog (*xml, "TAKE")) + " TAKE entries");
        check (countLog (*xml, "STEM") == 2, "Log: a stem entry for each tagged track", String (countLog (*xml, "STEM")) + " STEM entries");
        if (auto* log = xml->getChildByName ("Log")) logBefore = log->getNumChildElements();
        std::printf ("\n   Log as saved:\n");
        if (auto* log = xml->getChildByName ("Log"))
            for (auto* e : log->getChildIterator())
                std::printf ("     %-8s %s\n", e->getStringAttribute ("type").toRawUTF8(), e->getStringAttribute ("text").toRawUTF8());
        std::printf ("\n");
    }

    auto reopened = load (vst3, vst3Dir.getChildFile ("Split Tracker.vst3").getFullPathName(), sr, bs, err);
    check (reopened != nullptr, "Project reopens", err);
    if (reopened != nullptr)
    {
        setup (*reopened, head, sr, bs);
        reopened->setStateInformation (saved.getData(), (int) saved.getSize());
        pump (3500);
        auto m2 = liveDir.findChildFiles (File::findFiles, false, "master-*.json");
        const auto id2 = m2.size() > 0 ? JSON::parse (m2[0]).getProperty ("projectId", "").toString() : String();
        check (id2 == projectId && projectId.isNotEmpty(), "Reopened project keeps the same project ID");
        reopened->releaseResources();
        reopened.reset();
        pump (500);
        if (auto x2 = parseXML (backup))
        {
            auto* s = x2->getChildByName ("Song");
            check (s != nullptr && s->getIntAttribute ("bounceCount") == 1, "Bounce count survived the reload");
            bool recovered = false;
            if (auto* savedLog = x2->getChildByName ("Log"))
                for (auto* e : savedLog->getChildIterator())
                    recovered = recovered || e->getStringAttribute ("type") == "RECOVER";
            check (recovered, "Records made after the last save come back when the project reopens");
            check (s != nullptr && s->getStringAttribute ("projectFileSha") == fakeProjectSha,
                   "Open project file was found and signed without being asked", s ? s->getStringAttribute ("projectFileName") : String());
            auto* log = x2->getChildByName ("Log");
            check (log != nullptr && log->getNumChildElements() >= logBefore, "Log survived the reload and kept growing",
                   String (logBefore) + " -> " + String (log ? log->getNumChildElements() : 0) + " entries");
        }
    }

    fakeProject.deleteFile();
    std::printf ("\n%d passed, %d failed\n", passed, failed);
    return failed == 0 ? 0 : 1;
}
