// Small checks of the plugin's own code, used by the tests:
//   FindProject --id <text>                       tidies an Artist ID (prints nothing if it is not one)
//   FindProject --whoami <server> <key>           which account a plugin key belongs to
//   FindProject --artist <server> <key> <id>      looks someone up by Artist ID, as the Add person form does
// and two about DAW projects:
//   FindProject           prints the project(s) the plugin can see open right now. With exactly one,
//                         the plugin signs it by itself; with none or several it waits for the user.
//   FindProject <path>    prints the signature the plugin gives that project file or folder.
#include <juce_core/juce_core.h>
#include "../Source/ProjectFinder.h"
#include "../Source/ProjectSignature.h"
#include "../Source/ArtistId.h"
#include "../Source/CloudSync.h"
#include <cstdio>

int main (int argc, char** argv)
{
    const juce::StringArray args (argv + 1, argc - 1);
    if (args[0] == "--id") { std::printf ("%s\n", ArtistId::normalise (args[1]).toRawUTF8()); return 0; }
    if (args[0] == "--whoami" || args[0] == "--artist")
    {
        const CloudSync::Account account { args[1], args[2] };
        const auto a = args[0] == "--whoami" ? CloudSync::whoAmI (account) : CloudSync::lookupArtist (account, ArtistId::normalise (args[3]));
        if (! a.ok) { std::printf ("ERROR %s\n", a.message.toRawUTF8()); return 1; }
        std::printf ("%s|%s|%s|%s\n", a.artistId.toRawUTF8(), a.artistName.toRawUTF8(), a.legalName.toRawUTF8(), a.pro.toRawUTF8());
        return 0;
    }
    if (argc > 1)
    {
        const auto r = ProjectSignature::compute (juce::File (juce::String (juce::CharPointer_UTF8 (argv[1]))));
        if (! r.ok) { std::printf ("could not read that project\n"); return 1; }
        std::printf ("%s %d %lld\n", r.sha256.toRawUTF8(), r.files, (long long) r.bytes);
        return 0;
    }
    const auto found = ProjectFinder::openProjects();
    if (found.isEmpty()) std::printf ("No open DAW project found.\n");
    for (const auto& p : found)
        std::printf ("%s  (%s)\n", p.toRawUTF8(), Config::dawForProjectFile (juce::File (p)).toRawUTF8());
    return 0;
}
