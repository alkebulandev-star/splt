#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include "Config.h"
#include "Fingerprint.h"
#include "LiveLink.h"
#include <map>
#include <vector>
#include <set>
#include "ArtistId.h"
#include "CloudSync.h"
#include "ProjectFinder.h"
#include "ProjectSignature.h"

/** Master-bus plugin: passes audio through untouched, tracks session time,
    keeps a session log, holds the split sheet and flags bounces when the
    splits are not yet confirmed. All ValueTree access happens on the message
    thread (timer + UI); the audio thread only writes atomics. */
class SplitTrackerProcessor : public juce::AudioProcessor, private juce::Timer
{
public:
    SplitTrackerProcessor();
    ~SplitTrackerProcessor() override;

    void prepareToPlay (double sr, int) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout&) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override                       { return true; }
    const juce::String getName() const override           { return JucePlugin_Name; }
    bool acceptsMidi() const override                     { return false; }
    bool producesMidi() const override                    { return false; }
    bool isMidiEffect() const override                    { return false; }
    double getTailLengthSeconds() const override          { return 0.0; }
    int getNumPrograms() override                         { return 1; }
    int getCurrentProgram() override                      { return 0; }
    void setCurrentProgram (int) override                 {}
    const juce::String getProgramName (int) override      { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock&) override;
    void setStateInformation (const void*, int) override;

    //==============================================================================
    juce::ValueTree state;
    juce::ValueTree song()         { return state.getChildWithName (IDs::Song); }
    juce::ValueTree contributors() { return state.getChildWithName (IDs::Contributors); }
    juce::ValueTree log()          { return state.getChildWithName (IDs::Log); }
    juce::ValueTree machines()     { return state.getChildWithName (IDs::Machines); }
    juce::ValueTree tracks()       { return state.getChildWithName (IDs::Tracks); }
    juce::ValueTree bounces()      { return state.getChildWithName (IDs::Bounces); }

    /** Checks an audio file (an export, or a song found "out there") against
        every bounce of this song: exact SHA-256 and acoustic fingerprint.
        Runs in the background; onDone is called on the message thread. */
    struct FileCheck
    {
        juce::File file;
        juce::String sha256, report;
        juce::String stem;             // set when the best match is one track's stem, not the master
        int bestBounce = 0;            // 0 = no match
        bool identical = false;
        AcousticFingerprinter::Match match;
    };
    void checkFile (const juce::File&, std::function<void (const FileCheck&)> onDone);
    void attachFileToBounce (const FileCheck&);

    /** Signature of the DAW project itself (Logic, FL Studio, Ableton, Pro Tools...).
        A single file is hashed directly; a project package or folder is hashed file by
        file in name order, so the same project always gives the same signature. */
    struct ProjectSeal
    {
        juce::File file;
        juce::String sha256, daw;
        juce::int64 bytes = 0;
        int files = 0;
        bool ok = false;
    };
    /** The file is remembered, and from then on signed again by itself at every bounce.
        `automatic` runs stay silent unless the signature changed. */
    void signProjectFile (const juce::File&, std::function<void (const ProjectSeal&)> onDone, bool automatic = false);
    /** The remembered project file, or an empty string. */
    juce::String projectFilePath()                 { return song()[IDs::projectFilePath].toString(); }

    //==============================================================================
    /** Account link: uploads this project's records (never audio) to the web server. */
    bool accountLinked() const                     { return CloudSync::load().linked(); }
    /** Saves the server address and plugin key. Returns what is wrong with them, or an empty string. */
    juce::String linkAccount (const juce::String& server, const juce::String& key);
    void unlinkAccount();
    /** Uploads in the background; onDone is called on the message thread. */
    void syncNow (std::function<void (bool ok, const juce::String& message)> onDone = {});
    juce::String syncStatus();
    /** A reminder when tracks are not tagged properly: no Split Tag on any track, or a tag with no
        artist chosen. Empty when every tagged track names its artist. */
    juce::String tagReminder();
    /** For when the website cannot be reached: writes one file holding what a sync would send plus the
        fingerprints (never audio). It is sent to the song's owner, who uploads it on the website.
        Returns what went wrong, or an empty string. */
    juce::String saveOfflineReceipt (const juce::File& dest);
    /** "Nova Kane (ST-7K2Q-9FXM)" once the server has told us; empty until then. */
    juce::String linkedAccount();
    /** Asks the server which account this computer is linked to; onDone runs on the message thread. */
    void refreshLinkedAccount (std::function<void()> onDone = {});
    /** Looks someone up by their Artist ID so they can be added to the split sheet. */
    void lookupArtist (const juce::String& artistId, std::function<void (const CloudSync::Artist&)> onDone);

    //==============================================================================
    /** The website's side of the song, as of the last sync. */
    juce::String siteSummary();
    /** True when someone else manages the split: this project feeds the song but cannot change it. */
    bool splitManagedElsewhere();
    /** True when the split was changed both here and on the website since they last agreed. */
    bool hasSiteConflict() const                   { return siteConflict; }
    void useWebsiteSplit();
    void sendMySplit();
    /** Uploads shortly, once edits have settled (splits, lock, song details). */
    void requestSyncSoon();

    void addLog (const juce::String& type, const juce::String& text);

    /** Returns empty string when splits are complete, otherwise the problem. */
    juce::String splitProblem();
    juce::StringArray unregisteredContributors();
    bool splitsReady()             { return splitProblem().isEmpty() && (bool) song()[IDs::splitsConfirmed]; }
    void confirmSplits();
    void splitsEdited (const juce::String& what);

    bool isBouncing() const        { return wasBouncing; }
    bool isPlaying() const         { return audioPlaying.load(); }
    bool isRecording() const       { return audioRecording.load(); }
    /** Loudest sample since the last call (for the level line in the window). */
    float takeLivePeak()           { return livePeak.exchange (0.0f); }

    juce::String buildSplitSheetCsv();
    juce::String buildSplitSheetText();
    juce::String buildLogCsv();
    juce::File backupFile();

    /** Records kept on this computer for projects that had Split Tracker on them. They are written
        every 30 seconds, so they survive a DAW that quits without saving the project. */
    struct BackupInfo
    {
        juce::File file;
        juce::String projectId, title, people;
        int logEntries = 0, bounces = 0;
        juce::int64 lastTime = 0;
    };
    std::vector<BackupInfo> listBackups();
    /** Replaces this instance's records with a backup's (its project ID, splits, log and bounces). */
    bool restoreFromBackup (const juce::File&);
    juce::File receiptFolder();

    /** Tamper evidence: every log entry stores SHA-256(previous hash + entry).
        Returns -1 when the chain is intact, else the index of the first bad entry. */
    int verifyLog();
    juce::String chainHead();

    static juce::String formatDuration (juce::int64 seconds);
    static juce::String formatTime (juce::int64 millis);
    static juce::String formatPosition (double seconds);

    std::function<void()> onBounceStarted;   // editor hook (message thread)

private:
    void timerCallback() override;
    void registerMachine();
    void saveBackup();
    static juce::ValueTree createEmptyState();
    static juce::String entryHash (const juce::String& prev, const juce::ValueTree& e);
    juce::String genesisHash();
    void writeBounceReceipt();
    void syncLiveLink();

    juce::CriticalSection stateLock;

    AcousticFingerprinter fingerprinter;
    juce::SpinLock fpLock;
    // Hosts (Logic) re-prepare the plugin when a bounce ends, before the receipt is written:
    // the finished render's fingerprint is parked here so prepareToPlay can't wipe it.
    std::vector<juce::uint32> pendingFp;
    double pendingFpSecondsPerFrame = 0.0;
    std::atomic<bool> renderPending { false };
    juce::ThreadPool pool { 1 };

    struct TagRuntime
    {
        bool present = false, wasRecording = false, reportedMissing = false;
        int missingTicks = 0;
        juce::int64 recStartMs = 0;
        double recStartPos = 0.0;
        // Latest stem fingerprint this tag reported, and the last one already put on a receipt.
        int stemSeq = 0, stemSeqUsed = 0, stemFrames = 0;
        juce::String stemFpId;
        double stemSeconds = 0.0;
        juce::int64 stemEndMs = 0;
    };
    bool receiptPending = false;

    juce::var buildSyncPayload (std::map<juce::String, juce::File>& files);
    void finishBounce (int triesLeft);
    static juce::ValueTree readBackup (const juce::File&);
    void findProjectFile();
    std::atomic<int> projectSigning { 0 };
    juce::String lastSyncMessage, accountLabel;
    void applySite (const juce::var& site, int editsAtSend);
    bool loadSiteRows (const juce::var& rows);
    juce::var lastSite;
    bool siteConflict = false, forceSplit = false;
    int splitEdits = 0, syncGeneration = 0;
    std::atomic<bool> syncing { false };
    std::map<juce::String, TagRuntime> tagRuntime;

    // Offline-render fingerprint (FNV-1a over the exact samples passing through).
    // Written by the audio thread only; read by the message thread.
    std::atomic<juce::uint64> renderHash { 0 };
    std::atomic<juce::int64> renderSamples { 0 };
    std::atomic<float> renderPeak { 0.0f };
    std::atomic<bool> resetRender { true };
    std::atomic<double> currentSampleRate { 44100.0 };
    bool audioThreadOffline = false;
    juce::int64 bounceStartMs = 0;
    std::atomic<bool> audioPlaying { false }, audioRecording { false }, offlineRender { false };
    std::atomic<juce::uint32> lastProcessMs { 0 };
    std::atomic<float> livePeak { 0.0f };

    bool wasBouncing = false, sessionStarted = false;
    int ticks = 0;
    juce::uint32 sessionOpenedMs = 0;

    JUCE_DECLARE_WEAK_REFERENCEABLE (SplitTrackerProcessor)
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SplitTrackerProcessor)
};
