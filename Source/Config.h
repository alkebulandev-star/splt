#pragma once
#include <juce_core/juce_core.h>
#include <utility>

namespace Config
{
    // TODO: replace with the real URL of the registration platform.
    inline const juce::String registrationUrl = "https://example.com/register";
    inline const juce::String registrationName = "our registration service";

    // Everyone who can be on a record. The box is editable, so any other role can be typed in.
    // People who are credited but take no share (e.g. an engineer on a flat fee) stay at 0% / 0%.
    inline const juce::StringArray roles {
        "Artist", "Featured Artist", "Group / Band Member",
        "Songwriter", "Lyricist", "Composer", "Topliner", "Arranger",
        "Producer", "Co-Producer", "Additional Producer", "Beatmaker", "Vocal Producer", "Executive Producer",
        "Session Musician", "Background Vocalist",
        "Recording Engineer", "Mixing Engineer", "Mastering Engineer",
        "A&R", "Manager", "Record Label", "Publisher", "Sample / Interpolation Owner",
        "Other" };

    /** Project files of the desktop DAWs, so any of them can be signed the same way.
        Some of these are single files, some are packages or folders; both are handled. */
    inline juce::String dawForProjectFile (const juce::File& f)
    {
        static const std::pair<const char*, const char*> types[] = {
            { ".logicx", "Logic Pro" }, { ".logic", "Logic Pro" }, { ".band", "GarageBand" },
            { ".flp", "FL Studio" }, { ".als", "Ableton Live" },
            { ".ptx", "Pro Tools" }, { ".ptf", "Pro Tools" }, { ".pts", "Pro Tools" },
            { ".cpr", "Cubase" }, { ".npr", "Nuendo" }, { ".song", "Studio One" },
            { ".rpp", "Reaper" }, { ".bwproject", "Bitwig Studio" },
            { ".reason", "Reason" }, { ".rns", "Reason" },
            { ".cwp", "Cakewalk" }, { ".cwb", "Cakewalk" },
            { ".dpdoc", "Digital Performer" }, { ".luna", "LUNA" },
            { ".tracktionedit", "Waveform" }, { ".w54", "Waveform" },
            { ".ardour", "Ardour / Mixbus" }, { ".sesx", "Adobe Audition" },
            { ".vip", "Samplitude" }, { ".mmpz", "LMMS" }, { ".mmp", "LMMS" },
            { ".xrns", "Renoise" }, { ".mxprj", "Maschine" }, { ".xpj", "MPC" },
            { ".ssp", "Serato Studio" }, { ".acd", "ACID Pro" }, { ".mx9", "Mixcraft" }, { ".mx10", "Mixcraft" },
        };
        const auto ext = f.getFileExtension().toLowerCase();
        for (const auto& [e, name] : types)
            if (ext == e) return name;
        return {};
    }

    /** Where the plugins keep their own files (live link, project backups, the account key).
        macOS: ~/Library/Application Support/TBA/SplitTracker.  Windows: %APPDATA%\\TBA\\SplitTracker.
        Linux: ~/.config/TBA/SplitTracker. */
    inline juce::File dataFolder()
    {
        const auto base = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory);
       #if JUCE_MAC
        return base.getChildFile ("Application Support/TBA/SplitTracker");
       #else
        return base.getChildFile ("TBA/SplitTracker");
       #endif
    }

    // TODO: replace with the real address of the web server once it is online.
    inline const juce::String serverUrl = "http://localhost:4173";

    constexpr int maxLogEntries = 5000;
    constexpr int backupEverySeconds = 30;
}

namespace IDs
{
   #define DECLARE_ID(n) inline const juce::Identifier n { #n };
    DECLARE_ID (SplitTracker) DECLARE_ID (Song) DECLARE_ID (Contributors) DECLARE_ID (Contributor)
    DECLARE_ID (Log) DECLARE_ID (Entry) DECLARE_ID (Machines) DECLARE_ID (Machine)
    DECLARE_ID (title) DECLARE_ID (isrc) DECLARE_ID (iswc) DECLARE_ID (projectId)
    DECLARE_ID (splitsConfirmed) DECLARE_ID (confirmedAt) DECLARE_ID (popupOnBounce)
    DECLARE_ID (sessionSeconds) DECLARE_ID (playSeconds) DECLARE_ID (recordSeconds) DECLARE_ID (bounceCount)
    DECLARE_ID (name) DECLARE_ID (role) DECLARE_ID (writerShare) DECLARE_ID (masterShare)
    DECLARE_ID (pro) DECLARE_ID (ipi) DECLARE_ID (publisher) DECLARE_ID (publisherIpi)
    DECLARE_ID (checkedIn) DECLARE_ID (seconds) DECLARE_ID (terms)
    DECLARE_ID (time) DECLARE_ID (type) DECLARE_ID (text)
    DECLARE_ID (hash) DECLARE_ID (baseHash) DECLARE_ID (openReceiptOnBounce)
    DECLARE_ID (Tracks) DECLARE_ID (Track) DECLARE_ID (tagId) DECLARE_ID (trackName) DECLARE_ID (person)
    DECLARE_ID (signalSeconds) DECLARE_ID (Bounces) DECLARE_ID (Bounce) DECLARE_ID (num) DECLARE_ID (fpFile)
    DECLARE_ID (fpId) DECLARE_ID (frames) DECLARE_ID (fileSha) DECLARE_ID (fileName) DECLARE_ID (durationSecs)
    DECLARE_ID (checksum) DECLARE_ID (receiptFile)
    DECLARE_ID (Take) DECLARE_ID (Stem) DECLARE_ID (takes) DECLARE_ID (songPos) DECLARE_ID (legalName)
    DECLARE_ID (projectFileName) DECLARE_ID (projectFileSha) DECLARE_ID (projectFileTime) DECLARE_ID (projectFileDaw) DECLARE_ID (projectFilePath) DECLARE_ID (artistId) DECLARE_ID (songCode) DECLARE_ID (ownerArtistId)
    DECLARE_ID (siteVersion) DECLARE_ID (splitDirty) DECLARE_ID (siteStatus) DECLARE_ID (siteOwner) DECLARE_ID (siteProjects) DECLARE_ID (siteManage) DECLARE_ID (album)
    DECLARE_ID (id) DECLARE_ID (computer) DECLARE_ID (os) DECLARE_ID (firstSeen) DECLARE_ID (lastSeen) DECLARE_ID (opens)
   #undef DECLARE_ID
}
