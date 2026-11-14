#pragma once
#include <juce_core/juce_core.h>

/** Artist ID: the public code that says "this person has a Split Tracker account", e.g. ST-7K2Q-9FXM.

    An artist reads it off their Profile page on the website and gives it to whoever fills in the
    split sheet. It is safe to share: it cannot sign in or upload. (The plugin key, which can
    upload, is a different thing and stays secret.) The last character is a check character, so a
    mistyped ID is caught here even with no connection.

    web/src/core/artistId.ts implements exactly the same rules. */
namespace ArtistId
{
    inline const juce::String alphabet { "0123456789ABCDEFGHJKMNPQRSTVWXYZ" };   // no I, L, O or U

    inline juce::juce_wchar checkChar (const juce::String& body)
    {
        int sum = 0;
        for (int i = 0; i < body.length(); ++i)
            sum += alphabet.indexOfChar (body[i]) * (i + 1);
        return alphabet[sum % 32];
    }

    /** Adds the check character to 7 body characters: "1234567" -> "ST-1234-567C". */
    inline juce::String withCheck (const juce::String& sevenChars, const juce::String& prefix = "ST")
    {
        const auto eight = sevenChars + juce::String::charToString (checkChar (sevenChars));
        return prefix + "-" + eight.substring (0, 4) + "-" + eight.substring (4);
    }

    /** Tidies what someone typed ("st 7k2q 9fxm", O for 0, I for 1) into PREFIX-7K2Q-9FXM.
        Returns an empty string if it cannot be such a code. */
    inline juce::String normaliseCode (const juce::String& input, const juce::String& prefix)
    {
        auto s = input.toUpperCase().retainCharacters ("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
        if (s.length() == 10 && s.startsWith (prefix)) s = s.substring (2);
        s = s.replaceCharacter ('O', '0').replaceCharacter ('I', '1').replaceCharacter ('L', '1');
        if (s.length() != 8 || ! s.containsOnly (alphabet)) return {};
        return checkChar (s.substring (0, 7)) == s[7] ? withCheck (s.substring (0, 7), prefix) : juce::String();
    }

    /** An Artist ID (ST-...), or an empty string. */
    inline juce::String normalise (const juce::String& input)          { return normaliseCode (input, "ST"); }

    /** A song code (SG-...): the public code of one song on the website. A collaborator working in
        their own separate project types it into Song details, and that project then feeds the same song. */
    inline juce::String normaliseSongCode (const juce::String& input)  { return normaliseCode (input, "SG"); }
}
