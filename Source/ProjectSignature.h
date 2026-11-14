#pragma once
#include <juce_core/juce_core.h>
#include <juce_cryptography/juce_cryptography.h>

/** The signature of a DAW project, used by the plugin and checked by the website's Verify page
    (web/src/core/hash.ts must compute exactly the same thing).

    A project that is one file (.flp, .als, .ptx ...) is signed with the SHA-256 of that file.
    A project that is a package or folder (.logicx, a Cubase or Reaper project folder ...) is signed
    like this: every file inside is hashed, a line "relative/path = hash" is made for each, the
    lines are sorted by plain character order and joined with newlines, and that text is hashed.
    ".DS_Store" files are left out, because Finder rewrites them just by looking at a folder. */
namespace ProjectSignature
{
    struct Result
    {
        juce::String sha256;
        juce::int64 bytes = 0;
        int files = 0;
        bool ok = false;
    };

    inline Result compute (const juce::File& file)
    {
        Result r;
        if (file.existsAsFile())
        {
            r.sha256 = juce::SHA256 (file).toHexString();
            r.bytes = file.getSize();
            r.files = 1;
            r.ok = true;
        }
        else if (file.isDirectory())
        {
            juce::StringArray lines;
            for (const auto& entry : juce::RangedDirectoryIterator (file, true, "*", juce::File::findFiles))
            {
                const auto f = entry.getFile();
                if (f.getFileName() == ".DS_Store") continue;
                lines.add (f.getRelativePathFrom (file).replaceCharacter ('\\', '/') + " = " + juce::SHA256 (f).toHexString());
                r.bytes += f.getSize();
                ++r.files;
            }
            lines.sort (false);
            const auto manifest = lines.joinIntoString ("\n");
            r.sha256 = juce::SHA256 (manifest.toRawUTF8(), manifest.getNumBytesAsUTF8()).toHexString();
            r.ok = r.files > 0;
        }
        return r;
    }
}
