#include "PluginProcessor.h"
#include "PluginEditor.h"
#include <juce_cryptography/juce_cryptography.h>

using namespace juce;

namespace
{
    String html (const String& s)
    {
        return s.replace ("&", "&amp;").replace ("<", "&lt;").replace (">", "&gt;").replace ("\"", "&quot;");
    }

    String csvField (const String& s)
    {
        if (s.containsAnyOf (",\"\n\r"))
            return "\"" + s.replace ("\"", "\"\"") + "\"";
        return s;
    }

    String csvRow (const StringArray& fields)
    {
        StringArray out;
        for (auto& f : fields) out.add (csvField (f));
        return out.joinIntoString (",") + "\n";
    }
}

//==============================================================================
SplitTrackerProcessor::SplitTrackerProcessor()
    : AudioProcessor (BusesProperties()
                        .withInput  ("Input",  AudioChannelSet::stereo(), true)
                        .withOutput ("Output", AudioChannelSet::stereo(), true)),
      state (createEmptyState())
{
    sessionOpenedMs = Time::getMillisecondCounter();
    startTimer (1000);
}

SplitTrackerProcessor::~SplitTrackerProcessor()
{
    stopTimer();
    pool.removeAllJobs (true, 10000);
    LiveLink::masterFile (song()[IDs::projectId].toString()).deleteFile();
    if (sessionStarted)
    {
        addLog ("SESSION", "Session closed after "
                + formatDuration ((Time::getMillisecondCounter() - sessionOpenedMs) / 1000));
        saveBackup();
    }
}

ValueTree SplitTrackerProcessor::createEmptyState()
{
    ValueTree root (IDs::SplitTracker);

    ValueTree s (IDs::Song);
    s.setProperty (IDs::projectId, Uuid().toString(), nullptr);
    s.setProperty (IDs::title, "", nullptr);
    s.setProperty (IDs::splitsConfirmed, false, nullptr);
    s.setProperty (IDs::popupOnBounce, true, nullptr);
    s.setProperty (IDs::openReceiptOnBounce, true, nullptr);
    s.setProperty (IDs::sessionSeconds, 0, nullptr);
    s.setProperty (IDs::playSeconds, 0, nullptr);
    s.setProperty (IDs::recordSeconds, 0, nullptr);
    s.setProperty (IDs::bounceCount, 0, nullptr);

    root.appendChild (s, nullptr);
    root.appendChild (ValueTree (IDs::Contributors), nullptr);
    root.appendChild (ValueTree (IDs::Log), nullptr);
    root.appendChild (ValueTree (IDs::Machines), nullptr);
    root.appendChild (ValueTree (IDs::Tracks), nullptr);
    root.appendChild (ValueTree (IDs::Bounces), nullptr);
    return root;
}

void SplitTrackerProcessor::prepareToPlay (double sr, int)
{
    currentSampleRate.store (sr);
    const SpinLock::ScopedLockType sl (fpLock);
    if (renderPending.load() && fingerprinter.getFrames().size() > pendingFp.size())
    {
        pendingFp = fingerprinter.getFrames();
        pendingFpSecondsPerFrame = fingerprinter.getSecondsPerFrame();
    }
    fingerprinter.prepare (sr, 30.0 * 60.0);   // room for 30-minute renders
}

bool SplitTrackerProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    auto out = layouts.getMainOutputChannelSet();
    if (out != AudioChannelSet::mono() && out != AudioChannelSet::stereo())
        return false;
    return out == layouts.getMainInputChannelSet();
}

//==============================================================================
void SplitTrackerProcessor::processBlock (AudioBuffer<float>& buffer, MidiBuffer&)
{
    // Fingerprint the audio during offline renders (read-only, no allocation).
    if (isNonRealtime())
    {
        uint64 h = renderHash.load();
        float peak = renderPeak.load();

        const SpinLock::ScopedTryLockType fpl (fpLock);
        const bool resetRequested = resetRender.exchange (false);
        if (! audioThreadOffline || resetRequested)
        {
            h = 14695981039346656037ull;
            peak = 0.0f;
            renderSamples.store (0);
            if (fpl.isLocked()) { fingerprinter.reset(); pendingFp.clear(); }
        }
        audioThreadOffline = true;
        renderPending.store (true);

        if (fpl.isLocked())
            fingerprinter.process (buffer.getArrayOfReadPointers(), buffer.getNumChannels(), buffer.getNumSamples());

        const int chans = buffer.getNumChannels(), n = buffer.getNumSamples();
        for (int i = 0; i < n; ++i)
            for (int ch = 0; ch < chans; ++ch)
            {
                const float v = buffer.getSample (ch, i);
                uint32 bits;
                std::memcpy (&bits, &v, sizeof (bits));
                h = (h ^ bits) * 1099511628211ull;
                peak = jmax (peak, std::abs (v));
            }

        renderHash.store (h);
        renderPeak.store (peak);
        renderSamples.fetch_add (n);
    }
    else
    {
        audioThreadOffline = false;
    }

    // Level for the window's meter line (read-only).
    livePeak.store (jmax (livePeak.load(), buffer.getMagnitude (0, buffer.getNumSamples())));

    // Audio passes through unchanged: this plugin never alters the master.
    bool playing = false, recording = false;

    if (auto* ph = getPlayHead())
        if (auto pos = ph->getPosition())
        {
            playing = pos->getIsPlaying();
            recording = pos->getIsRecording();
        }

    audioPlaying.store (playing);
    audioRecording.store (recording);
    offlineRender.store (isNonRealtime());
    lastProcessMs.store (Time::getMillisecondCounter());
}

//==============================================================================
void SplitTrackerProcessor::timerCallback()
{
    ++ticks;
    const ScopedLock sl (stateLock);
    auto s = song();

    // Until a project file is known, look for the one the host has open. Checked every 10 seconds.
    if (sessionStarted && ticks % 10 == 5 && projectFilePath().isEmpty() && projectSigning.load() == 0)
        findProjectFile();

    // Give the host a moment to restore saved state before logging the session.
    if (! sessionStarted && ticks >= 2)
    {
        sessionStarted = true;
        registerMachine();
        addLog ("SESSION", "Session opened" + (splitsReady() ? String() : String (" - splits NOT confirmed")));
    }

    if (! sessionStarted)
        return;

    syncLiveLink();

    s.setProperty (IDs::sessionSeconds, (int64) s[IDs::sessionSeconds] + 1, nullptr);
    if (audioPlaying.load())   s.setProperty (IDs::playSeconds,   (int64) s[IDs::playSeconds] + 1, nullptr);
    if (audioRecording.load()) s.setProperty (IDs::recordSeconds, (int64) s[IDs::recordSeconds] + 1, nullptr);

    for (auto c : contributors())
        if ((bool) c[IDs::checkedIn])
            c.setProperty (IDs::seconds, (int64) c[IDs::seconds] + 1, nullptr);

    // Bounce detection: host switched us to offline (non-realtime) processing
    // and audio is actively flowing.
    const bool flowing = Time::getMillisecondCounter() - lastProcessMs.load() < 2000;
    const bool bouncing = offlineRender.load() && flowing;
    // A short bounce can start and finish between two timer ticks: the audio thread
    // leaves renderPending set, so it still gets logged and gets its receipt.
    const bool missedShortBounce = ! bouncing && ! wasBouncing && ! receiptPending && renderPending.load();

    if ((bouncing || missedShortBounce) && ! wasBouncing)
    {
        s.setProperty (IDs::bounceCount, (int) s[IDs::bounceCount] + 1, nullptr);
        bounceStartMs = Time::currentTimeMillis();
        auto problem = splitProblem();
        if (problem.isEmpty() && ! (bool) s[IDs::splitsConfirmed])
            problem = "splits entered but not confirmed by the team";

        addLog ("BOUNCE", problem.isEmpty() ? "Bounce started - splits confirmed"
                                            : "Bounce started with UNCONFIRMED splits: " + problem);

        if (! problem.isEmpty() && (bool) s[IDs::popupOnBounce])
        {
            if (onBounceStarted != nullptr)
                onBounceStarted();
            else
                // JUCE's own window, not a native alert: on macOS a native alert runs a
                // modal loop that would freeze the DAW's main thread until OK is clicked.
                AlertWindow::showAsync (MessageBoxOptions()
                    .withIconType (MessageBoxIconType::WarningIcon)
                    .withTitle ("Split Tracker: splits not confirmed")
                    .withMessage ("You're bouncing this track but the splits aren't done:\n\n" + problem
                                  + "\n\nOpen Split Tracker on the master to finish them.")
                    .withButton ("OK"), nullptr);
        }
    }
    if (missedShortBounce || (! bouncing && wasBouncing))
    {
        const double secs = (double) renderSamples.load() / jmax (1.0, currentSampleRate.load());
        addLog ("BOUNCE", "Bounce #" + s[IDs::bounceCount].toString() + " finished: "
                + String (secs, 1) + "s rendered, audio fingerprint "
                + String::toHexString ((int64) renderHash.load()));
        // Give every Split Tag a moment to hand over its stem fingerprint, then seal
        // master and stems together in one receipt.
        receiptPending = true;
        // Sign the project as it stands on disk, so the receipt names the project this bounce came from.
        if (const auto path = projectFilePath(); path.isNotEmpty())
            signProjectFile (File (path), {}, true);
        WeakReference<SplitTrackerProcessor> weak (this);
        Timer::callAfterDelay (3000, [weak] { if (auto* p = weak.get()) p->finishBounce (60); });
    }
    wasBouncing = bouncing;

    if (ticks % Config::backupEverySeconds == 0)
        saveBackup();
}

void SplitTrackerProcessor::registerMachine()
{
    // Machine IDs are hashed; the user is told about this in the Log tab.
    const auto id = String::toHexString (SystemStats::getUniqueDeviceID().hashCode64());
    const auto now = Time::currentTimeMillis();
    auto m = machines();
    auto node = m.getChildWithProperty (IDs::id, id);

    if (! node.isValid())
    {
        node = ValueTree (IDs::Machine);
        node.setProperty (IDs::id, id, nullptr);
        node.setProperty (IDs::computer, SystemStats::getComputerName(), nullptr);
        node.setProperty (IDs::os, SystemStats::getOperatingSystemName(), nullptr);
        node.setProperty (IDs::firstSeen, now, nullptr);
        node.setProperty (IDs::opens, 0, nullptr);
        m.appendChild (node, nullptr);

        addLog ("MACHINE", m.getNumChildren() == 1
                    ? "Project created on " + SystemStats::getComputerName()
                    : "Project opened on a NEW computer: " + SystemStats::getComputerName()
                      + " (" + String (m.getNumChildren()) + " computers total)");
    }

    node.setProperty (IDs::lastSeen, now, nullptr);
    node.setProperty (IDs::opens, (int) node[IDs::opens] + 1, nullptr);
}

//==============================================================================
void SplitTrackerProcessor::addLog (const String& type, const String& text)
{
    ValueTree e (IDs::Entry);
    e.setProperty (IDs::time, Time::currentTimeMillis(), nullptr);
    e.setProperty (IDs::type, type, nullptr);
    e.setProperty (IDs::text, text, nullptr);

    const ScopedLock sl (stateLock);
    auto l = log();
    e.setProperty (IDs::hash, entryHash (chainHead(), e), nullptr);
    l.appendChild (e, nullptr);

    while (l.getNumChildren() > Config::maxLogEntries)
    {
        // Keep the chain verifiable after trimming: remember the dropped entry's hash.
        l.setProperty (IDs::baseHash, l.getChild (0)[IDs::hash], nullptr);
        l.removeChild (0, nullptr);
    }
}

String SplitTrackerProcessor::genesisHash()
{
    auto l = log();
    if (l.hasProperty (IDs::baseHash))
        return l[IDs::baseHash].toString();
    return SHA256 (("GENESIS|" + song()[IDs::projectId].toString()).toUTF8()).toHexString();
}

String SplitTrackerProcessor::chainHead()
{
    auto l = log();
    return l.getNumChildren() > 0 ? l.getChild (l.getNumChildren() - 1)[IDs::hash].toString()
                                  : genesisHash();
}

String SplitTrackerProcessor::entryHash (const String& prev, const ValueTree& e)
{
    const String payload = prev + "|" + e[IDs::time].toString() + "|" + e[IDs::type].toString() + "|" + e[IDs::text].toString();
    return SHA256 (payload.toUTF8()).toHexString();
}

int SplitTrackerProcessor::verifyLog()
{
    const ScopedLock sl (stateLock);
    auto l = log();
    String prev = genesisHash();
    for (int i = 0; i < l.getNumChildren(); ++i)
    {
        auto e = l.getChild (i);
        if (e[IDs::hash].toString() != entryHash (prev, e))
            return i;
        prev = e[IDs::hash].toString();
    }
    return -1;
}

File SplitTrackerProcessor::receiptFolder()
{
    auto t = song()[IDs::title].toString().trim();
    return File::getSpecialLocation (File::userDocumentsDirectory)
               .getChildFile ("Split Tracker Receipts")
               .getChildFile (File::createLegalFileName (t.isEmpty() ? "Untitled" : t));
}

void SplitTrackerProcessor::writeBounceReceipt()
{
    auto s = song();
    const auto now = Time::currentTimeMillis();
    const auto problem = splitProblem();
    const bool ready = problem.isEmpty() && (bool) s[IDs::splitsConfirmed];
    const double secs = (double) renderSamples.load() / jmax (1.0, currentSampleRate.load());
    const int bad = verifyLog();
    const auto title = s[IDs::title].toString().trim().isEmpty() ? String ("Untitled") : s[IDs::title].toString();
    const int bounceNum = (int) s[IDs::bounceCount];

    // Acoustic fingerprint of this render
    std::vector<uint32> fp;
    double secondsPerFrame = 0.0;
    {
        const SpinLock::ScopedLockType sl (fpLock);
        if (pendingFp.size() > fingerprinter.getFrames().size())
        {
            fp = pendingFp;
            secondsPerFrame = pendingFpSecondsPerFrame;
        }
        else
        {
            fp = fingerprinter.getFrames();
            secondsPerFrame = fingerprinter.getSecondsPerFrame();
        }
        pendingFp.clear();
        renderPending.store (false);
    }
    const auto fpData = AcousticFingerprinter::serialise (fp, secondsPerFrame);
    const auto fpId = SHA256 (fpData).toHexString();

    String h;
    h << "<!doctype html><html><head><meta charset='utf-8'><title>Bounce receipt - " << html (title) << "</title><style>"
         "body{font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#111}"
         "h1{margin-bottom:4px}table{border-collapse:collapse;width:100%;margin:8px 0 18px}"
         "td,th{border:1px solid #ccc;padding:6px;font-size:13px;text-align:left;vertical-align:top}"
         "th{background:#f3f3f3}.ok{color:#08702f;font-weight:bold}.bad{color:#b00020;font-weight:bold}"
         "code{font-size:11px;word-break:break-all}.sig{margin-top:28px}"
         "button{padding:8px 14px;font-size:14px}@media print{button{display:none}}</style></head><body>"
      << "<button onclick='window.print()'>Print / Save as PDF</button>"
      << "<h1>Bounce receipt</h1><div>" << html (title) << " &middot; bounce #" << s[IDs::bounceCount].toString()
      << " &middot; " << formatTime (now) << "</div>"
      << "<p class='" << (ready ? "ok'>Splits CONFIRMED " + formatTime ((int64) s[IDs::confirmedAt])
                                : String ("bad'>Splits NOT confirmed at time of bounce") + (problem.isEmpty() ? String() : ": " + html (problem)))
      << "</p>";

    h << "<table><tr><th>Song</th><td>" << html (title) << "</td><th>ISRC</th><td>" << html (s[IDs::isrc].toString())
      << "</td><th>ISWC</th><td>" << html (s[IDs::iswc].toString()) << "</td></tr>"
      << "<tr><th>Project ID</th><td colspan='5'><code>" << s[IDs::projectId].toString() << "</code></td></tr>"
      << "<tr><th>Bounce started</th><td>" << formatTime (bounceStartMs) << "</td><th>Finished</th><td>" << formatTime (now)
      << "</td><th>Rendered</th><td>" << String (secs, 1) << " s @ " << String (currentSampleRate.load(), 0) << " Hz</td></tr>"
      << "<tr><th>Acoustic fingerprint</th><td colspan='5'><code>" << fpId.substring (0, 32) << "</code><br>"
      << (int) fp.size() << " frames. Matches this song even after MP3/streaming conversion. "
         "Check any file against it on the Evidence tab.</td></tr>"
      << "<tr><th>Render checksum</th><td colspan='3'><code>" << String::toHexString ((int64) renderHash.load())
      << "</code></td><th>Peak</th><td>" << String (Decibels::gainToDecibels (renderPeak.load()), 1) << " dBFS</td></tr>"
      << "<tr><th>Exported file</th><td colspan='5'>Not sealed yet: drop the exported file on the Evidence tab to add its SHA-256 to the log.</td></tr>"
      << "<tr><th>Project file</th><td colspan='5'>"
      << (s[IDs::projectFileSha].toString().isEmpty()
            ? String ("Not signed yet: sign the DAW project on the Evidence tab.")
            : html (s[IDs::projectFileName].toString())
              + (s[IDs::projectFileDaw].toString().isNotEmpty() ? " (" + html (s[IDs::projectFileDaw].toString()) + ")" : String())
              + ", signed " + formatTime ((int64) s[IDs::projectFileTime])
              + "<br><code>" + s[IDs::projectFileSha].toString() + "</code>")
      << "</td></tr>"
      << "<tr><th>Computer</th><td colspan='5'>" << html (SystemStats::getComputerName()) << " (" << html (SystemStats::getOperatingSystemName()) << ")</td></tr>"
      << "<tr><th>Session time</th><td>" << formatDuration ((int64) s[IDs::sessionSeconds]) << "</td><th>Playback</th><td>"
      << formatDuration ((int64) s[IDs::playSeconds]) << "</td><th>Recording</th><td>" << formatDuration ((int64) s[IDs::recordSeconds]) << "</td></tr></table>";

    h << "<h2>Splits at time of bounce</h2><table><tr><th>Artist name</th><th>Legal name</th><th>Role</th><th>Writer/Pub %</th><th>Master %</th>"
         "<th>PRO</th><th>IPI/CAE</th><th>Publisher</th><th>Publisher IPI</th><th>Deal / notes</th><th>Time on project</th></tr>";
    for (auto c : contributors())
        h << "<tr><td>" << html (c[IDs::name].toString()) << ((bool) c[IDs::checkedIn] ? " <b>(in session)</b>" : "")
          << "</td><td>" << html (c[IDs::legalName].toString())
          << "</td><td>" << html (c[IDs::role].toString())
          << "</td><td>" << String ((double) c[IDs::writerShare], 2) << "</td><td>" << String ((double) c[IDs::masterShare], 2)
          << "</td><td>" << html (c[IDs::pro].toString())
          << "</td><td>" << (c[IDs::ipi].toString().isEmpty()
                                 ? String ((double) c[IDs::writerShare] > 0 ? "<span class='bad'>none</span>" : "-")
                                 : html (c[IDs::ipi].toString()))
          << "</td><td>" << html (c[IDs::publisher].toString()) << "</td><td>" << html (c[IDs::publisherIpi].toString())
          << "</td><td>" << html (c[IDs::terms].toString().isEmpty()
                                     && (double) c[IDs::writerShare] <= 0 && (double) c[IDs::masterShare] <= 0
                                     ? String ("Credit only") : c[IDs::terms].toString())
          << "</td><td>" << formatDuration ((int64) c[IDs::seconds]) << "</td></tr>";
    h << "</table>";

    if (tracks().getNumChildren() > 0)
    {
        h << "<h2>Tagged tracks</h2><table><tr><th>Track</th><th>Who's on it</th><th>Played with signal</th><th>Recorded</th><th>Last seen</th></tr>";
        for (auto t : tracks())
            h << "<tr><td>" << html (t[IDs::trackName].toString()) << "</td><td>"
              << (t[IDs::person].toString().isEmpty() ? String ("<span class='bad'>not set</span>") : html (t[IDs::person].toString()))
              << "</td><td>" << formatDuration ((int64) t[IDs::signalSeconds]) << "</td><td>" << formatDuration ((int64) t[IDs::recordSeconds])
              << "</td><td>" << formatTime ((int64) t[IDs::lastSeen]) << "</td></tr>";
        h << "</table>";
    }

    // Stems: each Split Tag fingerprinted its own track during this same bounce.
    struct StemOut { String tagId, track, who, fpId; int frames; double secs; };
    std::vector<StemOut> stems;
    for (auto& [id, rt] : tagRuntime)
    {
        if (rt.stemSeq == rt.stemSeqUsed || rt.stemFpId.isEmpty() || rt.stemEndMs < bounceStartMs - 2000) continue;
        auto t = tracks().getChildWithProperty (IDs::tagId, id);
        stems.push_back ({ id, t[IDs::trackName].toString(), t[IDs::person].toString(), rt.stemFpId, rt.stemFrames, rt.stemSeconds });
        rt.stemSeqUsed = rt.stemSeq;
    }
    if (! stems.empty())
    {
        h << "<h2>Stems in this bounce</h2><table><tr><th>Track</th><th>Who's on it</th><th>Length</th><th>Stem fingerprint</th></tr>";
        for (auto& st : stems)
            h << "<tr><td>" << html (st.track) << "</td><td>" << (st.who.isEmpty() ? String ("<span class='bad'>not set</span>") : html (st.who))
              << "</td><td>" << String (st.secs, 1) << " s</td><td><code>" << st.fpId.substring (0, 32) << "</code></td></tr>";
        h << "</table><p style='font-size:12px;color:#555'>Each stem was fingerprinted on its own track during the same bounce as the master. "
             "A stem fingerprint identifies that stem on its own; it does not detect the stem inside another finished mix.</p>";
    }

    bool anyTakes = false;
    for (auto t : tracks()) anyTakes = anyTakes || t.getChildWithName (IDs::Take).isValid();
    if (anyTakes)
    {
        h << "<h2>Takes</h2><table><tr><th>Track</th><th>Take</th><th>Who</th><th>Recorded</th><th>Length</th><th>Position in song</th></tr>";
        for (auto t : tracks())
            for (auto k : t)
                if (k.hasType (IDs::Take))
                    h << "<tr><td>" << html (t[IDs::trackName].toString()) << "</td><td>" << k[IDs::num].toString() << "</td><td>"
                      << html (k[IDs::person].toString()) << "</td><td>" << formatTime ((int64) k[IDs::time]) << "</td><td>"
                      << formatDuration ((int64) (double) k[IDs::durationSecs]) << "</td><td>" << formatPosition ((double) k[IDs::songPos]) << "</td></tr>";
        h << "</table>";
    }

    if (bounces().getNumChildren() > 0)
    {
        h << "<h2>Earlier bounces of this song</h2><table><tr><th>#</th><th>Time</th><th>Length</th><th>Acoustic fingerprint</th><th>Sealed export file (SHA-256)</th></tr>";
        for (auto b : bounces())
            h << "<tr><td>" << b[IDs::num].toString() << "</td><td>" << formatTime ((int64) b[IDs::time]) << "</td><td>"
              << String ((double) b[IDs::durationSecs], 1) << " s</td><td><code>" << b[IDs::fpId].toString().substring (0, 16)
              << "</code></td><td>" << (b[IDs::fileSha].toString().isEmpty() ? String ("-")
                                         : html (b[IDs::fileName].toString()) + "<br><code>" + b[IDs::fileSha].toString() + "</code>")
              << "</td></tr>";
        h << "</table>";
    }

    h << "<h2>Recent log</h2><table><tr><th>Time</th><th>Type</th><th>Event</th></tr>";
    auto l = log();
    for (int i = jmax (0, l.getNumChildren() - 40); i < l.getNumChildren(); ++i)
    {
        auto e = l.getChild (i);
        h << "<tr><td>" << formatTime ((int64) e[IDs::time]) << "</td><td>" << html (e[IDs::type].toString())
          << "</td><td>" << html (e[IDs::text].toString()) << "</td></tr>";
    }
    h << "</table>";

    h << "<h2>Integrity</h2><p>Log chain: " << (bad < 0 ? String ("<span class='ok'>intact</span>")
                                                        : "<span class='bad'>BROKEN at entry " + String (bad + 1) + "</span>")
      << " (" << l.getNumChildren() << " entries)<br>Log chain head: <code>" << chainHead() << "</code></p>"
      << "<p style='font-size:12px;color:#555'>Each log entry is sealed with a SHA-256 hash of the entry before it. "
         "Keep this receipt: if the project's log is later altered, its chain head will no longer match the one printed here.</p>";

    h << "<div class='sig'>";
    for (auto c : contributors())
        h << "<p>" << html (c[IDs::legalName].toString().isEmpty() ? c[IDs::name].toString()
                                                                     : c[IDs::legalName].toString() + " (" + c[IDs::name].toString() + ")")
          << ": ______________________________ &nbsp; Date: ____________</p>";
    h << "</div></body></html>";

    auto folder = receiptFolder();
    folder.createDirectory();
    const auto baseName = File::createLegalFileName (title + " - bounce " + String (bounceNum)
                                                     + " - " + Time (now).formatted ("%Y-%m-%d %H-%M-%S"));
    auto f = folder.getChildFile (baseName + ".html");
    auto fpFile = folder.getChildFile (baseName + ".fingerprint");
    fpFile.replaceWithData (fpData.getData(), fpData.getSize());

    ValueTree b (IDs::Bounce);
    b.setProperty (IDs::num, bounceNum, nullptr);
    b.setProperty (IDs::time, now, nullptr);
    b.setProperty (IDs::durationSecs, secs, nullptr);
    b.setProperty (IDs::fpId, fpId, nullptr);
    b.setProperty (IDs::frames, (int) fp.size(), nullptr);
    b.setProperty (IDs::fpFile, fpFile.getFullPathName(), nullptr);
    b.setProperty (IDs::checksum, String::toHexString ((int64) renderHash.load()), nullptr);
    b.setProperty (IDs::receiptFile, f.getFullPathName(), nullptr);
    bounces().appendChild (b, nullptr);
    addLog ("FINGER", "Bounce #" + String (bounceNum) + " acoustic fingerprint " + fpId + " (" + String ((int) fp.size()) + " frames)");

    for (auto& st : stems)
    {
        auto dest = folder.getChildFile (baseName + " - stem - " + File::createLegalFileName (st.track.isEmpty() ? String ("track") : st.track) + ".fingerprint");
        LiveLink::stemFile (st.tagId).copyFileTo (dest);
        ValueTree sv (IDs::Stem);
        sv.setProperty (IDs::tagId, st.tagId, nullptr);
        sv.setProperty (IDs::trackName, st.track, nullptr);
        sv.setProperty (IDs::person, st.who, nullptr);
        sv.setProperty (IDs::fpId, st.fpId, nullptr);
        sv.setProperty (IDs::frames, st.frames, nullptr);
        sv.setProperty (IDs::durationSecs, st.secs, nullptr);
        sv.setProperty (IDs::fpFile, dest.getFullPathName(), nullptr);
        b.appendChild (sv, nullptr);
        addLog ("STEM", "Bounce #" + String (bounceNum) + " stem \"" + st.track + "\" (" + (st.who.isEmpty() ? String ("no one set") : st.who)
                + "): fingerprint " + st.fpId + " (" + String (st.secs, 1) + "s)");
    }

    if (f.replaceWithText (h))
    {
        addLog ("RECEIPT", "Saved " + f.getFileName() + " (receipt SHA-256 " + SHA256 (h.toUTF8()).toHexString().substring (0, 16) + ")");
        if ((bool) s[IDs::openReceiptOnBounce])
            f.startAsProcess();
    }
    saveBackup();
}

String SplitTrackerProcessor::splitProblem()
{
    auto cs = contributors();
    if (cs.getNumChildren() == 0)
        return "no contributors added";

    double writer = 0, master = 0;
    for (auto c : cs)
    {
        if (c[IDs::name].toString().trim().isEmpty())
            return "a contributor has no name";
        writer += (double) c[IDs::writerShare];
        master += (double) c[IDs::masterShare];
    }

    StringArray problems;
    if (std::abs (writer - 100.0) > 0.01) problems.add ("publishing/writer splits total " + String (writer, 2) + "% (must be 100%)");
    if (std::abs (master - 100.0) > 0.01) problems.add ("master splits total " + String (master, 2) + "% (must be 100%)");

    // The sheet shows artist names; anyone who owns a share also needs their legal name on file.
    StringArray noLegal;
    for (auto c : cs)
        if (((double) c[IDs::writerShare] > 0 || (double) c[IDs::masterShare] > 0) && c[IDs::legalName].toString().trim().isEmpty())
            noLegal.add (c[IDs::name].toString());
    if (! noLegal.isEmpty()) problems.add ("legal name missing for " + noLegal.joinIntoString (", "));

    // Everyone with a share signs up on the website first and gives their Artist ID, so the split
    // reaches a real account for approval.
    StringArray noId;
    for (auto c : cs)
        if (((double) c[IDs::writerShare] > 0 || (double) c[IDs::masterShare] > 0) && ArtistId::normalise (c[IDs::artistId].toString()).isEmpty())
            noId.add (c[IDs::name].toString());
    if (! noId.isEmpty()) problems.add ("Artist ID missing for " + noId.joinIntoString (", ") + " (they sign up on the website first)");
    return problems.joinIntoString ("; ");
}

StringArray SplitTrackerProcessor::unregisteredContributors()
{
    StringArray names;
    for (auto c : contributors())
        if ((double) c[IDs::writerShare] > 0 && c[IDs::ipi].toString().trim().isEmpty())
            names.add (c[IDs::name].toString());
    return names;
}

void SplitTrackerProcessor::confirmSplits()
{
    const ScopedLock sl (stateLock);
    song().setProperty (IDs::splitsConfirmed, true, nullptr);
    song().setProperty (IDs::confirmedAt, Time::currentTimeMillis(), nullptr);

    StringArray summary;
    for (auto c : contributors())
        summary.add (c[IDs::name].toString() + " W" + String ((double) c[IDs::writerShare], 2)
                     + "% M" + String ((double) c[IDs::masterShare], 2) + "%");
    addLog ("SPLITS", "Splits CONFIRMED: " + summary.joinIntoString (", "));
    requestSyncSoon();
}

void SplitTrackerProcessor::splitsEdited (const String& what)
{
    const ScopedLock sl (stateLock);
    addLog ("SPLITS", what);
    // Edited here since the website's version was last seen: the next sync offers this split to the website.
    song().setProperty (IDs::splitDirty, true, nullptr);
    ++splitEdits;
    requestSyncSoon();
    if ((bool) song()[IDs::splitsConfirmed])
    {
        song().setProperty (IDs::splitsConfirmed, false, nullptr);
        addLog ("SPLITS", "Splits changed after confirmation - must be confirmed again");
    }
}

//==============================================================================
String SplitTrackerProcessor::buildSplitSheetCsv()
{
    auto s = song();
    String out = csvRow ({ "Song", s[IDs::title].toString(), "ISRC", s[IDs::isrc].toString(),
                           "ISWC", s[IDs::iswc].toString(), "Project ID", s[IDs::projectId].toString() });
    out << csvRow ({ "Artist name", "Legal name", "Role", "Writer/Publishing %", "Master %", "PRO", "IPI/CAE",
                     "Publisher", "Publisher IPI", "Deal / notes", "Time on project" });
    for (auto c : contributors())
        out << csvRow ({ c[IDs::name].toString(), c[IDs::legalName].toString(), c[IDs::role].toString(),
                         String ((double) c[IDs::writerShare], 2), String ((double) c[IDs::masterShare], 2),
                         c[IDs::pro].toString(), c[IDs::ipi].toString(),
                         c[IDs::publisher].toString(), c[IDs::publisherIpi].toString(),
                         c[IDs::terms].toString(), formatDuration ((int64) c[IDs::seconds]) });
    out << csvRow ({ "Confirmed", (bool) s[IDs::splitsConfirmed] ? formatTime ((int64) s[IDs::confirmedAt]) : "NO" });
    return out;
}

String SplitTrackerProcessor::buildSplitSheetText()
{
    auto s = song();
    String t;
    t << "SPLIT SHEET\n===========\n"
      << "Song:       " << s[IDs::title].toString() << "\n"
      << "ISRC:       " << s[IDs::isrc].toString() << "\n"
      << "ISWC:       " << s[IDs::iswc].toString() << "\n"
      << "Project ID: " << s[IDs::projectId].toString() << "\n"
      << "Status:     " << (splitsReady() ? "CONFIRMED " + formatTime ((int64) s[IDs::confirmedAt]) : String ("NOT CONFIRMED")) << "\n\n";

    for (auto c : contributors())
    {
        t << c[IDs::name].toString() << " (" << c[IDs::role].toString() << ")\n"
          << "  Legal name: " << c[IDs::legalName].toString() << "\n"
          << "  Writer/publishing: " << String ((double) c[IDs::writerShare], 2) << "%   Master: "
          << String ((double) c[IDs::masterShare], 2) << "%\n"
          << "  PRO: " << c[IDs::pro].toString() << "   IPI/CAE: " << c[IDs::ipi].toString() << "\n"
          << "  Publisher: " << c[IDs::publisher].toString() << "   Publisher IPI: " << c[IDs::publisherIpi].toString() << "\n"
          << (c[IDs::terms].toString().isEmpty() ? String() : "  Deal / notes: " + c[IDs::terms].toString() + "\n")
          << "  Time on project: " << formatDuration ((int64) c[IDs::seconds]) << "\n\n";
    }

    t << "Session time: " << formatDuration ((int64) s[IDs::sessionSeconds])
      << "   Playback: " << formatDuration ((int64) s[IDs::playSeconds])
      << "   Recording: " << formatDuration ((int64) s[IDs::recordSeconds])
      << "   Bounces: " << s[IDs::bounceCount].toString() << "\n\n"
      << "Signatures:\n\n";
    for (auto c : contributors())
        t << c[IDs::name].toString() << ": ______________________  Date: __________\n\n";
    return t;
}

String SplitTrackerProcessor::buildLogCsv()
{
    String out = csvRow ({ "Time", "Type", "Event" });
    for (auto e : log())
        out << csvRow ({ formatTime ((int64) e[IDs::time]), e[IDs::type].toString(), e[IDs::text].toString() });
    return out;
}

File SplitTrackerProcessor::backupFile()
{
    return Config::dataFolder().getChildFile ("Projects")
               .getChildFile (song()[IDs::projectId].toString() + ".xml");
}

void SplitTrackerProcessor::saveBackup()
{
    const ScopedLock sl (stateLock);
    auto f = backupFile();
    f.getParentDirectory().createDirectory();
    if (auto xml = state.createXml())
        xml->writeTo (f);
}

String SplitTrackerProcessor::formatDuration (int64 secs)
{
    return String::formatted ("%dh %02dm %02ds", (int) (secs / 3600), (int) ((secs / 60) % 60), (int) (secs % 60));
}

String SplitTrackerProcessor::formatPosition (double seconds)
{
    const int s = (int) jmax (0.0, seconds);
    return String::formatted ("%d:%02d", s / 60, s % 60);
}

String SplitTrackerProcessor::formatTime (int64 millis)
{
    return Time (millis).formatted ("%Y-%m-%d %H:%M:%S");
}

//==============================================================================
void SplitTrackerProcessor::syncLiveLink()
{
    const auto projectId = song()[IDs::projectId].toString();

    // Announce this song so Split Tags can link to it.
    {
        auto* o = new DynamicObject();
        Array<var> people;
        for (auto c : contributors())
            people.add (c[IDs::name].toString());
        o->setProperty ("projectId", projectId);
        o->setProperty ("title", song()[IDs::title].toString());
        o->setProperty ("people", people);
        o->setProperty ("heartbeat", Time::currentTimeMillis());
        LiveLink::write (LiveLink::masterFile (projectId), var (o));
    }

    auto ts = tracks();
    std::set<String> seen;

    for (auto& v : LiveLink::tagsFor (projectId))
    {
        const auto id = v.getProperty ("tagId", {}).toString();
        if (id.isEmpty()) continue;
        seen.insert (id);

        const auto name = v.getProperty ("trackName", {}).toString();
        const auto who = v.getProperty ("person", {}).toString();
        const auto whoText = who.isEmpty() ? String ("no one set") : who;
        auto& rt = tagRuntime[id];

        auto t = ts.getChildWithProperty (IDs::tagId, id);
        if (! t.isValid())
        {
            t = ValueTree (IDs::Track);
            t.setProperty (IDs::tagId, id, nullptr);
            t.setProperty (IDs::trackName, name, nullptr);
            t.setProperty (IDs::person, who, nullptr);
            ts.appendChild (t, nullptr);
            addLog ("TRACK", "Track tagged: \"" + name + "\" -> " + whoText);
        }
        else
        {
            if (t[IDs::person].toString() != who)
                addLog ("TRACK", "\"" + name + "\": owner changed from "
                        + (t[IDs::person].toString().isEmpty() ? String ("no one") : t[IDs::person].toString()) + " to " + whoText);
            if (t[IDs::trackName].toString() != name)
                addLog ("TRACK", "Track renamed \"" + t[IDs::trackName].toString() + "\" -> \"" + name + "\" (" + whoText + ")");
            if (rt.reportedMissing)
                addLog ("TRACK", "\"" + name + "\" (" + whoText + "): Split Tag back online");
        }

        t.setProperty (IDs::trackName, name, nullptr);
        t.setProperty (IDs::person, who, nullptr);
        t.setProperty (IDs::signalSeconds, (int64) v.getProperty ("signalSeconds", 0), nullptr);
        t.setProperty (IDs::recordSeconds, (int64) v.getProperty ("recordSeconds", 0), nullptr);
        t.setProperty (IDs::lastSeen, Time::currentTimeMillis(), nullptr);

        const bool rec = (bool) v.getProperty ("recording", false) && (bool) v.getProperty ("signal", false);
        if (rec && ! rt.wasRecording)
        {
            rt.recStartMs = Time::currentTimeMillis();
            rt.recStartPos = (double) v.getProperty ("songPos", 0.0);
            addLog ("REC", "\"" + name + "\" (" + whoText + "): recording started at " + formatPosition (rt.recStartPos) + " in the song");
        }
        else if (! rec && rt.wasRecording)
        {
            // Each recording pass is a numbered take on that track.
            const int takeNum = (int) t[IDs::takes] + 1;
            const double secs = (double) (Time::currentTimeMillis() - rt.recStartMs) / 1000.0;
            t.setProperty (IDs::takes, takeNum, nullptr);
            ValueTree take (IDs::Take);
            take.setProperty (IDs::num, takeNum, nullptr);
            take.setProperty (IDs::time, rt.recStartMs, nullptr);
            take.setProperty (IDs::durationSecs, secs, nullptr);
            take.setProperty (IDs::songPos, rt.recStartPos, nullptr);
            take.setProperty (IDs::person, who, nullptr);
            t.appendChild (take, nullptr);
            addLog ("TAKE", "Take " + String (takeNum) + " on \"" + name + "\" (" + whoText + "): "
                    + formatDuration ((int64) secs) + ", from " + formatPosition (rt.recStartPos) + " in the song");
        }

        rt.stemSeq = (int) v.getProperty ("stemSeq", 0);
        rt.stemFpId = v.getProperty ("stemFpId", {}).toString();
        rt.stemFrames = (int) v.getProperty ("stemFrames", 0);
        rt.stemSeconds = (double) v.getProperty ("stemSeconds", 0.0);
        rt.stemEndMs = (int64) v.getProperty ("stemEndMs", 0);

        rt.wasRecording = rec;
        rt.present = true;
        rt.reportedMissing = false;
        rt.missingTicks = 0;
    }

    // Tags that went quiet: removed from the track, or the track was deleted.
    for (auto& [id, rt] : tagRuntime)
    {
        if (seen.count (id) > 0 || ! rt.present) continue;
        if (++rt.missingTicks == 4)
        {
            auto t = ts.getChildWithProperty (IDs::tagId, id);
            const auto who = t[IDs::person].toString();
            addLog ("TRACK", "\"" + t[IDs::trackName].toString() + "\" (" + (who.isEmpty() ? String ("no one set") : who)
                    + "): Split Tag removed, bypassed or track deleted");
            rt.present = false;
            rt.reportedMissing = true;
            rt.wasRecording = false;
        }
    }
}

void SplitTrackerProcessor::checkFile (const File& file, std::function<void (const FileCheck&)> onDone)
{
    struct Ref { int num; String fpPath, fileSha, stem; };
    std::vector<Ref> refs;
    for (auto b : bounces())
    {
        refs.push_back ({ (int) b[IDs::num], b[IDs::fpFile].toString(), b[IDs::fileSha].toString(), {} });
        for (auto st : b)
            if (st.hasType (IDs::Stem))
                refs.push_back ({ (int) b[IDs::num], st[IDs::fpFile].toString(), {},
                                  "\"" + st[IDs::trackName].toString() + "\""
                                  + (st[IDs::person].toString().isEmpty() ? String() : " (" + st[IDs::person].toString() + ")") });
    }

    WeakReference<SplitTrackerProcessor> weak (this);

    pool.addJob ([file, refs, onDone, weak]
    {
        FileCheck r;
        r.file = file;
        r.sha256 = SHA256 (file).toHexString();

        for (auto& ref : refs)
            if (ref.fileSha.isNotEmpty() && ref.fileSha == r.sha256)
            {
                r.identical = true;
                r.bestBounce = ref.num;
            }

        if (! r.identical)
        {
            AudioFormatManager fm;
            fm.registerBasicFormats();
            std::unique_ptr<AudioFormatReader> reader (fm.createReaderFor (file));

            if (reader == nullptr)
            {
                r.report = "Couldn't read this file as audio. SHA-256 recorded anyway.";
            }
            else
            {
                AcousticFingerprinter fpr;
                const double seconds = (double) reader->lengthInSamples / jmax (1.0, reader->sampleRate);
                fpr.prepare (reader->sampleRate, seconds + 5.0);

                AudioBuffer<float> buf ((int) jmax (1u, reader->numChannels), 16384);
                for (int64 pos = 0; pos < reader->lengthInSamples; pos += buf.getNumSamples())
                {
                    const int n = (int) jmin ((int64) buf.getNumSamples(), reader->lengthInSamples - pos);
                    reader->read (&buf, 0, n, pos, true, true);
                    fpr.process (buf.getArrayOfReadPointers(), buf.getNumChannels(), n);
                }

                for (auto& ref : refs)
                {
                    std::vector<uint32> bounceFp;
                    double spf = 0.0;
                    if (! AcousticFingerprinter::deserialise (File (ref.fpPath), bounceFp, spf)) continue;

                    auto m = AcousticFingerprinter::compare (bounceFp, fpr.getFrames(), spf);
                    if (m.isMatch() && m.similarity * m.coverage > r.match.similarity * r.match.coverage)
                    {
                        r.match = m;
                        r.bestBounce = ref.num;
                        r.stem = ref.stem;
                    }
                }
            }
        }

        if (r.identical)
            r.report = "IDENTICAL FILE: this is exactly the sealed export of bounce #" + String (r.bestBounce) + ".";
        else if (r.bestBounce > 0)
        {
            const String stats = String (roundToInt (r.match.similarity * 100)) + "% similar, "
                               + String (roundToInt (r.match.coverage * 100)) + "% of the file matched"
                               + (std::abs (r.match.offsetSeconds) > 0.5 ? ", starts " + String (r.match.offsetSeconds, 1) + " s into the bounce" : String());
            if (r.stem.isNotEmpty())
                r.report = (r.match.isStrong() ? "SAME RECORDING as the stem " : "POSSIBLE MATCH with the stem ") + r.stem
                         + " from bounce #" + String (r.bestBounce) + " of this song (" + stats + ")."
                         + (r.match.isStrong() ? String (" This file is that track on its own.")
                                               : String (" Parts match; listen and compare before relying on it."));
            else
            r.report = r.match.isStrong()
                ? "SAME RECORDING as bounce #" + String (r.bestBounce) + " of this song (" + stats
                  + "). Possibly converted (MP3, AAC, streaming), resampled or volume-changed."
                : "POSSIBLE MATCH with bounce #" + String (r.bestBounce) + " (" + stats
                  + "). Parts match. This could be a heavily degraded copy (phone recording, low-quality rip) "
                    "OR a different song sharing material such as the same beat or sample. Listen and compare before relying on it.";
        }
        else if (r.report.isEmpty())
            r.report = refs.empty() ? "No bounces of this song have been fingerprinted yet."
                                    : "NO MATCH with any bounce of this song.";

        MessageManager::callAsync ([weak, r, onDone]
        {
            if (auto* p = weak.get())
            {
                p->addLog ("CHECK", "Checked " + r.file.getFileName() + " (SHA-256 " + r.sha256 + "): " + r.report);
                if (onDone) onDone (r);
            }
        });
    });
}

void SplitTrackerProcessor::signProjectFile (const File& file, std::function<void (const ProjectSeal&)> onDone, bool automatic)
{
    WeakReference<SplitTrackerProcessor> weak (this);
    ++projectSigning;

    pool.addJob ([file, onDone, weak, automatic]
    {
        ProjectSeal r;
        r.file = file;
        r.daw = Config::dawForProjectFile (file);

        const auto sig = ProjectSignature::compute (file);
        r.sha256 = sig.sha256;
        r.bytes = sig.bytes;
        r.files = sig.files;
        r.ok = sig.ok;

        MessageManager::callAsync ([weak, r, onDone, automatic]
        {
            if (auto* p = weak.get())
            {
                --p->projectSigning;
                // An automatic run that finds the project unchanged since it was last signed adds nothing.
                const bool unchanged = automatic && r.ok && p->song()[IDs::projectFileSha].toString() == r.sha256;
                if (r.ok && ! unchanged)
                {
                    const ScopedLock sl (p->stateLock);
                    auto s = p->song();
                    s.setProperty (IDs::projectFilePath, r.file.getFullPathName(), nullptr);
                    s.setProperty (IDs::projectFileName, r.file.getFileName(), nullptr);
                    s.setProperty (IDs::projectFileSha, r.sha256, nullptr);
                    s.setProperty (IDs::projectFileDaw, r.daw, nullptr);
                    s.setProperty (IDs::projectFileTime, Time::currentTimeMillis(), nullptr);
                    p->addLog ("PROJECT", String (automatic ? "Signed automatically, as last saved: " : "Signed project file ") + r.file.getFileName()
                               + (r.daw.isNotEmpty() ? " (" + r.daw + ")" : String())
                               + ": SHA-256 " + r.sha256 + ", " + String (r.files) + (r.files == 1 ? " file, " : " files, ")
                               + File::descriptionOfSizeInBytes (r.bytes));
                    p->saveBackup();
                }
                if (onDone) onDone (r);
            }
        });
    });
}

void SplitTrackerProcessor::attachFileToBounce (const FileCheck& r)
{
    const ScopedLock sl (stateLock);
    auto b = bounces().getChildWithProperty (IDs::num, r.bestBounce);
    if (! b.isValid()) return;

    b.setProperty (IDs::fileSha, r.sha256, nullptr);
    b.setProperty (IDs::fileName, r.file.getFileName(), nullptr);
    addLog ("FILE", "Sealed " + r.file.getFileName() + " as the official export of bounce #" + String (r.bestBounce)
            + " (SHA-256 " + r.sha256 + ", " + File::descriptionOfSizeInBytes (r.file.getSize()) + ")");
    saveBackup();
}

void SplitTrackerProcessor::getStateInformation (MemoryBlock& dest)
{
    const ScopedLock sl (stateLock);
    if (auto xml = state.createXml())
        copyXmlToBinary (*xml, dest);
}

void SplitTrackerProcessor::setStateInformation (const void* data, int size)
{
    if (auto xml = getXmlFromBinary (data, size))
        if (xml->hasTagName (IDs::SplitTracker))
        {
            const ScopedLock sl (stateLock);
            auto loaded = ValueTree::fromXml (*xml);
            for (auto id : { IDs::Song, IDs::Contributors, IDs::Log, IDs::Machines, IDs::Tracks, IDs::Bounces })
                if (! loaded.getChildWithName (id).isValid())
                    loaded.appendChild (ValueTree (id), nullptr);

            // Checked-in state doesn't survive a reopen: people check in per session.
            for (auto c : loaded.getChildWithName (IDs::Contributors))
                c.setProperty (IDs::checkedIn, false, nullptr);

            state.copyPropertiesAndChildrenFrom (loaded, nullptr);

            // If the DAW last closed this project without saving, the project holds older records than
            // this computer's backup. When the backup's log simply continues the saved one, take the backup.
            const auto backup = readBackup (backupFile());
            if (backup.isValid())
            {
                const auto savedLog = log(), newerLog = backup.getChildWithName (IDs::Log);
                const int savedCount = savedLog.getNumChildren(), newerCount = newerLog.getNumChildren();
                const bool continues = newerCount > savedCount
                    && (savedCount == 0
                        || newerLog.getChild (savedCount - 1)[IDs::hash] == savedLog.getChild (savedCount - 1)[IDs::hash]);
                if (continues)
                {
                    state.copyPropertiesAndChildrenFrom (backup, nullptr);
                    addLog ("RECOVER", "This project was last closed without saving. " + String (newerCount - savedCount)
                            + " log entries and the records made after the last save were restored from this computer's backup.");
                }
            }
        }
}

//==============================================================================
// Backups

ValueTree SplitTrackerProcessor::readBackup (const File& f)
{
    if (auto xml = parseXML (f))
        if (xml->hasTagName (IDs::SplitTracker))
        {
            auto v = ValueTree::fromXml (*xml);
            for (auto id : { IDs::Song, IDs::Contributors, IDs::Log, IDs::Machines, IDs::Tracks, IDs::Bounces })
                if (! v.getChildWithName (id).isValid())
                    v.appendChild (ValueTree (id), nullptr);
            for (auto c : v.getChildWithName (IDs::Contributors))
                c.setProperty (IDs::checkedIn, false, nullptr);
            return v;
        }
    return {};
}

std::vector<SplitTrackerProcessor::BackupInfo> SplitTrackerProcessor::listBackups()
{
    std::vector<BackupInfo> out;
    const auto mine = song()[IDs::projectId].toString();
    for (const auto& entry : RangedDirectoryIterator (backupFile().getParentDirectory(), false, "*.xml"))
    {
        const auto v = readBackup (entry.getFile());
        if (! v.isValid()) continue;
        const auto s = v.getChildWithName (IDs::Song);
        const auto l = v.getChildWithName (IDs::Log);
        BackupInfo b;
        b.file = entry.getFile();
        b.projectId = s[IDs::projectId].toString();
        b.title = s[IDs::title].toString();
        StringArray names;
        for (auto c : v.getChildWithName (IDs::Contributors)) names.add (c[IDs::name].toString());
        b.people = names.joinIntoString (", ");
        b.logEntries = l.getNumChildren();
        b.bounces = v.getChildWithName (IDs::Bounces).getNumChildren();
        b.lastTime = b.logEntries > 0 ? (int64) l.getChild (b.logEntries - 1)[IDs::time] : 0;
        // Only ones worth restoring: another project's records that have people or bounces on them.
        if (b.projectId == mine || (names.isEmpty() && b.bounces == 0)) continue;
        out.push_back (b);
    }
    std::sort (out.begin(), out.end(), [] (const BackupInfo& a, const BackupInfo& b) { return a.lastTime > b.lastTime; });
    if (out.size() > 15) out.resize (15);
    return out;
}

bool SplitTrackerProcessor::restoreFromBackup (const File& f)
{
    const auto backup = readBackup (f);
    if (! backup.isValid()) return false;
    const ScopedLock sl (stateLock);
    const int replaced = log().getNumChildren();
    state.copyPropertiesAndChildrenFrom (backup, nullptr);
    addLog ("RECOVER", "Records restored from this computer's backup by hand (the earlier project was closed without saving). "
            "They replaced a new instance that had " + String (replaced) + " log entries.");
    saveBackup();
    return true;
}

AudioProcessorEditor* SplitTrackerProcessor::createEditor()
{
    return new SplitTrackerEditor (*this);
}

AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new SplitTrackerProcessor();
}

//==============================================================================
// Account link

String SplitTrackerProcessor::linkAccount (const String& server, const String& key)
{
    CloudSync::Account a { server.trim().trimCharactersAtEnd ("/"), key.trim() };
    if (const auto problem = CloudSync::serverProblem (a.server); problem.isNotEmpty()) return problem;
    if (! a.key.startsWith ("stk_")) return "That is not a plugin key. Create one on your Profile page on the website.";
    if (! CloudSync::save (a)) return "Could not save the key on this computer";
    addLog ("ACCOUNT", "Linked to an account on " + URL (a.server).getDomain()
            + ". From now on this project's records (never audio) are uploaded there.");
    return {};
}

void SplitTrackerProcessor::unlinkAccount()
{
    CloudSync::clear();
    lastSyncMessage.clear();
    accountLabel.clear();
    addLog ("ACCOUNT", "Account unlinked. Nothing more is uploaded from this computer.");
}

String SplitTrackerProcessor::syncStatus()
{
    if (syncing.load()) return "Syncing...";
    const ScopedLock sl (stateLock);
    return lastSyncMessage;
}

var SplitTrackerProcessor::buildSyncPayload (std::map<String, File>& files)
{
    const ScopedLock sl (stateLock);
    auto s = song();
    auto* o = new DynamicObject();
    o->setProperty ("schema", 1);
    o->setProperty ("projectId", s[IDs::projectId].toString());
    o->setProperty ("title", s[IDs::title].toString());
    o->setProperty ("splitsConfirmed", (bool) s[IDs::splitsConfirmed]);
    o->setProperty ("sessionSeconds", (int64) s[IDs::sessionSeconds]);
    o->setProperty ("recordSeconds", (int64) s[IDs::recordSeconds]);
    o->setProperty ("playSeconds", (int64) s[IDs::playSeconds]);
    o->setProperty ("confirmedAt", (int64) s[IDs::confirmedAt]);
    o->setProperty ("isrc", s[IDs::isrc].toString());
    o->setProperty ("iswc", s[IDs::iswc].toString());
    // Which song this project feeds, and who owns it, exactly as typed into Song details.
    o->setProperty ("songCode", s[IDs::songCode].toString());
    o->setProperty ("ownerArtistId", s[IDs::ownerArtistId].toString());
    {
        // The split is offered to the website only if it was edited here since the website's version was last seen.
        auto* sp = new DynamicObject();
        sp->setProperty ("dirty", (bool) s[IDs::splitDirty] || (int) s[IDs::siteVersion] == 0);
        sp->setProperty ("baseVersion", (int) s[IDs::siteVersion]);
        sp->setProperty ("force", forceSplit);
        o->setProperty ("split", var (sp));
    }
    Array<var> computers;
    for (auto m : machines())
    {
        auto* mo = new DynamicObject();
        mo->setProperty ("name", m[IDs::computer].toString());
        mo->setProperty ("os", m[IDs::os].toString());
        mo->setProperty ("firstSeen", (int64) m[IDs::firstSeen]);
        mo->setProperty ("lastSeen", (int64) m[IDs::lastSeen]);
        mo->setProperty ("opens", (int) m[IDs::opens]);
        computers.add (var (mo));
    }
    o->setProperty ("machines", computers);

    Array<var> people;
    for (auto c : contributors())
    {
        auto* p = new DynamicObject();
        p->setProperty ("artistName", c[IDs::name].toString());
        p->setProperty ("legalName", c[IDs::legalName].toString());
        p->setProperty ("role", c[IDs::role].toString());
        p->setProperty ("writerShare", (double) c[IDs::writerShare]);
        p->setProperty ("masterShare", (double) c[IDs::masterShare]);
        p->setProperty ("artistId", c[IDs::artistId].toString());
        p->setProperty ("pro", c[IDs::pro].toString());
        p->setProperty ("ipi", c[IDs::ipi].toString());
        p->setProperty ("publisher", c[IDs::publisher].toString());
        p->setProperty ("publisherIpi", c[IDs::publisherIpi].toString());
        p->setProperty ("terms", c[IDs::terms].toString());
        p->setProperty ("seconds", (int64) c[IDs::seconds]);
        people.add (var (p));
    }
    o->setProperty ("contributors", people);

    Array<var> trackList, takeList;
    for (auto t : tracks())
    {
        auto* tr = new DynamicObject();
        tr->setProperty ("trackName", t[IDs::trackName].toString());
        tr->setProperty ("person", t[IDs::person].toString());
        tr->setProperty ("signalSeconds", (int64) t[IDs::signalSeconds]);
        tr->setProperty ("recordSeconds", (int64) t[IDs::recordSeconds]);
        tr->setProperty ("takes", (int) t[IDs::takes]);
        trackList.add (var (tr));

        for (auto k : t)
        {
            if (! k.hasType (IDs::Take)) continue;
            auto* tk = new DynamicObject();
            tk->setProperty ("track", t[IDs::trackName].toString());
            tk->setProperty ("person", k[IDs::person].toString());
            tk->setProperty ("num", (int) k[IDs::num]);
            tk->setProperty ("time", (int64) k[IDs::time]);
            tk->setProperty ("durationSecs", (double) k[IDs::durationSecs]);
            tk->setProperty ("songPos", (double) k[IDs::songPos]);
            takeList.add (var (tk));
        }
    }
    o->setProperty ("tracks", trackList);
    o->setProperty ("takes", takeList);

    Array<var> bounceList;
    for (auto b : bounces())
    {
        auto* bo = new DynamicObject();
        bo->setProperty ("num", (int) b[IDs::num]);
        bo->setProperty ("time", (int64) b[IDs::time]);
        bo->setProperty ("durationSecs", (double) b[IDs::durationSecs]);
        bo->setProperty ("fpId", b[IDs::fpId].toString());
        bo->setProperty ("fileSha", b[IDs::fileSha].toString());
        bo->setProperty ("fileName", b[IDs::fileName].toString());
        files[b[IDs::fpId].toString()] = File (b[IDs::fpFile].toString());

        Array<var> stemList;
        for (auto st : b)
        {
            if (! st.hasType (IDs::Stem)) continue;
            auto* so = new DynamicObject();
            so->setProperty ("trackName", st[IDs::trackName].toString());
            so->setProperty ("person", st[IDs::person].toString());
            so->setProperty ("fpId", st[IDs::fpId].toString());
            stemList.add (var (so));
            files[st[IDs::fpId].toString()] = File (st[IDs::fpFile].toString());
        }
        bo->setProperty ("stems", stemList);
        bounceList.add (var (bo));
    }
    o->setProperty ("bounces", bounceList);

    if (s[IDs::projectFileSha].toString().isNotEmpty())
    {
        auto* pf = new DynamicObject();
        pf->setProperty ("fileName", s[IDs::projectFileName].toString());
        pf->setProperty ("sha", s[IDs::projectFileSha].toString());
        pf->setProperty ("daw", s[IDs::projectFileDaw].toString());
        pf->setProperty ("time", (int64) s[IDs::projectFileTime]);
        o->setProperty ("project", var (pf));
    }

    // The whole log with its hashes, so the server can re-check the chain for itself.
    auto l = log();
    auto* lo = new DynamicObject();
    if (l.hasProperty (IDs::baseHash)) lo->setProperty ("baseHash", l[IDs::baseHash].toString());
    Array<var> entries;
    for (auto e : l)
    {
        auto* eo = new DynamicObject();
        eo->setProperty ("time", (int64) e[IDs::time]);
        eo->setProperty ("type", e[IDs::type].toString());
        eo->setProperty ("text", e[IDs::text].toString());
        eo->setProperty ("hash", e[IDs::hash].toString());
        entries.add (var (eo));
    }
    lo->setProperty ("entries", entries);
    o->setProperty ("log", var (lo));
    return var (o);
}

String SplitTrackerProcessor::tagReminder()
{
    const ScopedLock sl (stateLock);
    auto ts = tracks();
    if (ts.getNumChildren() == 0)
        return "No tracks are tagged. Put Split Tag on every track and choose who performed it.";
    StringArray unnamed;
    for (auto t : ts)
        if (t[IDs::person].toString().trim().isEmpty())
            unnamed.add (t[IDs::trackName].toString().isEmpty() ? String ("(unnamed track)") : t[IDs::trackName].toString());
    if (unnamed.isEmpty()) return {};
    return String (unnamed.size()) + (unnamed.size() == 1 ? " track has" : " tracks have") + " no artist set (" + unnamed.joinIntoString (", ")
         + "). Open Split Tag on " + (unnamed.size() == 1 ? "it" : "each") + " and choose who performed it.";
}

String SplitTrackerProcessor::saveOfflineReceipt (const File& dest)
{
    addLog ("OFFLINE", "Saved an offline receipt (" + dest.getFileName() + ") to be uploaded on the website. "
            "It holds this project's records and fingerprints, never audio.");
    std::map<String, File> files;
    // The split always travels in a receipt; whoever uploads it chooses whether to use it.
    const auto payload = JSON::toString (buildSyncPayload (files), true);

    auto* o = new DynamicObject();
    o->setProperty ("format", "split-tracker-receipt");
    o->setProperty ("version", 1);
    o->setProperty ("madeAt", Time::currentTimeMillis());
    o->setProperty ("madeBy", linkedAccount());
    o->setProperty ("computer", SystemStats::getComputerName());
    o->setProperty ("payloadSha256", SHA256 (payload.toUTF8()).toHexString());
    o->setProperty ("payload", payload);
    auto* prints = new DynamicObject();
    for (const auto& [id, file] : files)
    {
        MemoryBlock data;
        if (id.isNotEmpty() && file.loadFileAsData (data))
            prints->setProperty (Identifier (id), Base64::toBase64 (data.getData(), data.getSize()));
    }
    o->setProperty ("fingerprints", var (prints));

    if (! dest.replaceWithText (JSON::toString (var (o), true)))
        return "Could not write " + dest.getFullPathName();
    return {};
}

void SplitTrackerProcessor::syncNow (std::function<void (bool, const String&)> onDone)
{
    const auto account = CloudSync::load();
    if (! account.linked())  { if (onDone) onDone (false, "Not linked to an account"); return; }
    if (syncing.exchange (true)) { if (onDone) onDone (false, "A sync is already running"); return; }

    auto files = std::make_shared<std::map<String, File>>();
    const auto payload = buildSyncPayload (*files);
    const int editsAtSend = splitEdits;
    forceSplit = false;
    WeakReference<SplitTrackerProcessor> weak (this);

    pool.addJob ([account, payload, files, onDone, weak, editsAtSend]
    {
        const auto r = CloudSync::run (account, payload, *files);
        MessageManager::callAsync ([weak, r, onDone, editsAtSend]
        {
            if (auto* p = weak.get())
            {
                p->syncing.store (false);
                if (r.ok) p->applySite (r.site, editsAtSend);
                {
                    const ScopedLock sl (p->stateLock);
                    p->lastSyncMessage = (r.ok ? r.message : "Sync failed: " + r.message) + " (" + Time::getCurrentTime().formatted ("%H:%M") + ")";
                    if (r.accountName.isNotEmpty()) p->accountLabel = r.accountName + " (" + r.accountId + ")";
                }
                if (r.ok && r.uploaded > 0)
                    p->addLog ("SYNC", "Uploaded to the linked account: " + r.message);
            }
            if (onDone) onDone (r.ok, r.message);
        });
    });
}

//==============================================================================
// Automatic project signing

void SplitTrackerProcessor::findProjectFile()
{
    const auto open = ProjectFinder::openProjects();
    if (open.size() != 1) return;      // none found, or several open and no way to tell which is ours
    const File f (open[0]);
    addLog ("PROJECT", "Found the open project " + f.getFileName() + ". It will be signed automatically at every bounce.");
    signProjectFile (f, {}, true);
}

void SplitTrackerProcessor::finishBounce (int triesLeft)
{
    // Wait (up to 30 s) for the project signature, so it is on this receipt rather than the next one.
    if (projectSigning.load() > 0 && triesLeft > 0)
    {
        WeakReference<SplitTrackerProcessor> weak (this);
        Timer::callAfterDelay (500, [weak, triesLeft] { if (auto* p = weak.get()) p->finishBounce (triesLeft - 1); });
        return;
    }
    const ScopedLock lock (stateLock);
    syncLiveLink();
    writeBounceReceipt();
    resetRender.store (true);
    receiptPending = false;
    if (accountLinked())
        syncNow();      // the new bounce, its stems and takes go to the linked account
}

//==============================================================================
// Accounts and Artist IDs

String SplitTrackerProcessor::linkedAccount()
{
    const ScopedLock sl (stateLock);
    return accountLabel;
}

void SplitTrackerProcessor::refreshLinkedAccount (std::function<void()> onDone)
{
    const auto account = CloudSync::load();
    if (! account.linked()) { if (onDone) onDone(); return; }
    WeakReference<SplitTrackerProcessor> weak (this);
    pool.addJob ([account, weak, onDone]
    {
        const auto me = CloudSync::whoAmI (account);
        MessageManager::callAsync ([weak, me, onDone]
        {
            if (auto* p = weak.get())
            {
                const ScopedLock sl (p->stateLock);
                p->accountLabel = me.ok ? me.artistName + " (" + me.artistId + ")" : String();
                if (! me.ok) p->lastSyncMessage = me.message;
            }
            if (onDone) onDone();
        });
    });
}

void SplitTrackerProcessor::lookupArtist (const String& artistId, std::function<void (const CloudSync::Artist&)> onDone)
{
    const auto id = ArtistId::normalise (artistId);
    if (id.isEmpty())
    {
        CloudSync::Artist bad;
        bad.message = "That is not an Artist ID. It looks like ST-7K2Q-9FXM and is on their Profile page on the website.";
        return onDone (bad);
    }
    const auto account = CloudSync::load();
    pool.addJob ([account, id, onDone]
    {
        const auto found = CloudSync::lookupArtist (account, id);
        MessageManager::callAsync ([found, onDone] { onDone (found); });
    });
}

//==============================================================================
// Two-way sync with the website

void SplitTrackerProcessor::requestSyncSoon()
{
    if (! accountLinked()) return;
    const int mine = ++syncGeneration;
    WeakReference<SplitTrackerProcessor> weak (this);
    // Wait for edits to settle: several quick changes become one upload.
    Timer::callAfterDelay (2500, [weak, mine]
    {
        if (auto* p = weak.get())
            if (p->syncGeneration == mine)
                p->syncNow();
    });
}

/** Replaces the people here with the website's rows. Returns false if they were already the same. */
bool SplitTrackerProcessor::loadSiteRows (const var& rows)
{
    const auto* list = rows.getArray();
    if (list == nullptr) return false;
    auto cs = contributors();

    auto same = [] (const ValueTree& c, const var& r)
    {
        auto eq = [&] (const Identifier& id, const char* key) { return c[id].toString() == r.getProperty (key, {}).toString(); };
        return eq (IDs::name, "artistName") && eq (IDs::legalName, "legalName") && eq (IDs::role, "role")
            && std::abs ((double) c[IDs::writerShare] - (double) r.getProperty ("writerShare", 0.0)) < 0.005
            && std::abs ((double) c[IDs::masterShare] - (double) r.getProperty ("masterShare", 0.0)) < 0.005
            && eq (IDs::artistId, "artistId") && eq (IDs::pro, "pro") && eq (IDs::ipi, "ipi")
            && eq (IDs::publisher, "publisher") && eq (IDs::publisherIpi, "publisherIpi") && eq (IDs::terms, "terms");
    };
    bool identical = cs.getNumChildren() == list->size();
    for (int i = 0; identical && i < list->size(); ++i)
        identical = same (cs.getChild (i), list->getReference (i));
    if (identical) return false;

    // Session time and check-in are facts recorded here; they stay with each person across the reload.
    std::map<String, std::pair<int64, bool>> kept;
    for (auto c : cs)
        kept[c[IDs::name].toString()] = { (int64) c[IDs::seconds], (bool) c[IDs::checkedIn] };

    cs.removeAllChildren (nullptr);
    for (const auto& r : *list)
    {
        ValueTree c (IDs::Contributor);
        const auto name = r.getProperty ("artistName", {}).toString();
        c.setProperty (IDs::name, name, nullptr);
        c.setProperty (IDs::legalName, r.getProperty ("legalName", {}).toString(), nullptr);
        c.setProperty (IDs::role, r.getProperty ("role", {}).toString(), nullptr);
        c.setProperty (IDs::writerShare, (double) r.getProperty ("writerShare", 0.0), nullptr);
        c.setProperty (IDs::masterShare, (double) r.getProperty ("masterShare", 0.0), nullptr);
        c.setProperty (IDs::artistId, r.getProperty ("artistId", {}).toString(), nullptr);
        c.setProperty (IDs::pro, r.getProperty ("pro", {}).toString(), nullptr);
        c.setProperty (IDs::ipi, r.getProperty ("ipi", {}).toString(), nullptr);
        c.setProperty (IDs::publisher, r.getProperty ("publisher", {}).toString(), nullptr);
        c.setProperty (IDs::publisherIpi, r.getProperty ("publisherIpi", {}).toString(), nullptr);
        c.setProperty (IDs::terms, r.getProperty ("terms", {}).toString(), nullptr);
        const auto it = kept.find (name);
        c.setProperty (IDs::seconds, it != kept.end() ? it->second.first : (int64) 0, nullptr);
        c.setProperty (IDs::checkedIn, it != kept.end() && it->second.second, nullptr);
        cs.appendChild (c, nullptr);
    }
    return true;
}

void SplitTrackerProcessor::applySite (const var& site, int editsAtSend)
{
    if (! site.isObject()) return;
    const ScopedLock sl (stateLock);
    auto s = song();
    lastSite = site;
    const auto status = site.getProperty ("status", {}).toString();
    const bool manage = (bool) site.getProperty ("youManage", true);
    s.setProperty (IDs::siteStatus, status, nullptr);
    s.setProperty (IDs::siteOwner, site.getProperty ("ownerName", {}).toString(), nullptr);
    s.setProperty (IDs::siteProjects, (int) site.getProperty ("projects", 1), nullptr);
    s.setProperty (IDs::siteManage, manage, nullptr);
    s.setProperty (IDs::album, site.getProperty ("album", {}).toString(), nullptr);

    // The song's code and its stated owner come back so they show in Song details.
    if (s[IDs::songCode].toString().isEmpty())
        s.setProperty (IDs::songCode, site.getProperty ("songCode", {}).toString(), nullptr);
    if ((bool) site.getProperty ("ownerStated", false))
        s.setProperty (IDs::ownerArtistId, site.getProperty ("ownerArtistId", {}).toString(), nullptr);

    // A project that only feeds the song takes its name from the song.
    const auto siteTitle = site.getProperty ("title", {}).toString();
    if (siteTitle.isNotEmpty() && (! manage || s[IDs::title].toString().isEmpty()) && s[IDs::title].toString() != siteTitle)
    {
        s.setProperty (IDs::title, siteTitle, nullptr);
        addLog ("SONG", "TITLE set to \"" + siteTitle + "\" from the website");
    }

    siteConflict = (bool) site.getProperty ("conflict", false);
    if (siteConflict) return;                       // changed in both places: the user picks one
    if (splitEdits != editsAtSend)                  // edited again while this sync was in flight
        return requestSyncSoon();

    // With no conflict, the website's sheet is now the agreed one: either it is what was just sent,
    // or it is newer, or the sheet is sent or signed there and can no longer be changed from here.
    const bool hadEdits = (bool) s[IDs::splitDirty];
    if (loadSiteRows (site.getProperty ("rows", {})))
        addLog ("SPLITS", "Split loaded from the website (" + status + ", version " + site.getProperty ("splitVersion", 0).toString() + ")"
                + (hadEdits && status != "draft" ? ". The change made here was not applied: the sheet is " + status + " on the website." : String())
                + (hadEdits && ! manage ? ". The change made here was not applied: " + site.getProperty ("ownerName", {}).toString() + " manages this split." : String()));
    s.setProperty (IDs::splitDirty, false, nullptr);
    s.setProperty (IDs::siteVersion, (int) site.getProperty ("splitVersion", 0), nullptr);

    if (status == "signed" && ! (bool) s[IDs::splitsConfirmed])
    {
        s.setProperty (IDs::splitsConfirmed, true, nullptr);
        s.setProperty (IDs::confirmedAt, Time::currentTimeMillis(), nullptr);
        addLog ("SPLITS", "Splits locked: everyone approved the split sheet on the website");
    }
    saveBackup();
}

String SplitTrackerProcessor::siteSummary()
{
    const ScopedLock sl (stateLock);
    auto s = song();
    const auto status = s[IDs::siteStatus].toString();
    if (status.isEmpty()) return {};
    String text = "Website: " + (status == "sent" ? String ("awaiting approval") : status)
                + ", owner " + s[IDs::siteOwner].toString();
    if ((int) s[IDs::siteProjects] > 1) text << ", " << s[IDs::siteProjects].toString() << " projects feed this song";
    if (! (bool) s[IDs::siteManage]) text << ". The split is managed by " << s[IDs::siteOwner].toString() << ".";
    return text;
}

bool SplitTrackerProcessor::splitManagedElsewhere()
{
    const ScopedLock sl (stateLock);
    return song()[IDs::siteStatus].toString().isNotEmpty() && ! (bool) song()[IDs::siteManage];
}

void SplitTrackerProcessor::useWebsiteSplit()
{
    const ScopedLock sl (stateLock);
    if (! lastSite.isObject()) return;
    siteConflict = false;
    if (loadSiteRows (lastSite.getProperty ("rows", {})))
        addLog ("SPLITS", "Split loaded from the website, replacing the version edited here");
    song().setProperty (IDs::splitDirty, false, nullptr);
    song().setProperty (IDs::siteVersion, (int) lastSite.getProperty ("splitVersion", 0), nullptr);
    saveBackup();
}

void SplitTrackerProcessor::sendMySplit()
{
    siteConflict = false;
    forceSplit = true;       // overwrite the website's draft with the version edited here
    syncNow();
}
