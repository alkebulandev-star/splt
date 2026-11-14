// Renders the plugin windows to PNG files with example people filled in, so the design can be
// checked without a DAW. Built twice: once against Split Tracker, once (TAG_SHOT) against Split Tag.
// Usage: UiShot <output folder>      /      TagShot <output folder>
#include <juce_audio_utils/juce_audio_utils.h>
#include <CoreFoundation/CoreFoundation.h>
#include <map>
#include "../Source/LiveLink.h"
#if ! TAG_SHOT
 #include "../Source/PluginEditor.h"
#endif

using namespace juce;
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter();

static void pump (double seconds) { CFRunLoopRunInMode (kCFRunLoopDefaultMode, seconds, false); }

static void save (Component& c, const File& f)
{
    auto img = c.createComponentSnapshot (c.getLocalBounds(), true, 2.0f);
    f.deleteFile();
    FileOutputStream os (f);
    PNGImageFormat().writeImageToStream (img, os);
    std::printf ("wrote %s\n", f.getFullPathName().toRawUTF8());
}

static void clickButton (Component& root, const String& text)
{
    for (auto* child : root.getChildren())
    {
        if (auto* b = dynamic_cast<TextButton*> (child))
            if (b->getButtonText() == text && b->onClick) { b->onClick(); return; }
        clickButton (*child, text);
    }
}

#if ! TAG_SHOT
/** Drives the real plugin processor through a list of actions and prints its state as one JSON line.
    Used by web/tests/integration/plugin-sync.ts to test the two-way sync against a live server.
      UiShot --sync <state file> [action ...]
    The state file is the plugin's saved state, loaded at the start and written at the end, so a
    series of runs behaves like one project being closed and reopened. */
static int runSync (int argc, char** argv)
{
    ScopedJuceInitialiser_GUI gui;
    const File stateFile (String::fromUTF8 (argv[2]));
    std::unique_ptr<AudioProcessor> ap (createPluginFilter());
    auto* p = dynamic_cast<SplitTrackerProcessor*> (ap.get());
    p->prepareToPlay (44100.0, 512);
    MemoryBlock saved;
    if (stateFile.loadFileAsData (saved)) p->setStateInformation (saved.getData(), (int) saved.getSize());
    pump (2.4);

    auto syncAndWait = [&]
    {
        bool done = false;
        p->syncNow ([&] (bool, const String&) { done = true; });
        for (int i = 0; i < 150 && ! done; ++i) pump (0.1);
        pump (0.3);
    };

    for (int i = 3; i < argc; ++i)
    {
        const auto a = String::fromUTF8 (argv[i]);
        const auto value = a.fromFirstOccurrenceOf ("=", false, false);
        if (a.startsWith ("title="))       p->song().setProperty (IDs::title, value, nullptr);
        else if (a.startsWith ("owner="))  p->song().setProperty (IDs::ownerArtistId, value, nullptr);
        else if (a.startsWith ("code="))   p->song().setProperty (IDs::songCode, value, nullptr);
        else if (a.startsWith ("isrc="))   p->song().setProperty (IDs::isrc, value, nullptr);
        else if (a.startsWith ("add="))
        {
            // add=Artist name|Legal name|writer|master|Artist ID|deal notes
            const auto f = StringArray::fromTokens (value, "|", "");
            ValueTree c (IDs::Contributor);
            c.setProperty (IDs::name, f[0], nullptr);
            c.setProperty (IDs::legalName, f[1], nullptr);
            c.setProperty (IDs::role, "Artist", nullptr);
            c.setProperty (IDs::writerShare, f[2].getDoubleValue(), nullptr);
            c.setProperty (IDs::masterShare, f[3].getDoubleValue(), nullptr);
            c.setProperty (IDs::artistId, f[4], nullptr);
            c.setProperty (IDs::terms, f[5], nullptr);
            c.setProperty (IDs::seconds, 0, nullptr);
            p->contributors().appendChild (c, nullptr);
            p->splitsEdited ("Added " + f[0]);
        }
        else if (a.startsWith ("writer="))
        {
            // writer=<row>:<share>
            p->contributors().getChild (value.upToFirstOccurrenceOf (":", false, false).getIntValue())
                .setProperty (IDs::writerShare, value.fromFirstOccurrenceOf (":", false, false).getDoubleValue(), nullptr);
            p->splitsEdited ("Changed a writer share");
        }
        else if (a == "lock")         p->confirmSplits();
        else if (a.startsWith ("receipt=")) { const auto e = p->saveOfflineReceipt (File (value)); if (e.isNotEmpty()) std::fprintf (stderr, "%s\n", e.toRawUTF8()); }
        else if (a == "use-website")  p->useWebsiteSplit();
        else if (a == "send-mine")    { p->sendMySplit(); for (int k = 0; k < 40; ++k) pump (0.1); }
        else if (a == "sync")         syncAndWait();
        else if (a.startsWith ("wait=")) pump (value.getDoubleValue());
    }

    auto* o = new DynamicObject();
    auto s = p->song();
    o->setProperty ("title", s[IDs::title].toString());
    o->setProperty ("songCode", s[IDs::songCode].toString());
    o->setProperty ("owner", s[IDs::ownerArtistId].toString());
    o->setProperty ("status", s[IDs::siteStatus].toString());
    o->setProperty ("version", (int) s[IDs::siteVersion]);
    o->setProperty ("dirty", (bool) s[IDs::splitDirty]);
    o->setProperty ("locked", (bool) s[IDs::splitsConfirmed]);
    o->setProperty ("conflict", p->hasSiteConflict());
    o->setProperty ("managedElsewhere", p->splitManagedElsewhere());
    o->setProperty ("summary", p->siteSummary());
    o->setProperty ("message", p->syncStatus());
    o->setProperty ("account", p->linkedAccount());
    Array<var> people;
    for (auto c : p->contributors())
        people.add (Array<var> { c[IDs::name].toString(), (double) c[IDs::writerShare], c[IDs::legalName].toString(), c[IDs::artistId].toString(), c[IDs::terms].toString(), c[IDs::ipi].toString() });
    o->setProperty ("people", people);
    std::printf ("%s\n", JSON::toString (var (o), true).toRawUTF8());

    MemoryBlock out;
    p->getStateInformation (out);
    stateFile.replaceWithData (out.getData(), out.getSize());
    p->releaseResources();
    ap.reset();
    pump (0.3);
    return 0;
}
#endif

int main (int argc, char** argv)
{
   #if ! TAG_SHOT
    if (argc >= 3 && String (argv[1]) == "--sync") return runSync (argc, argv);
   #endif
    if (argc < 2) { std::printf ("usage: %s <output folder>\n", argv[0]); return 2; }
    ScopedJuceInitialiser_GUI gui;
    const File out { String (CharPointer_UTF8 (argv[1])) };
    out.createDirectory();

    const StringArray names { "Nova Kane", "Lil Vanta", "DJ Halcyon", "Riko Santos" };

   #if TAG_SHOT
    // A pretend master so the tag has a song and people to show.
    auto* o = new DynamicObject();
    o->setProperty ("projectId", "uishotdemo");
    o->setProperty ("title", "Night Signal");
    o->setProperty ("people", var (Array<var> { names[0], names[1], names[2], names[3] }));
    o->setProperty ("heartbeat", Time::currentTimeMillis());
    const auto fake = LiveLink::masterFile ("uishotdemo");
    LiveLink::write (fake, var (o));

    std::unique_ptr<AudioProcessor> p (createPluginFilter());
    p->prepareToPlay (44100.0, 512);

    // Point the tag at the demo song through its saved state, as a reopened project would.
    auto setState = [&] (const String& person)
    {
        ValueTree v ("TrackTag");
        v.setProperty ("masterId", "uishotdemo", nullptr);
        v.setProperty ("person", person, nullptr);
        v.setProperty ("manualTrackName", "Lead Vocal", nullptr);
        v.setProperty ("signalSeconds", 3100, nullptr);
        v.setProperty ("recordSeconds", 1900, nullptr);
        MemoryBlock mb;
        if (auto xml = v.createXml()) AudioProcessor::copyXmlToBinary (*xml, mb);
        p->setStateInformation (mb.getData(), (int) mb.getSize());
    };

    setState ({});
    pump (1.5);
    std::unique_ptr<AudioProcessorEditor> ed (p->createEditor());
    pump (1.5);
    save (*ed, out.getChildFile ("tag-1-linked.png"));
    setState (names[0]);
    pump (1.5);
    save (*ed, out.getChildFile ("tag-2-person-picked.png"));
    ed.reset();
    p.reset();
    fake.deleteFile();
   #else
    std::unique_ptr<AudioProcessor> ap (createPluginFilter());
    auto* p = dynamic_cast<SplitTrackerProcessor*> (ap.get());
    p->prepareToPlay (44100.0, 512);
    pump (1.5);

    auto shot = [&] (const String& file, const String& tab = {})
    {
        std::unique_ptr<AudioProcessorEditor> ed (p->createEditor());
        if (tab.isNotEmpty()) clickButton (*ed, tab);
        pump (0.8);
        save (*ed, out.getChildFile (file));
    };

    shot ("1-splits-empty.png");

    auto add = [&] (const String& name, const String& role, double w, double m, const String& ipi, const String& terms)
    {
        ValueTree c (IDs::Contributor);
        const std::map<String, String> legal { { "Nova Kane", "Naomi Kane-Ellis" }, { "Lil Vanta", "Devon Marsh" },
                                               { "DJ Halcyon", "Hal Okafor" }, { "Riko Santos", "Ricardo Santos" }, { "Mara Voss", "Mara Voss" } };
        c.setProperty (IDs::legalName, legal.count (name) ? legal.at (name) : String(), nullptr);
        // Everyone in the demo has signed up: a valid Artist ID made from their name.
        c.setProperty (IDs::artistId, ArtistId::withCheck (name.toUpperCase().retainCharacters ("ABCDEFGHJKMNPQRSTVWXYZ").paddedRight ('0', 7).substring (0, 7)), nullptr);
        c.setProperty (IDs::name, name, nullptr);     c.setProperty (IDs::role, role, nullptr);
        c.setProperty (IDs::writerShare, w, nullptr); c.setProperty (IDs::masterShare, m, nullptr);
        c.setProperty (IDs::pro, "ASCAP", nullptr);   c.setProperty (IDs::ipi, ipi, nullptr);
        c.setProperty (IDs::terms, terms, nullptr);   c.setProperty (IDs::checkedIn, false, nullptr);
        c.setProperty (IDs::seconds, 0, nullptr);
        p->contributors().appendChild (c, nullptr);
    };
    p->song().setProperty (IDs::title, "Night Signal", nullptr);
    add (names[0], "Artist", 40, 50, "00123456789", {});
    add (names[1], "Producer", 30, 30, "00987654321", "3 points");
    add (names[2], "Songwriter", 20, 0, "00555111222", {});
    shot ("2-splits-incomplete.png");

    add (names[3], "Featured Artist", 10, 20, {}, {});
    add ("Mara Voss", "A&R", 0, 0, {}, {});
    const int secs[] = { 22800, 14700, 9000, 2700, 0 };
    for (int i = 0; i < 5; ++i) p->contributors().getChild (i).setProperty (IDs::seconds, secs[i], nullptr);
    p->contributors().getChild (0).setProperty (IDs::checkedIn, true, nullptr);
    p->song().setProperty (IDs::sessionSeconds, 27300, nullptr);
    p->song().setProperty (IDs::playSeconds, 9120, nullptr);
    p->song().setProperty (IDs::recordSeconds, 3340, nullptr);
    for (auto [track, who, played, rec] : { std::tuple { "Lead Vocal", names[0], 3100, 1900 }, std::tuple { "808 + Drums", names[1], 5200, 0 },
                                             std::tuple { "Hook Stack", names[3], 1400, 760 } })
    {
        ValueTree t (IDs::Track);
        t.setProperty (IDs::tagId, Uuid().toString(), nullptr); t.setProperty (IDs::trackName, track, nullptr);
        t.setProperty (IDs::person, who, nullptr);              t.setProperty (IDs::signalSeconds, played, nullptr);
        t.setProperty (IDs::recordSeconds, rec, nullptr);
        p->tracks().appendChild (t, nullptr);
    }
    shot ("3-splits-ready-to-lock.png");
    shot ("8-add-person-form.png", "+ Add person");
    {
        // Someone added without an Artist ID blocks the lock until they sign up.
        auto extra = p->contributors().getChild (0).createCopy();
        extra.setProperty (IDs::name, "Mara Voss", nullptr);
        extra.setProperty (IDs::artistId, "", nullptr);
        const double w = (double) p->contributors().getChild (0)[IDs::writerShare];
        p->contributors().getChild (0).setProperty (IDs::writerShare, w - 5.0, nullptr);
        extra.setProperty (IDs::writerShare, 5.0, nullptr);
        extra.setProperty (IDs::masterShare, 0.0, nullptr);
        p->contributors().appendChild (extra, nullptr);
        std::printf ("%s  lock is refused while someone has no Artist ID  [%s]\n", p->splitProblem().contains ("Artist ID missing for Mara Voss") ? "PASS" : "FAIL", p->splitProblem().toRawUTF8());
        shot ("9-not-signed-up.png");
        p->contributors().removeChild (extra, nullptr);
        p->contributors().getChild (0).setProperty (IDs::writerShare, w, nullptr);
        std::printf ("%s  lock is allowed once everyone has an Artist ID\n", p->splitProblem().isEmpty() ? "PASS" : "FAIL");
    }
    shot ("4-session.png", "Session");
    shot ("5-evidence.png", "Evidence");

    p->confirmSplits();
    shot ("6-splits-locked.png");

    // Project-file signature: a folder signed twice must give the same signature; changing a file must change it.
    {
        auto proj = File::getSpecialLocation (File::tempDirectory).getChildFile ("UiShot Demo.logicx");
        proj.deleteRecursively();
        proj.getChildFile ("Alternatives/000").createDirectory();
        proj.getChildFile ("Alternatives/000/ProjectData").replaceWithText ("demo project data");
        proj.getChildFile ("Resources/ProjectInformation.plist").create();
        proj.getChildFile ("Resources/ProjectInformation.plist").replaceWithText ("<plist/>");
        String a, b, c;
        p->signProjectFile (proj, [&] (const SplitTrackerProcessor::ProjectSeal& r) { a = r.sha256; });  pump (1.0);
        p->signProjectFile (proj, [&] (const SplitTrackerProcessor::ProjectSeal& r) { b = r.sha256; });  pump (1.0);
        proj.getChildFile ("Alternatives/000/ProjectData").replaceWithText ("demo project data, edited");
        p->signProjectFile (proj, [&] (const SplitTrackerProcessor::ProjectSeal& r) { c = r.sha256; });  pump (1.0);
        std::printf ("%s  project signature is repeatable  [%s]\n", a.isNotEmpty() && a == b ? "PASS" : "FAIL", a.substring (0, 16).toRawUTF8());
        std::printf ("%s  project signature changes when the project changes\n", c.isNotEmpty() && c != a ? "PASS" : "FAIL");
        std::printf ("%s  DAW recognised  [%s]\n", Config::dawForProjectFile (proj) == "Logic Pro" ? "PASS" : "FAIL", Config::dawForProjectFile (proj).toRawUTF8());
        proj.deleteRecursively();
    }
    shot ("7-log.png", "Log");

    const auto backup = File::getSpecialLocation (File::userApplicationDataDirectory)
                            .getChildFile ("Application Support/TBA/SplitTracker/Projects")
                            .getChildFile (p->song()[IDs::projectId].toString() + ".xml");
    ap.reset();
    backup.deleteFile();   // this demo project is not a real one
   #endif
    return 0;
}
