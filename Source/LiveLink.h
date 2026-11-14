#pragma once
#include <juce_core/juce_core.h>
#include "Config.h"

/** Master <-> Split Tag link through small JSON status files in a local folder.
    Works when the DAW runs plugins in separate processes (Logic, FL Studio
    bridging) and needs no network sockets. Nothing leaves the computer. */
namespace LiveLink
{
    constexpr juce::int64 staleMs = 6000;

    inline juce::File folder()
    {
        // Tests point this somewhere private so they never mix with a real session on the same computer.
        const auto custom = juce::SystemStats::getEnvironmentVariable ("SPLIT_TRACKER_LIVE_DIR", {});
        if (custom.isNotEmpty())
            return juce::File (custom);

        return Config::dataFolder().getChildFile ("Live");
    }

    inline juce::File masterFile (const juce::String& projectId) { return folder().getChildFile ("master-" + projectId + ".json"); }
    inline juce::File tagFile (const juce::String& tagId)        { return folder().getChildFile ("tag-" + tagId + ".json"); }

    /** Each tag's latest stem fingerprint (written when a bounce ends, collected by the master). */
    inline juce::File stemFile (const juce::String& tagId)       { return folder().getChildFile ("stem-" + tagId + ".fingerprint"); }

    inline void write (const juce::File& f, const juce::var& v)
    {
        f.getParentDirectory().createDirectory();
        juce::TemporaryFile tmp (f);
        if (tmp.getFile().replaceWithText (juce::JSON::toString (v, true)))
            tmp.overwriteTargetFileWithTemporary();
    }

    inline juce::var read (const juce::File& f)
    {
        return juce::JSON::parse (f.loadFileAsString());
    }

    inline bool isFresh (const juce::var& v)
    {
        return juce::Time::currentTimeMillis() - (juce::int64) v.getProperty ("heartbeat", 0) < staleMs;
    }

    struct MasterInfo
    {
        juce::String projectId, title;
        juce::StringArray people;
    };

    inline juce::Array<MasterInfo> activeMasters()
    {
        juce::Array<MasterInfo> out;
        for (auto& f : folder().findChildFiles (juce::File::findFiles, false, "master-*.json"))
        {
            auto v = read (f);
            if (! isFresh (v)) continue;

            MasterInfo m;
            m.projectId = v.getProperty ("projectId", {}).toString();
            m.title = v.getProperty ("title", {}).toString();
            if (auto* arr = v.getProperty ("people", {}).getArray())
                for (auto& p : *arr) m.people.add (p.toString());
            if (m.projectId.isNotEmpty()) out.add (m);
        }
        return out;
    }

    inline juce::Array<juce::var> tagsFor (const juce::String& projectId)
    {
        juce::Array<juce::var> out;
        for (auto& f : folder().findChildFiles (juce::File::findFiles, false, "tag-*.json"))
        {
            auto v = read (f);
            if (isFresh (v) && v.getProperty ("masterId", {}).toString() == projectId)
                out.add (v);
        }
        return out;
    }
}
